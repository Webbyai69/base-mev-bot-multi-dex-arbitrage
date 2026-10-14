/**
 * Opportunity history: a compact, searchable index over data/opportunities.jsonl.
 *
 * The file holds two kinds of lines (src/paper.ts): `opportunity` records and,
 * a block or two later, the matching `outcome` (persisted | taken | closed).
 * It grows to hundreds of MB, so it is never loaded whole. The index streams it
 * once in 4 MB chunks (yielding to the event loop between chunks), keeps a few
 * typed-array columns per opportunity (~50 bytes, see memoryBytes()), and
 * re-reads full records by byte offset only for the page of rows a query
 * returns.
 *
 * New lines are picked up incrementally: on every store.onAppend for the file
 * and at the start of every query (so a dashboard-only process, where nothing
 * appends in-process, still sees what the bot writes). A truncated or replaced
 * file triggers a rebuild.
 *
 * Ordering is newest first by default. Results carry `asOf` (the number of
 * opportunities the query saw); pass it back to pin paging to that snapshot,
 * so offsets stay stable while new records arrive. (Status can still change
 * inside the snapshot when an outcome lands, so a `status` filter may move a
 * row between pages; everything else is fixed.)
 *
 * No ethers import; read-only on the data file.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import type { Store } from "./store.js";

export const HISTORY_FILE = "opportunities.jsonl";

export type OppKind = "classic" | "cl" | "triangular";
export type OppStatus = "pending" | "persisted" | "taken" | "closed";

export interface HistoryQuery {
  /** ISO time, or a UTC day "YYYY-MM-DD" (inclusive), or epoch ms. Day = UTC date of foundAt. */
  from?: string | number;
  to?: string | number;
  /** pairSymbols as recorded ("WETH/USDC", "WETH>USDC>AERO>WETH"); case-insensitive exact match. */
  pair?: string;
  /** Any leg on this dex id. */
  dex?: string;
  kind?: OppKind;
  status?: OppStatus;
  /** local | quoter-ok | quoter-mismatch | executor-ok | executor-revert */
  sim?: string;
  minNetUsd?: number;
  /** Page size (default 50, max 500). */
  limit?: number;
  offset?: number;
  /** "desc" (newest first, default) or "asc". */
  order?: "asc" | "desc";
  /** Snapshot size returned by an earlier query; pins paging. */
  asOf?: number;
}

export interface HistoryResult {
  total: number;
  asOf: number;
  /** True while the first pass over the file is still running (totals are partial). */
  building: boolean;
  rows: Array<Record<string, unknown>>;
}

/** Same resolvers the dashboard has (UiSources.token / symbol / pool). */
export interface HistoryResolvers {
  token?: ((address: string) => { symbol: string; decimals: number } | undefined) | undefined;
  symbol?: ((address: string) => string) | undefined;
  pool?: ((address: string) => { feePpm: number } | undefined) | undefined;
}

export interface HistoryOptions extends HistoryResolvers {
  file?: string;
  /** Read chunk size (bytes). */
  chunkBytes?: number;
}

const KINDS: OppKind[] = ["classic", "cl", "triangular"];
const STATUSES: OppStatus[] = ["pending", "persisted", "taken", "closed"];
const MAX_LIMIT = 500;
const OTHER = 255;

export class OpportunityIndex {
  readonly file: string;
  private readonly chunkBytes: number;
  private cap = 0;
  private n = 0;
  // Columns (one entry per opportunity, file order).
  private off = new Float64Array(0);
  private len = new Uint32Array(0);
  private ts = new Uint32Array(0);
  private blk = new Uint32Array(0);
  private net = new Float32Array(0);
  private pairId = new Uint32Array(0);
  private dexMask = new Uint32Array(0);
  private kind = new Uint8Array(0);
  private sim = new Uint8Array(0);
  private status = new Uint8Array(0);
  private outOff = new Float64Array(0);
  private outLen = new Uint32Array(0);
  // Dictionaries.
  private pairs: string[] = [];
  private pairIds = new Map<string, number>();
  private dexes: string[] = [];
  private dexIds = new Map<string, number>();
  private sims: string[] = [];
  private simIds = new Map<string, number>();
  /** Rows whose dex id is >= 32 (doesn't fit the mask): row -> dex ids. */
  private dexOverflow = new Map<number, number[]>();
  /** Opportunities still waiting for their outcome line: id -> row. */
  private awaiting = new Map<string, number>();
  private maxBlock = 0;

