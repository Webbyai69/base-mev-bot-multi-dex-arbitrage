// Morpho Blue liquidator adapter: launcher for the fleet wrapper (bots/CONTRACT.md).
//
//   node bots/adapters/morpho/run.ts --mode detect
//
// Runs morpho-org/morpho-bots `bots/blue-liquidation` (built bundle) INSIDE this process, in
// detection-only mode on Base, reads its JSON log lines and writes the metrics file the wrapper
// turns into a heartbeat. One process on purpose: when the wrapper stops us (on Windows that is
// TerminateProcess), the upstream bot stops with us instead of being orphaned.
//
// Safety, enforced here whatever the .env holds:
//   * Only --mode detect runs. There is no paper or live path in this file.
//   * ALLOW_DETECTION_ONLY=true, ENABLE_LIFI=false and NO venue key reaches the upstream bot, so it
//     has no swap path: every liquidatable position ends at `config.no_swap_path` and nothing is
//     simulated, signed or sent.
//   * The upstream sees only an allowlist of variables (no other fleet bot's keys).
//   * No variable value is ever printed or written to the metrics file, only names.
//
// Our own code. Upstream: Apache-2.0, Copyright 2026 Morpho Association (bots/upstream/morpho-bots).

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { format } from 'node:util'

import { MARKETS_QUERY, MorphoDetectState, parseMarketsResponse } from './parser.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const UPSTREAM = resolve(REPO, 'bots/upstream/morpho-bots/bots/blue-liquidation')
const BASE_CHAIN_ID = '8453'
const FLUSH_MS = 10_000
const LOOKUP_MIN_GAP_MS = 60_000

// Variables the OS / Node need. Everything else is dropped before the upstream code loads.
const OS_VARS = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'HOMEDRIVE', 'HOMEPATH',
  'LANG', 'TZ', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'
]
// Optional upstream tunables Joshua may set in bots/wrapper/.env (names only, see the doc).
const PASS_THROUGH = [
  'HEALTH_FACTOR_LTE', 'MORPHO_API_URL', 'MAX_DEPLOYLESS_BATCH_SIZE', 'EXCLUDE_COLLATERALS', 'LOG_LEVEL'
]
// Never forwarded in detect mode: any of these would arm a swap venue.
export const VENUE_VARS = ['ZEROX_API_KEY', 'ONEINCH_API_KEY', 'LIFI_API_KEY', 'ENABLE_LIFI']

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const mode = arg('mode', process.env.FLEET_MODE ?? 'detect')
const metricsPath = resolve(REPO, arg('metrics', 'data/fleet/morpho-liquidator.fleet-metrics.json'))
// --bundle exists for the adapter's own tests (a stub that prints recorded lines).
const BUNDLE = resolve(REPO, arg('bundle', resolve(UPSTREAM, 'dist/src/index.js')))

const state = new MorphoDetectState(Date.now())

function writeMetrics(extraError?: string): void {
  try {
    const m = state.toMetricsFile()
    if (extraError) m.detail = extraError.slice(0, 300)
    mkdirSync(dirname(metricsPath), { recursive: true })
    const tmp = `${metricsPath}.tmp`
    writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', 'utf8')
    renameSync(tmp, metricsPath)
  } catch (e) {
    process.stdout.write(`[morpho-adapter] could not write metrics: ${(e as Error).message}\n`)
  }
}

function fail(message: string): never {
  process.stdout.write(`[morpho-adapter] ${message}\n`)
  writeMetrics(message)
  process.exit(1)
}

/** Builds the upstream's environment from an allowlist. Returns the names that are missing. */
export function detectEnv(src: NodeJS.ProcessEnv): { env: Record<string, string>; missing: string[] } {
  const env: Record<string, string> = {}
  const upper = new Map(Object.keys(src).map((k) => [k.toUpperCase(), k]))
  const get = (name: string): string | undefined => {
    const k = upper.get(name)
    const v = k ? src[k] : undefined
    return v && v.trim() ? v.trim() : undefined
  }
  for (const name of OS_VARS) {
    const k = upper.get(name)
    if (k && src[k] != null) env[k] = src[k]!
  }
  for (const name of PASS_THROUGH) {
    const v = get(name)
    if (v) env[name] = v
  }
  const missing: string[] = []
  const rpc = get('MORPHO_RPC_URL') ?? get('BASE_RPC_URL')
  if (rpc) env.RPC_URL = rpc
  else missing.push('BASE_RPC_URL (or MORPHO_RPC_URL)')
  const fallback = get('MORPHO_RPC_URL_FALLBACK')
  if (fallback) env.RPC_URL_FALLBACK = fallback
  const key = get('MORPHO_DETECT_PRIVATE_KEY')
  if (key) env.LIQUIDATOR_PRIVATE_KEY = key
  else missing.push('MORPHO_DETECT_PRIVATE_KEY')
  env.CHAIN_ID = BASE_CHAIN_ID
  env.ALLOW_DETECTION_ONLY = 'true'
  env.ENABLE_LIFI = 'false'
  if (!env.LOG_LEVEL) env.LOG_LEVEL = 'info'
  return { env, missing }
}

// -- market names and prices for routes / bonus (public Morpho API, best effort) ---------------

let lookupBusy = false
let lastLookup = 0
async function lookupMarkets(): Promise<void> {
  const keys = state.unknownMarkets().slice(0, 100)
  if (!keys.length || lookupBusy || Date.now() - lastLookup < LOOKUP_MIN_GAP_MS) return
  lookupBusy = true
  lastLookup = Date.now()
  try {
    const url = process.env.MORPHO_API_URL?.trim() || 'https://api.morpho.org/graphql'
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: MARKETS_QUERY, variables: { keys, chainIds: [Number(BASE_CHAIN_ID)] } }),
      signal: AbortSignal.timeout(10_000)
    })
    const text = await res.text()
    if (res.ok && text.length < 1_000_000) {
      for (const [k, v] of parseMarketsResponse(JSON.parse(text))) state.markets.set(k, v)
    }
  } catch {
    // Coverage only: routes fall back to the market id and the bonus to 0.
  } finally {
    lookupBusy = false
  }
}

// -- run ------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (mode !== 'detect') fail(`mode "${mode}" is not offered: this adapter runs detect only`)
  if (!existsSync(BUNDLE)) {
    fail('upstream not built: see docs/fleet/morpho-liquidator.md (pnpm install, then build blue-liquidation)')
  }
  const { env, missing } = detectEnv(process.env)
  if (missing.length) fail(`set ${missing.join(' and ')} in bots/wrapper/.env`)

  // Replace this process's environment with the allowlist before any upstream code runs.
  for (const k of Object.keys(process.env)) delete process.env[k]
  Object.assign(process.env, env)

  // The upstream logs one JSON object per line through console.error (stderr). Tee every line to
  // stdout (the wrapper's log file) and into the parser.
  console.error = (...args: unknown[]) => {
    const text = format(...args)
    for (const line of text.split('\n')) state.feed(line, Date.now())
    process.stdout.write(text + '\n')
    if (/"event":"tick\.end"/.test(text)) {
      void lookupMarkets().then(() => writeMetrics())
    }
  }

  const timer = setInterval(() => writeMetrics(), FLUSH_MS)
  timer.unref()
  process.on('exit', () => writeMetrics())
  writeMetrics()

  if (existsSync(UPSTREAM)) process.chdir(UPSTREAM)
  process.stdout.write(`[morpho-adapter] starting blue-liquidation on Base in DETECTION-ONLY mode\n`)
  await import(pathToFileURL(BUNDLE).href)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((e) => fail(`adapter error: ${(e as Error).message}`))
}
