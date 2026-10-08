/**
 * Thin wrapper over ethers' JsonRpcProvider adding chunked Multicall3
 * batching, typed helpers and a block feed that uses WebSocket push when a
 * WS_URL is configured and polling otherwise.
 */
import { JsonRpcProvider, Network, WebSocketProvider, type Log } from "ethers";
import { MULTICALL3, CHAIN_ID } from "./config.js";
import { multicall3Iface } from "./abi.js";
import { log } from "./log.js";

export interface Call {
  target: string;
  callData: string;
  allowFailure?: boolean;
}

export interface CallResult {
  success: boolean;
  returnData: string;
}

export type BlockTag = number | "latest" | "pending";

/**
 * Retry transient RPC failures (rate limits, timeouts, resets); never retry a
 * genuine contract revert.
 *
 * ethers wraps ANY JSON-RPC error on eth_call as a CALL_EXCEPTION with the
 * message "missing revert data", so a "429 over rate limit" from a public
 * endpoint looks like a revert at first glance. The original error is kept
 * in err.info.error, which is what we inspect here.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 6, baseDelayMs = 250): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts - 1) throw err;
      const delay = Math.min(baseDelayMs * 2 ** i, 3000);
      (i >= 2 ? log.warn : log.debug)(`rpc transient error (attempt ${i + 1}/${attempts}), retrying in ${delay}ms: ${describeError(err).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

interface EthersErrorLike {
  code?: string;
  message?: string;
  shortMessage?: string;
  data?: string | null;
  info?: { error?: { code?: number; message?: string } };
  error?: { code?: number; message?: string };
}

export function describeError(err: unknown): string {
  const e = err as EthersErrorLike;
  const inner = e.info?.error ?? e.error;
  return inner?.message ? `${e.shortMessage ?? e.message ?? ""} [rpc: ${inner.message}]` : (e.shortMessage ?? e.message ?? String(err));
}

export function isTransient(err: unknown): boolean {
  const e = err as EthersErrorLike;
  const inner = e.info?.error ?? e.error;
  const text = `${e.shortMessage ?? ""} ${e.message ?? ""} ${inner?.message ?? ""} ${inner?.code ?? ""}`.toLowerCase();
  if (e.code === "SERVER_ERROR" || e.code === "TIMEOUT" || e.code === "NETWORK_ERROR") return true;
  if (/429|rate limit|too many requests|limit exceeded|capacity|overloaded|try again|timeout|timed out|econnreset|socket hang up|502|503|504|-32016|-32005|-32603/.test(text)) return true;
  // eth_call failed with an RPC error that is not a revert: infrastructure, not the contract.
  if (e.code === "CALL_EXCEPTION" && (e.data === null || e.data === undefined) && inner && !/revert|execution|invalid opcode|out of gas/.test(inner.message ?? "")) return true;
  return false;
}

/** Simple pacing gate: at most one request start per `intervalMs`. */
class Pacer {
  private next = 0;
  constructor(private intervalMs: number) {}
  async wait(): Promise<void> {
    if (this.intervalMs <= 0) return;
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.intervalMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

export interface ChainOptions {
  /** Max aggregate3 requests in flight at once. */
  concurrency?: number;
  /** Minimum spacing between requests we start, in ms (0 = none). */
  minIntervalMs?: number;
  /** JSON-RPC batch size ethers may combine into one HTTP request. */
  batchMaxCount?: number;
  /** Sub-calls per aggregate3. */
  chunkSize?: number;
}

/** Conservative defaults for the free public endpoint, generous ones for a real provider. */
export function defaultChainOptions(rpcUrl: string): Required<ChainOptions> {
  const isPublic = /mainnet\.base\.org|base\.blockpi|publicnode|llamarpc|drpc\.org\/public|1rpc\.io/.test(rpcUrl);
  if (isPublic) return { concurrency: 1, minIntervalMs: 350, batchMaxCount: 4, chunkSize: 120 };
  // Alchemy's free tier meters throughput in compute units per second; a
  // handful of requests in flight keeps discovery fast without tripping it.
  if (/alchemy\.com/.test(rpcUrl)) return { concurrency: 2, minIntervalMs: 60, batchMaxCount: 8, chunkSize: 150 };
  return { concurrency: 6, minIntervalMs: 0, batchMaxCount: 20, chunkSize: 150 };
}

/**
 * Approximate Alchemy compute-unit cost per method (alchemy.com/docs/reference/compute-unit-costs,
 * Oct 2026). Used only to show what a run costs; other providers price differently.
 */
const ALCHEMY_CU: Record<string, number> = {
  eth_call: 26,
  eth_getLogs: 60,
  eth_blockNumber: 10,
  eth_getBlockByNumber: 20,
  eth_getTransactionReceipt: 20,
  eth_chainId: 0,
  eth_feeHistory: 10,
  eth_gasPrice: 20,
  eth_maxPriorityFeePerGas: 10,
  eth_sendRawTransaction: 40,
  eth_getTransactionCount: 20,
};

export interface RpcUsage {
  since: string;
  requests: number;
  byMethod: Record<string, number>;
  /** Estimated Alchemy compute units used so far, and the rate per day at the current pace. */
  alchemyCu: number;
  alchemyCuPerDay: number;
  activeEndpoint: string;
  failovers: number;
}

interface Endpoint {
  url: string;
  provider: JsonRpcProvider;
  opts: Required<ChainOptions>;
  pacer: Pacer;
  /** Not used again before this time after it failed. */
  coolUntil: number;
}

/** Hide API keys when an endpoint is logged or shown in the dashboard. */
export function redactUrl(url: string): string {
  return url.replace(/\/v2\/.*|\/v3\/.*|\/[0-9a-f]{20,}.*|([?&][a-z_-]*(?:key|token|secret)[a-z_-]*=)[^&]+/gi, (_m: string, keyParam?: string) => (keyParam ? `${keyParam}…` : "/…"));
}

export class Chain {
  private ws: WebSocketProvider | undefined;
  private endpoints: Endpoint[];
  private active = 0;
  private lastSwitch = 0;
  private counts = new Map<string, number>();
  private startedAt = Date.now();
  private failoverCount = 0;

  /**
   * @param rpcUrl      primary HTTP endpoint
   * @param wsUrl       optional websocket for new-block push
   * @param options     pacing overrides (applied to every endpoint)
   * @param fallbackUrls further HTTP endpoints, used in order when the active one keeps failing
   */
  constructor(readonly primaryUrl: string, readonly wsUrl?: string, options: ChainOptions = {}, fallbackUrls: string[] = []) {
    const network = Network.from(CHAIN_ID);
    this.endpoints = [primaryUrl, ...fallbackUrls.filter((u) => u && u !== primaryUrl)].map((url) => {
      const opts = { ...defaultChainOptions(url), ...options };
      return {
        url,
        opts,
        pacer: new Pacer(opts.minIntervalMs),
        coolUntil: 0,
        provider: new JsonRpcProvider(url, network, {
          staticNetwork: network,
          batchMaxCount: opts.batchMaxCount,
          batchStallTime: 5,
          polling: false,
          cacheTimeout: -1, // never serve a stale block number
        }),
      };
    });
  }

  /** The endpoint currently in use (falls back down the list on repeated failure, back to the primary after 5 minutes). */
  private current(): Endpoint {
    const now = Date.now();
    if (this.active !== 0 && now - this.lastSwitch > 5 * 60_000 && now >= this.endpoints[0]!.coolUntil) {
      this.active = 0;
      this.lastSwitch = now;
      log.info(`rpc: back on the primary endpoint ${redactUrl(this.endpoints[0]!.url)}`);
    }
    return this.endpoints[this.active]!;
  }

  get provider(): JsonRpcProvider {
    return this.current().provider;
  }

  get opts(): Required<ChainOptions> {
    return this.current().opts;
  }

  get rpcUrl(): string {
    return this.current().url;
  }

  private failover(from: Endpoint, err: unknown): void {
    from.coolUntil = Date.now() + 60_000;
    const next = this.endpoints.findIndex((e, i) => i !== this.endpoints.indexOf(from) && Date.now() >= e.coolUntil);
    if (next < 0) return;
    this.active = next;
    this.lastSwitch = Date.now();
    this.failoverCount++;
    log.warn(`rpc: ${redactUrl(from.url)} keeps failing (${describeError(err).slice(0, 80)}); switching to ${redactUrl(this.endpoints[next]!.url)}`);
  }

  private count(method: string, n = 1): void {
    this.counts.set(method, (this.counts.get(method) ?? 0) + n);
  }

  /** Requests made so far, by method, with an Alchemy compute-unit estimate. */
  usage(): RpcUsage {
    const byMethod = Object.fromEntries(this.counts);
    let requests = 0;
    let cu = 0;
    for (const [m, n] of this.counts) {
      requests += n;
      cu += n * (ALCHEMY_CU[m] ?? 26);
    }
    const hours = Math.max((Date.now() - this.startedAt) / 3_600_000, 1 / 60);
    return {
      since: new Date(this.startedAt).toISOString(),
      requests,
      byMethod,
      alchemyCu: cu,
      alchemyCuPerDay: Math.round((cu / hours) * 24),
      activeEndpoint: redactUrl(this.rpcUrl),
      failovers: this.failoverCount,
    };
  }

  /**
   * Every request goes through the active endpoint's pacer and the transient-error
   * retry; if the endpoint still fails, the next configured endpoint takes over.
   */
  private async rpc<T>(method: string, fn: (p: JsonRpcProvider) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    const tries = Math.max(1, this.endpoints.length);
    for (let t = 0; t < tries; t++) {
      const ep = this.current();
      try {
        return await withRetry(
          async () => {
            await ep.pacer.wait();
            this.count(method);
            return fn(ep.provider);
          },
          this.endpoints.length > 1 ? 3 : 6,
        );
      } catch (err) {
        lastErr = err;
        if (this.endpoints.length === 1 || !isTransient(err)) throw err;
        this.failover(ep, err);
      }
    }
    throw lastErr;
  }

  async send<T = unknown>(method: string, params: unknown[]): Promise<T> {
    return this.rpc(method, async (p) => (await p.send(method, params)) as T);
  }

  async blockNumber(): Promise<number> {
    return this.rpc("eth_blockNumber", (p) => p.getBlockNumber());
  }

  async call(to: string, data: string, blockTag: BlockTag = "latest"): Promise<string> {
    return this.rpc("eth_call", (p) => p.call({ to, data, blockTag }));
  }

  /**
   * eth_call with a state override set (code/balance/storage injected for the
   * duration of the call). Reverts surface like provider.call reverts: a
   * CALL_EXCEPTION whose `data` is the revert payload.
   */
  async callWithOverrides(to: string, data: string, blockTag: BlockTag, overrides: Record<string, { code?: string; balance?: string }>): Promise<string> {
    const tag = typeof blockTag === "number" ? "0x" + blockTag.toString(16) : blockTag;
    return this.rpc("eth_call", async (p) => (await p.send("eth_call", [{ to, data }, tag, overrides])) as string);
  }

  /** Execute many view calls in as few round trips as possible. Order is preserved. */
  async multicall(calls: Call[], blockTag: BlockTag = "latest"): Promise<CallResult[]> {
    const out: CallResult[] = new Array(calls.length);
    const { chunkSize, concurrency } = this.opts;
    const chunks: Array<{ start: number; calls: Call[] }> = [];
    for (let i = 0; i < calls.length; i += chunkSize) {
      chunks.push({ start: i, calls: calls.slice(i, i + chunkSize) });
    }
    // A few chunks in flight at a time (ethers batches JSON-RPC underneath);
    // hundreds of concurrent aggregate3 calls would get a public RPC to 429 us.
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const { start, calls: chunk } = chunks[next++]!;
        const data = multicall3Iface.encodeFunctionData("aggregate3", [
          chunk.map((c) => ({ target: c.target, allowFailure: c.allowFailure ?? true, callData: c.callData })),
        ]);
        const raw = await this.rpc("eth_call", (p) => p.call({ to: MULTICALL3, data, blockTag }));
        const [results] = multicall3Iface.decodeFunctionResult("aggregate3", raw) as unknown as [
          Array<{ success: boolean; returnData: string }>,
        ];
        results.forEach((r, i) => {
          out[start + i] = { success: r.success, returnData: r.returnData };
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
    return out;
  }

  async getLogs(filter: { fromBlock: number; toBlock: number; address?: string | string[]; topics?: Array<string | string[] | null> }): Promise<Log[]> {
    return this.rpc("eth_getLogs", (p) => p.getLogs(filter));
  }

  async getBlock(tag: BlockTag): Promise<{ number: number; timestamp: number; baseFeePerGas: bigint | null } | null> {
    const b = await this.rpc("eth_getBlockByNumber", (p) => p.getBlock(tag));
    if (!b) return null;
    return { number: b.number, timestamp: b.timestamp, baseFeePerGas: b.baseFeePerGas ?? null };
  }

  /**
   * Invoke `onBlock` for every new block number, in order, never concurrently.
   * If a handler is still running when the next block arrives, only the newest
   * block is queued (intermediate blocks are skipped: stale opportunities are
   * worthless anyway).
   *
   * Without a websocket the poll is adaptive: Base makes a block every 2s, so
   * after seeing one we wait until just after the next is due and only then poll
   * quickly. That is ~1.5 eth_blockNumber calls per block instead of 4 at a fixed
   * 500ms, which matters on metered RPC plans.
   */
  async subscribeBlocks(onBlock: (blockNumber: number) => Promise<void>, fastPollMs = 250): Promise<() => void> {
    let last = 0;
    let running = false;
    let pending: number | null = null;

    const handle = async (n: number) => {
      if (n <= last) return;
      if (running) {
        pending = n;
        return;
      }
      running = true;
      try {
        last = n;
        await onBlock(n);
      } catch (err) {
        log.error("block handler failed", n, (err as Error).message);
      } finally {
        running = false;
        if (pending !== null && pending > last) {
          const next = pending;
          pending = null;
          void handle(next);
        }
      }
    };

    let usingWs = false;
    if (this.wsUrl) {
      try {
        this.ws = new WebSocketProvider(this.wsUrl, Network.from(CHAIN_ID), { staticNetwork: Network.from(CHAIN_ID) });
        await this.ws.on("block", (n: number) => void handle(n));
        usingWs = true;
        log.info("subscribed to new blocks over websocket (with a 2s backup poll in case the socket drops)");
      } catch (err) {
        log.warn("websocket subscription failed, falling back to polling:", (err as Error).message);
      }
    }

    // Always poll as well. With a websocket this is a slow backup: providers close idle or
    // long-lived sockets, and with nothing else scheduled Node would simply exit (this is
    // what ended the 2026-09-17 24h run after 97 minutes with an empty error log).
    // handle() ignores block numbers it has already seen, so the two sources never double up.
    let wsSilentSince = Date.now();
    let lastSeen = 0;
    let stopped = false;
    let lastNewAt = 0;
    let lastNewN = 0;
    let blockTimeMs = 2000; // learned from what we observe (Base: 2s)
    const nextDelay = (): number => {
      if (usingWs) return 2000;
      if (!lastNewAt) return fastPollMs;
      const dueIn = lastNewAt + blockTimeMs + 150 - Date.now();
      return Math.max(fastPollMs, Math.min(dueIn, blockTimeMs));
    };
    const tick = async () => {
      if (stopped) return;
      try {
        const n = await this.blockNumber();
        if (n > lastNewN) {
          const now = Date.now();
          if (lastNewAt && lastNewN) {
            const per = (now - lastNewAt) / (n - lastNewN);
            blockTimeMs = Math.min(5000, Math.max(100, blockTimeMs * 0.8 + per * 0.2));
          }
          lastNewAt = now;
          lastNewN = n;
        }
        if (usingWs) {
          if (last > lastSeen) {
            lastSeen = last;
            wsSilentSince = Date.now();
          } else if (n > last && Date.now() - wsSilentSince > 10_000) {
            log.warn("no blocks from the websocket for 10s; continuing on polling");
            wsSilentSince = Date.now();
          }
        }
        await handle(n);
      } catch (err) {
        log.warn("blockNumber poll failed:", (err as Error).message);
      }
      if (!stopped) setTimeout(() => void tick(), nextDelay());
    };
    void tick();
    if (!usingWs) log.info("polling for new blocks (adaptive: just after each 2s block is due)");
    this.stopSubscriptions.push(() => {
      stopped = true;
    });
    return () => {
      stopped = true;
      void this.ws?.destroy();
    };
  }

  private stopSubscriptions: Array<() => void> = [];

  async destroy(): Promise<void> {
    for (const stop of this.stopSubscriptions) stop();
    for (const e of this.endpoints) e.provider.destroy();
    if (this.ws) await this.ws.destroy();
  }
}