  private scannedTo = 0;
  private fileIdentity = "";
  private building = false;
  private unsubscribe?: () => void;
  /** Resolves when the first full pass is done. */
  ready: Promise<void> = Promise.resolve();

  constructor(
    readonly store: Store,
    private readonly opts: HistoryOptions = {},
  ) {
    this.file = opts.file ?? HISTORY_FILE;
    this.chunkBytes = opts.chunkBytes ?? 4 * 1024 * 1024;
  }

  /** Stream the file once, then follow appends. Safe to call once; returns `ready`. */
  start(): Promise<void> {
    if (!this.unsubscribe) {
      this.unsubscribe = this.store.onAppend((name) => {
        if (name === this.file) this.catchUp();
      });
    }
    this.ready = this.build();
    return this.ready;
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  get count(): number {
    return this.n;
  }

  get isBuilding(): boolean {
    return this.building;
  }

  // ---------------------------------------------------------------------------
  // Ingest
  // ---------------------------------------------------------------------------

  private async build(): Promise<void> {
    this.reset();
    this.building = true;
    try {
      while (this.pump(1)) await new Promise<void>((r) => setImmediate(r));
    } finally {
      this.building = false;
    }
    this.catchUp();
  }

  /** Index whatever has been appended since the last read (synchronous; a few lines normally). */
  catchUp(): void {
    if (this.building) return;
    const path = this.store.path(this.file);
    if (!existsSync(path)) return;
    const st = statSync(path);
    const ident = `${st.dev}:${st.ino}`;
    if (this.fileIdentity && (ident !== this.fileIdentity || st.size < this.scannedTo)) {
      // Rotated or truncated: start over.
      this.ready = this.build();
      return;
    }
    while (this.pump(Infinity)) {
      /* keep reading */
    }
  }

  /**
   * Read up to `maxChunks` chunks from scannedTo and index the complete lines.
   * Returns true if there may be more to read.
   */
  private pump(maxChunks: number): boolean {
    const path = this.store.path(this.file);
    if (!existsSync(path)) return false;
    const fd = openSync(path, "r");
    try {
      const st = fstatSync(fd);
      this.fileIdentity = `${st.dev}:${st.ino}`;
      let chunks = 0;
      while (this.scannedTo < st.size && chunks < maxChunks) {
        const want = Math.min(this.chunkBytes, st.size - this.scannedTo);
        let buf: Buffer = Buffer.allocUnsafe(want);
        const got = readSync(fd, buf, 0, want, this.scannedTo);
        if (got <= 0) return false;
        if (got < want) buf = buf.subarray(0, got);
        let lastNl = buf.lastIndexOf(10);
        if (lastNl < 0) {
          // A single line longer than the chunk (or a torn tail): read it whole if it is complete.
          const whole = this.readLineAt(fd, this.scannedTo, st.size);
          if (!whole) return false;
          buf = whole;
          lastNl = whole.length - 1;
        }
        this.ingestBuffer(buf, lastNl + 1, this.scannedTo);
        this.scannedTo += lastNl + 1;
        chunks++;
      }
      return this.scannedTo < st.size;
    } finally {
      closeSync(fd);
    }
  }

  /** The full line starting at `pos` (with its newline), or null if it isn't complete yet. */
  private readLineAt(fd: number, pos: number, size: number): Buffer | null {
    const parts: Buffer[] = [];
    let at = pos;
    while (at < size) {
      const b = Buffer.allocUnsafe(Math.min(this.chunkBytes, size - at));
      const got = readSync(fd, b, 0, b.length, at);
      if (got <= 0) break;
      const nl = b.subarray(0, got).indexOf(10);
      if (nl >= 0) {
        parts.push(b.subarray(0, nl + 1));
        return Buffer.concat(parts);
      }
      parts.push(b.subarray(0, got));
      at += got;
    }
    return null;
  }

  private ingestBuffer(buf: Buffer, end: number, base: number): void {
    let start = 0;
    while (start < end) {
      let nl = buf.indexOf(10, start);
      if (nl < 0 || nl >= end) nl = end - 1;
      const lineLen = nl - start; // without the newline
      if (lineLen > 0) {
        let rec: Record<string, unknown> | undefined;
        try {
          rec = JSON.parse(buf.toString("utf8", start, nl)) as Record<string, unknown>;
        } catch {
          rec = undefined; // torn line from an interrupted write
        }
        if (rec) this.ingest(rec, base + start, lineLen);
      }
      start = nl + 1;
    }
  }

  private ingest(r: Record<string, unknown>, offset: number, length: number): void {
    if (r.kind === "opportunity") this.addOpportunity(r, offset, length);
    else if (r.kind === "outcome") {
      const id = String(r.id);
      const row = this.awaiting.get(id);
      if (row === undefined) return;
      this.awaiting.delete(id);
      const s = STATUSES.indexOf(r.status as OppStatus);
      this.status[row] = s > 0 ? s : 0;
      this.outOff[row] = offset;
      this.outLen[row] = length;
    }
  }

  private addOpportunity(r: Record<string, unknown>, offset: number, length: number): void {
    if (this.n === this.cap) this.grow();
    const i = this.n++;
    this.off[i] = offset;
    this.len[i] = length;
    const t = Date.parse(String(r.foundAt ?? ""));
    this.ts[i] = Number.isFinite(t) ? Math.floor(t / 1000) : 0;
    const block = Number(r.block ?? 0);
    this.blk[i] = block > 0 && block < 2 ** 32 ? block : 0;
    if (block > this.maxBlock) this.maxBlock = block;
    const net = Number(r.netUsd);
    this.net[i] = Number.isFinite(net) ? net : 0;
    this.pairId[i] = intern(this.pairs, this.pairIds, String(r.pairSymbols ?? ""));
    const route = r.route as { dexes?: string[]; pools?: string[] } | undefined;
    const hops = Number(r.hops ?? route?.pools?.length ?? 2);
    this.kind[i] = !route ? 0 : hops >= 3 ? 2 : 1;
    const simId = intern(this.sims, this.simIds, String(r.sim ?? ""));
    this.sim[i] = simId < OTHER ? simId : OTHER;
    this.status[i] = 0;
    this.outOff[i] = -1;
    this.outLen[i] = 0;
    let mask = 0;
    let extra: number[] | undefined;
    const dexes = route?.dexes ?? [r.buyDex, r.sellDex];
    for (const d of dexes) {
      if (d === undefined || d === null) continue;
      const id = intern(this.dexes, this.dexIds, String(d));
      if (id < 32) mask |= 1 << id;
      else (extra ??= []).push(id);
    }
    this.dexMask[i] = mask >>> 0;
    if (extra) this.dexOverflow.set(i, extra);
    this.awaiting.set(String(r.id), i);
    if (this.awaiting.size > 20_000) this.pruneAwaiting();
  }

  /** Outcomes land within a couple of blocks; forget ids that never got one (bot restarted mid-check). */
  private pruneAwaiting(): void {
    const keepAfter = this.maxBlock - 5_000;
    for (const [id, row] of this.awaiting) if (this.blk[row]! < keepAfter) this.awaiting.delete(id);
  }

  private grow(): void {
    const cap = Math.max(1024, Math.ceil(this.cap * 1.5));
    const g = <T extends Float64Array | Float32Array | Uint32Array | Uint8Array>(a: T, C: new (n: number) => T): T => {
      const b = new C(cap);
      b.set(a);
      return b;
    };
    this.off = g(this.off, Float64Array);
    this.len = g(this.len, Uint32Array);
    this.ts = g(this.ts, Uint32Array);
    this.blk = g(this.blk, Uint32Array);
    this.net = g(this.net, Float32Array);
    this.pairId = g(this.pairId, Uint32Array);
    this.dexMask = g(this.dexMask, Uint32Array);
    this.kind = g(this.kind, Uint8Array);
    this.sim = g(this.sim, Uint8Array);
    this.status = g(this.status, Uint8Array);
    this.outOff = g(this.outOff, Float64Array);
    this.outLen = g(this.outLen, Uint32Array);
    this.cap = cap;
  }

  private reset(): void {
    this.n = 0;
    this.cap = 0;
    this.off = new Float64Array(0);
    this.len = new Uint32Array(0);
    this.ts = new Uint32Array(0);
    this.blk = new Uint32Array(0);
    this.net = new Float32Array(0);
    this.pairId = new Uint32Array(0);
    this.dexMask = new Uint32Array(0);
    this.kind = new Uint8Array(0);
    this.sim = new Uint8Array(0);
    this.status = new Uint8Array(0);
    this.outOff = new Float64Array(0);
    this.outLen = new Uint32Array(0);
    this.pairs = [];
    this.pairIds.clear();
    this.dexes = [];
    this.dexIds.clear();
    this.sims = [];
    this.simIds.clear();
    this.dexOverflow.clear();
    this.awaiting.clear();
    this.maxBlock = 0;
    this.scannedTo = 0;
    this.fileIdentity = "";
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  query(q: HistoryQuery = {}): HistoryResult {
    this.catchUp();
    const asOf = Math.max(0, Math.min(q.asOf ?? this.n, this.n));
    const limit = Math.max(0, Math.min(MAX_LIMIT, Math.floor(q.limit ?? 50)));
    const offset = Math.max(0, Math.floor(q.offset ?? 0));
    const match = this.matcher(q);
    const page: number[] = [];
    let total = 0;
    if (match) {
      const desc = q.order !== "asc";
      for (let k = 0; k < asOf; k++) {
        const i = desc ? asOf - 1 - k : k;
        if (!match(i)) continue;
        if (total >= offset && page.length < limit) page.push(i);
        total++;
      }
    }
    return { total, asOf, building: this.building, rows: this.load(page) };
  }

  /** Row predicate for a query, or null when it can match nothing (unknown pair, dex or sim). */
  private matcher(q: HistoryQuery): ((i: number) => boolean) | null {
    const from = q.from !== undefined ? toSeconds(q.from, false) : undefined;
    const to = q.to !== undefined ? toSeconds(q.to, true) : undefined;
    let pairSet: Set<number> | undefined;
    if (q.pair) {
      const want = q.pair.toLowerCase();
      pairSet = new Set();
      this.pairs.forEach((p, id) => {
        if (p.toLowerCase() === want) pairSet!.add(id);
      });
      if (!pairSet.size) return null;
    }
    let dexId: number | undefined;
    if (q.dex) {
      dexId = this.dexIds.get(q.dex);
      if (dexId === undefined) return null;
    }
    let simId: number | undefined;
    if (q.sim) {
      simId = this.simIds.get(q.sim);
      if (simId === undefined) return null;
      if (simId >= OTHER) simId = OTHER;
    }
    const kind = q.kind ? KINDS.indexOf(q.kind) : -1;
    if (q.kind && kind < 0) return null;
    const status = q.status ? STATUSES.indexOf(q.status) : -1;
    if (q.status && status < 0) return null;
    const minNet = q.minNetUsd;
    const { ts, net, pairId, dexMask, sim, status: st, kind: kd, dexOverflow } = this;
    return (i) => {
      if (from !== undefined && ts[i]! < from) return false;
      if (to !== undefined && ts[i]! > to) return false;
      if (minNet !== undefined && !(net[i]! >= Math.fround(minNet))) return false;
      if (kind >= 0 && kd[i] !== kind) return false;
      if (status >= 0 && st[i] !== status) return false;
      if (simId !== undefined && sim[i] !== simId) return false;
      if (pairSet && !pairSet.has(pairId[i]!)) return false;
      if (dexId !== undefined) {
        if (dexId < 32) {
          if (!(dexMask[i]! & (1 << dexId))) return false;
        } else if (!dexOverflow.get(i)?.includes(dexId)) return false;
      }
      return true;
    };
  }

  /** Re-read and slim the full records for a page of rows. */
  private load(rows: number[]): Array<Record<string, unknown>> {
    if (!rows.length) return [];
    const path = this.store.path(this.file);
    if (!existsSync(path)) return [];
    const fd = openSync(path, "r");
    try {
      const read = (off: number, len: number): Record<string, unknown> | null => {
        const b = Buffer.allocUnsafe(len);
        const got = readSync(fd, b, 0, len, off);
        try {
          return JSON.parse(b.toString("utf8", 0, got)) as Record<string, unknown>;
        } catch {
          return null;
        }
      };
      const out: Array<Record<string, unknown>> = [];
      for (const i of rows) {
        const r = read(this.off[i]!, this.len[i]!);
        if (!r) continue;
        const o = this.outOff[i]! >= 0 ? read(this.outOff[i]!, this.outLen[i]!) : null;
        out.push({ ...slimHistoryOpp(r, this.opts), status: STATUSES[this.status[i]!], outcome: o ? slimHistoryOutcome(o) : null });
      }
      return out;
    } finally {
      closeSync(fd);
    }
  }

  /** Distinct values seen so far, for filter drop-downs. */
  facets(): { pairs: string[]; dexes: string[]; sims: string[]; kinds: OppKind[]; statuses: OppStatus[] } {
    return { pairs: [...this.pairs].sort(), dexes: [...this.dexes].sort(), sims: [...this.sims], kinds: KINDS, statuses: STATUSES };
  }

  /**
   * Approximate bytes held by the index: column capacity plus dictionaries and
   * the awaiting-outcome map (V8 string ~ 2 bytes/char + 24 header; Map entry ~ 40).
   */
  memoryBytes(): number {
    const cols = [this.off, this.len, this.ts, this.blk, this.net, this.pairId, this.dexMask, this.kind, this.sim, this.status, this.outOff, this.outLen];
    let bytes = cols.reduce((s, a) => s + a.byteLength, 0);
    for (const d of [this.pairs, this.dexes, this.sims]) for (const s of d) bytes += 2 * (24 + s.length * 2) + 40;
    for (const id of this.awaiting.keys()) bytes += 24 + id.length * 2 + 40;
    for (const v of this.dexOverflow.values()) bytes += 40 + v.length * 8;
    return bytes;
  }

  stats(): { opportunities: number; awaitingOutcome: number; scannedBytes: number; building: boolean; bytesPerOpportunity: number } {
    return {
      opportunities: this.n,
      awaitingOutcome: this.awaiting.size,
      scannedBytes: this.scannedTo,
      building: this.building,
      bytesPerOpportunity: this.n ? Math.round(this.memoryBytes() / this.n) : 0,
    };
  }
}

function intern(list: string[], ids: Map<string, number>, v: string): number {
  let id = ids.get(v);
  if (id === undefined) {
    id = list.length;
    list.push(v);
    ids.set(v, id);
  }
  return id;
}

/** "YYYY-MM-DD" = that UTC day (start for `from`, end for `to`); other strings via Date.parse; numbers are epoch ms. */
export function toSeconds(v: string | number, end: boolean): number {
  if (typeof v === "number") return Math.floor(v / 1000);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const start = Date.parse(`${v}T00:00:00Z`) / 1000;
    return end ? start + 86_399 : start;
  }
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return end ? Number.MAX_SAFE_INTEGER : 0;
  return Math.floor(t / 1000);
}

/**
 * The dashboard's row shape (mirrors UiServer.slimOpp in src/ui/server.ts: no
 * bigints, legs with token symbols) plus sizeCurve. Kept separate so this
 * file doesn't touch src/ui/; if slimOpp changes, change this too.
 */
export function slimHistoryOpp(r: Record<string, unknown>, res: HistoryResolvers = {}): Record<string, unknown> {
  const route = r.route as { dexes?: string[]; pools?: string[]; tokens?: string[]; amounts?: unknown[]; executorHops?: Array<{ feePpm?: number }> } | undefined;
  const hops = Number(r.hops ?? route?.pools?.length ?? 2);
  return {
    id: r.id,
    block: r.block,
    foundAt: r.foundAt,
    pair: r.pairSymbols,
    via: route?.dexes ?? [r.buyDex, r.sellDex],
    kind: !route ? "classic" : hops >= 3 ? "triangular" : "cl",
    hops,
    netUsd: r.netUsd,
    profitUsd: r.profitUsd,
    gasUsd: r.gasUsd,
    sim: r.sim,
    simDetail: typeof r.simDetail === "string" ? r.simDetail.slice(0, 200) : null,
    stage: r.stage ?? "block",
    msIntoBlock: r.msIntoBlock ?? null,
    mode: r.mode ?? null,
    legs: legs(r, route, res),
    tokenIn: { address: String(r.tokenIn ?? ""), symbol: String(r.tokenInSymbol ?? "") },
    amountIn: r.amountIn === undefined ? null : String(r.amountIn),
    sizeCurve: Array.isArray(r.sizeCurve) ? r.sizeCurve : null,
  };
}

function legs(
  r: Record<string, unknown>,
  route: { dexes?: string[]; pools?: string[]; tokens?: string[]; amounts?: unknown[]; executorHops?: Array<{ feePpm?: number }> } | undefined,
  res: HistoryResolvers,
): Array<Record<string, unknown>> {
  const tok = (a: unknown) => {
    const address = String(a ?? "");
    const t = res.token?.(address);
    return { address, symbol: t?.symbol ?? res.symbol?.(address) ?? address.slice(0, 8), decimals: t?.decimals ?? 18 };
  };
  const fee = (pool: string, given?: number): number | null => {
    const f = given ?? res.pool?.(pool)?.feePpm;
    return typeof f === "number" && f >= 0 ? f : null;
  };
  const s = (v: unknown) => (v === undefined || v === null ? null : String(v));
  if (route?.pools && route.tokens && route.amounts) {
    return route.pools.map((pool, i) => ({
      dex: route.dexes?.[i] ?? "?",
      pool,
      from: tok(route.tokens![i]),
      to: tok(route.tokens![i + 1]),
      amountIn: s(route.amounts![i]),
      amountOut: s(route.amounts![i + 1]),
      feePpm: fee(pool, route.executorHops?.[i]?.feePpm),
    }));
  }
  return [
    { dex: r.buyDex, pool: r.buyPool, from: tok(r.tokenIn), to: tok(r.tokenMid), amountIn: s(r.amountIn), amountOut: s(r.amountMid), feePpm: fee(String(r.buyPool)) },
    { dex: r.sellDex, pool: r.sellPool, from: tok(r.tokenMid), to: tok(r.tokenIn), amountIn: s(r.amountMid), amountOut: s(r.amountOut), feePpm: fee(String(r.sellPool)) },
  ];
}

/** Mirrors slimOutcome in src/ui/server.ts. */
export function slimHistoryOutcome(r: Record<string, unknown>): Record<string, unknown> {
  return { id: r.id, status: r.status, realisticNetUsd: r.realisticNetUsd, takenBy: r.takenBy ?? null, takenTx: r.takenTx ?? null };
}
