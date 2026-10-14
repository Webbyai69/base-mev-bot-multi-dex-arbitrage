// Morpho Blue liquidator adapter: log parser (bots/CONTRACT.md metrics file).
//
// Reads the JSON lines that morpho-org/morpho-bots `bots/blue-liquidation` writes to stderr
// (`{ level, time, event, bot, chainId, ...fields }`, see packages/bot-kit/src/logger.ts upstream)
// and folds them into the metrics file the fleet wrapper turns into a heartbeat.
//
// Pure: no I/O, no clock reads except through the `now` argument, so it is unit-testable on
// recorded lines. Only erasable TypeScript syntax, so Node >= 22.18 runs it without a build step.
//
// This file is our own code (not copied from upstream). Upstream: Apache-2.0, Morpho Association.

export type MarketInfo = {
  /** e.g. "cbBTC/USDC" (collateral/loan). */
  pair: string
  collateralDecimals: number
  /** USD per whole collateral token; null when the API has no price. */
  collateralPriceUsd: number | null
  /** LLTV as a fraction (0.86 for an 86% market). */
  lltv: number
}

export type Position = {
  id: string
  marketId: string
  borrower: string
  /** Collateral the bot would seize, raw units (decimal string from the log). */
  seizedAssets: string | null
  lastSeen: number
  skippedReason: string | null
}

export type Route = { pair: string; venues: string[]; count: number; usd: number }

export type MetricsFile = {
  pnlUsd: number
  sends: number
  gasUsd: number
  detail: string
  routes: Route[]
  metrics: Record<string, number>
}

const MAX_POSITIONS = 5000
const MAX_TEXT = 300
const LIQUIDATION_CURSOR = 0.3
const MAX_LIF = 1.15

/** Morpho Blue's liquidation incentive factor for a market's LLTV (fraction, e.g. 0.86). */
export function lifFromLltv(lltv: number): number {
  if (!(lltv > 0 && lltv < 1)) return 1
  return Math.min(MAX_LIF, 1 / (1 - LIQUIDATION_CURSOR * (1 - lltv)))
}

/** USD bonus of seizing `seizedRaw` collateral: seized value x (1 - 1/LIF). Null if unpriced. */
export function bonusUsd(seizedRaw: string | null, info: MarketInfo | undefined): number | null {
  if (!seizedRaw || !info || info.collateralPriceUsd == null) return null
  if (!/^\d+$/.test(seizedRaw)) return null
  const tokens = Number(seizedRaw) / 10 ** info.collateralDecimals
  if (!Number.isFinite(tokens)) return null
  const value = tokens * info.collateralPriceUsd
  return value * (1 - 1 / lifFromLltv(info.lltv))
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}..${id.slice(-4)}` : id
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Parses one log line. Returns the object for a JSON line with an `event`, else null
 * (build output, stack traces and blank lines are ignored).
 */
export function parseLine(line: string): Record<string, unknown> | null {
  const t = line.trim()
  if (!t.startsWith('{') || t.length > 256 * 1024) return null
  try {
    const v = JSON.parse(t) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { event?: unknown }).event === 'string') {
      return v as Record<string, unknown>
    }
  } catch {
    // not a log line
  }
  return null
}

export class MorphoDetectState {
  day: string
  started = false
  positionsWatched = 0
  liquidatableNow = 0
  ticks = 0
  lastBlock: number | null = null
  discoverErrors = 0
  tickErrors = 0
  sends = 0
  startupCandidates: number | null = null
  lastError: string | null = null
  detectionOnly = false
  positions = new Map<string, Position>()
  /** venues seen per market (quote.ok / select.ok); empty in detect mode. */
  venuesByMarket = new Map<string, Set<string>>()
  markets = new Map<string, MarketInfo>()

  constructor(now: number) {
    this.day = utcDay(now)
  }

  /** Feed one raw line; returns true if it was a recognised upstream event. */
  feed(line: string, now: number): boolean {
    const e = parseLine(line)
    if (!e) return false
    this.rollDay(now)
    this.apply(e, now)
    return true
  }

  private rollDay(now: number): void {
    const d = utcDay(now)
    if (d === this.day) return
    // "today (UTC) so far" per the contract: daily counters reset, the live view does not.
    this.day = d
    this.positions.clear()
    this.sends = 0
    this.ticks = 0
    this.discoverErrors = 0
    this.tickErrors = 0
  }

  private trackPosition(e: Record<string, unknown>, now: number, seized: string | null, reason: string | null): void {
    const id = str(e.id)
    const marketId = str(e.marketId)
    if (!id || !marketId) return
    const prev = this.positions.get(id)
    if (!prev && this.positions.size >= MAX_POSITIONS) return
    this.positions.set(id, {
      id,
      marketId: marketId.toLowerCase(),
      borrower: str(e.borrower) ?? prev?.borrower ?? '',
      seizedAssets: seized ?? prev?.seizedAssets ?? null,
      lastSeen: now,
      skippedReason: reason ?? (seized ? null : prev?.skippedReason ?? null)
    })
  }

  private apply(e: Record<string, unknown>, now: number): void {
    const event = String(e.event)
    switch (event) {
      case 'startup':
        this.started = true
        this.lastError = null
        return
      case 'startup.error':
        this.lastError = `startup failed: ${str(e.error) ?? 'unknown error'}`
        return
      case 'quoting.no_routes':
        this.detectionOnly = true
        return
      case 'discovery.startup':
        this.startupCandidates = num(e.candidates)
        return
      case 'discovery.startup_error':
        this.lastError = `discovery: ${str(e.detail) ?? 'error'}`
        return
      case 'block.new': {
        const h = num(e.height)
        if (h != null) this.lastBlock = h
        return
      }
      case 'lens.read': {
        const r = num(e.returned)
        if (r != null) this.positionsWatched = r
        return
      }
      case 'tick.end': {
        this.ticks += 1
        const pairs = num(e.pairs)
        const liq = num(e.liquidatable)
        if (pairs != null) this.positionsWatched = pairs
        if (liq != null) this.liquidatableNow = liq
        if (e.complete === true && this.lastError?.startsWith('tick')) this.lastError = null
        return
      }
      case 'discover.error':
        this.discoverErrors += 1
        return
      case 'tick.error':
        this.tickErrors += 1
        this.lastError = `tick: ${str(e.error) ?? str(e.detail) ?? 'error'}`
        return
      case 'plan.built':
        this.trackPosition(e, now, str(e.seizedAssets), null)
        return
      case 'plan.skipped':
        this.trackPosition(e, now, null, str(e.reason))
        return
      case 'config.no_swap_path':
        this.trackPosition(e, now, null, null)
        return
      case 'quote.ok':
      case 'select.ok': {
        const venue = str(e.venue)
        const marketId = str(e.marketId) ?? str(e.id)?.split(':')[0] ?? null
        if (venue && marketId) {
          const k = marketId.toLowerCase()
          const set = this.venuesByMarket.get(k) ?? new Set<string>()
          set.add(venue)
          this.venuesByMarket.set(k, set)
        }
        return
      }
      case 'tx.sent':
        // Never expected in detect mode (no venue => no plan reaches the signer). Counted so the
        // fleet card would show it at once if that ever changed.
        this.sends += 1
        return
      default:
        return
    }
  }

  /** Market ids seen in liquidatable positions that still need a pair/price lookup. */
  unknownMarkets(): string[] {
    const out = new Set<string>()
    for (const p of this.positions.values()) if (!this.markets.has(p.marketId)) out.add(p.marketId)
    return [...out]
  }

  routes(): Route[] {
    const byMarket = new Map<string, Route>()
    for (const p of this.positions.values()) {
      const info = this.markets.get(p.marketId)
      const key = p.marketId
      const r = byMarket.get(key) ?? {
        pair: info?.pair ?? `market ${short(p.marketId)}`,
        venues: ['morpho-blue', ...[...(this.venuesByMarket.get(key) ?? [])].sort()],
        count: 0,
        usd: 0
      }
      r.count += 1
      r.usd += bonusUsd(p.seizedAssets, info) ?? 0
      byMarket.set(key, r)
    }
    return [...byMarket.values()]
      .map((r) => ({ ...r, usd: round2(r.usd) }))
      .sort((a, b) => b.usd - a.usd || b.count - a.count || a.pair.localeCompare(b.pair))
      .slice(0, 12)
  }

  bestBonusUsd(): number {
    let best = 0
    for (const p of this.positions.values()) {
      const b = bonusUsd(p.seizedAssets, this.markets.get(p.marketId))
      if (b != null && b > best) best = b
    }
    return round2(best)
  }

  detail(): string {
    let text: string
    if (this.lastError && !this.ticks) text = this.lastError
    else if (!this.started && !this.ticks) text = 'starting the Morpho Blue liquidator (detect only)'
    else {
      const best = this.bestBonusUsd()
      text =
        `detect only: watching ${this.positionsWatched} positions at HF<=1.02; ` +
        `${this.liquidatableNow} liquidatable now, ${this.positions.size} seen today` +
        (best > 0 ? `; best bonus ~$${best.toFixed(2)}` : '') +
        (this.sends > 0 ? `; WARNING ${this.sends} tx sent in detect mode` : '') +
        (this.lastError ? `; last error: ${this.lastError}` : '')
    }
    return text.slice(0, MAX_TEXT)
  }

  toMetricsFile(): MetricsFile {
    const metrics: Record<string, number> = {
      positionsWatched: this.positionsWatched,
      liquidatable: this.liquidatableNow,
      liquidatableToday: this.positions.size,
      bestBonusUsd: this.bestBonusUsd(),
      ticks: this.ticks,
      discoverErrors: this.discoverErrors,
      tickErrors: this.tickErrors
    }
    if (this.lastBlock != null) metrics.lastBlock = this.lastBlock
    return {
      pnlUsd: 0,
      sends: this.sends,
      gasUsd: 0,
      detail: this.detail(),
      routes: this.routes(),
      metrics
    }
  }
}

/**
 * Morpho GraphQL `markets` items -> MarketInfo. Defensive: the API is untrusted input.
 * Expected item: { uniqueKey, lltv, loanAsset{symbol}, collateralAsset{symbol, decimals, priceUsd} }
 */
export function parseMarketsResponse(body: unknown): Map<string, MarketInfo> {
  const out = new Map<string, MarketInfo>()
  const items = (body as { data?: { markets?: { items?: unknown } } })?.data?.markets?.items
  if (!Array.isArray(items)) return out
  for (const it of items as Array<Record<string, unknown>>) {
    const key = str(it?.uniqueKey)
    const coll = it?.collateralAsset as Record<string, unknown> | null | undefined
    const loan = it?.loanAsset as Record<string, unknown> | null | undefined
    const lltvRaw = num(it?.lltv)
    const decimals = num(coll?.decimals)
    if (!key || lltvRaw == null || decimals == null) continue
    const sym = (v: unknown) => (str(v) ?? '?').replace(/[^\w.+-]/g, '').slice(0, 16) || '?'
    out.set(key.toLowerCase(), {
      pair: `${sym(coll?.symbol)}/${sym(loan?.symbol)}`,
      collateralDecimals: Math.max(0, Math.min(36, Math.trunc(decimals))),
      collateralPriceUsd: num(coll?.priceUsd),
      lltv: lltvRaw > 1 ? lltvRaw / 1e18 : lltvRaw
    })
  }
  return out
}

export const MARKETS_QUERY = `query FleetMarkets($keys: [String!], $chainIds: [Int!]) {
  markets(where: { uniqueKey_in: $keys, chainId_in: $chainIds }, first: 100) {
    items { uniqueKey lltv loanAsset { symbol } collateralAsset { symbol decimals priceUsd } }
  }
}`
