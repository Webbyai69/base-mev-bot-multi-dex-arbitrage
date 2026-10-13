# Cross-chain spread monitor (`xchain-monitor`, Phase 4a)

A passive watcher. Every 15 s it reads the WETH/USDC and USDC/USDT price from the
deepest pool on **Base, Arbitrum, Optimism and Ethereum**, works out the gap for
every chain pair, subtracts what it would cost to capture it, and logs the result.

It **never trades, signs or bridges.** The only RPC methods it can send are
`eth_chainId`, `eth_getCode` and `eth_call` (anything else is refused in
`bots/xchain-monitor/rpc.ts`). It needs no key, and its RPC URLs are never
printed, logged or written to a file.

Why only data: cross-chain arbitrage is not atomic. There is no cross-chain flash
loan, so capturing a gap needs inventory on both chains and carries bridge and
timing risk. The monitor tells us whether the gaps are ever big enough to be
worth that.

## Run it on the Windows PC

Needs **Node 22.18 or newer** (`node -v`); it runs the `.ts` files directly, no build.

1. Put four RPC URLs in `bots\wrapper\.env` (copy `bots\wrapper\.env.example` if
   you haven't): `BASE_RPC_URL`, `ARB_RPC_URL`, `OP_RPC_URL`, `ETH_RPC_URL`. Any
   free tier is enough: about 4 calls per chain every 15 s (≈ 23k a day per
   chain), plus ~40 calls per chain every 6 h to re-check pools. A chain with no
   URL is simply skipped and named in the heartbeat.
2. From the repo folder, through the fleet wrapper (the normal way):

   ```powershell
   python bots\wrapper\fleet_wrapper.py --config bots\wrapper\configs\xchain-monitor.json
   ```

   then ask for `detect` from Terminal → Fleet once the integrator has added the
   registry entry (see the PR). Until then, ask for it by hand with a control file
   `data\fleet\xchain-monitor.control.json`:

   ```json
   {"id":"xchain-monitor","desired":"running","mode":"detect","requestedBy":"owner"}
   ```

   The wrapper passes the `.env` values to the monitor; change `desired` to
   `stopped` to stop it.
3. One-off check without the wrapper (set the URLs in this PowerShell window only):

   ```powershell
   $env:BASE_RPC_URL="..."; $env:ARB_RPC_URL="..."; $env:OP_RPC_URL="..."; $env:ETH_RPC_URL="..."
   node bots\xchain-monitor\monitor.ts --once
   ```

4. The table the terminal will show, from the log so far:

   ```powershell
   node bots\xchain-monitor\summary.ts data\fleet\xchain-spreads.jsonl
   ```

Optional settings (`.env` or environment): `XCHAIN_INTERVAL_MS` (default 15000,
min 5000), `XCHAIN_NOTIONAL_USD` (default 10000), `XCHAIN_MIN_NET_BPS` (default 0),
`XCHAIN_CONFIG` (another config file). Cost assumptions live in
`bots/xchain-monitor/config.json` → `costs`.

## Files it writes

| File | What |
|---|---|
| `data/fleet/xchain-spreads.jsonl` | one line per asset and chain pair per check (12 lines every 15 s, ≈ 17 MB a day; rolls to `.1.jsonl` at 64 MB) |
| `data/fleet/xchain-monitor.fleet-metrics.json` | what the wrapper puts in the heartbeat |
| `data/fleet/xchain-monitor.log` | the wrapper's log: pool choices at start, RPC errors (URLs redacted) |

A JSONL line:

```json
{"ts":"2026-10-13T12:00:00.000Z","asset":"WETH/USDC","a":"base","b":"arb","pa":2500,"pb":2510,
 "buyOn":"base","sellOn":"arb","gapBps":40,"costBps":14.15,"netBps":25.85,"open":true,
 "notionalUsd":10000,"estUsd":25.85,"venues":["uniswap-v3","uniswap-v3"]}
```

## What the numbers mean

- **Gap** (bps) = `|price A − price B| / lower price × 10 000`. `buyOn` is the cheaper chain.
- **Cost** (bps) = bridge fee + both pools' swap fees (read from each pool's own
  `fee()`) + (swap gas on both chains + the bridge's fixed USD) ÷ notional.
- **Net** = gap − cost. A **window is open** while net > `XCHAIN_MIN_NET_BPS` (0).
- **Window** = a run of consecutive open checks for one asset and pair. More than
  three missed checks ends a run, so a monitor restart doesn't invent windows.
- **Est / $10k** = net bps in dollars at $10k (1 bps of $10k = $1). It ignores
  price impact: the pools are deep, but at $10k on a thin pair the real figure is lower.
- Heartbeat metrics: `openWindows24h` (windows started in the last 24 h, all
  routes), `bestNetBps` (best net of any check in 24 h, usually negative),
  `openNow`, `windowsToday`, `bestGapBpsNow`, `chainsLive`, `chainsConfigured`,
  `poolsVerified`, `checks24h`, `rpcErrors`, `notionalUsd`. `pnlUsd`, `sends` and
  `gasUsd` are always 0: this bot doesn't trade.

The bridge fee is charged on every check even though an inventory strategy
doesn't bridge per trade. It has to rebalance sooner or later, and charging the
cost up front keeps "open" windows honest.

## Cost assumptions (estimates, not live quotes)

No fee API that needs a key is called. These defaults are in `config.json` and
are deliberately on the cautious side; check them against live quotes on
across.to and Circle's docs before trusting a window.

| Asset | Route | Bridge bps | Fixed USD | Basis |
|---|---|---|---|---|
| WETH | L2 ↔ L2 (Across) | 4 | 0.10 | Across charges an LP fee + relayer capital fee + relayer gas fee, quoted per transfer ([Across fees](https://docs.across.to/introduction/fees)); for WETH between L2s that is typically a few bps |
| WETH | any ↔ Ethereum (Across) | 6 | 3.00 | same, plus the higher Ethereum fill cost |
| USDC/USDT | L2 ↔ L2 (CCTP V2 Fast) | 1 | 0.10 | CCTP Standard Transfer has no protocol fee but waits for source-chain finality (~13–19 min); Fast Transfer charges about 1 bps ([Circle CCTP fees](https://developers.circle.com/cctp/concepts/fees)) |
| USDC/USDT | any ↔ Ethereum (CCTP V2 Fast) | 1 | 3.00 | same, plus Ethereum mint/burn gas |

Swap gas per side: Base $0.02, Arbitrum $0.03, Optimism $0.02, Ethereum $2.50
(one V3 swap at ordinary gas prices). Per-pair overrides go in
`costs.pairOverrides`, e.g. `"base-arb": {"bridgeBps": 3, "fixedUsd": 0.05}`.

For USDC/USDT the gap is "USDT per USDC"; the leg that moves between chains is
USDC (CCTP), and USDT on Base is the bridged token, so its pool is thin.

## Which pools, and how they are checked

Pool addresses are **not trusted from config**. At start and every 6 h the monitor:

1. checks `eth_chainId` matches (8453, 42161, 10, 1), so a mistyped URL can't feed
   the wrong chain;
2. checks each token's `decimals()` matches config;
3. asks each factory for every tier (`getPool`): Uniswap V3 fee tiers 0.01 / 0.05 /
   0.3 %, and on Base Aerodrome Slipstream (Optimism: Velodrome Slipstream) tick
   spacings 1 / 50 / 100 / 200;
4. keeps a candidate only if it has code (`eth_getCode`) and its `token0()` /
   `token1()` are exactly our two tokens, then picks the one with the most
   in-range `liquidity()`, i.e. the deepest at the current price.

The log names each chosen pool and its fee. `expected` in config is a
cross-check only; the log says when the choice differs from it.

Sources for the addresses in `config.json`:

- Uniswap V3 factories: Uniswap docs, "Deployments" (Ethereum/Arbitrum/Optimism
  `0x1F98…F984`, Base `0x3312…FDfD`).
- Aerodrome Slipstream CL factory (Base) and Velodrome Slipstream CL factory
  (Optimism): the projects' contract lists. **Unverified from the build sandbox**;
  if one is wrong, its candidates just fail step 4 and Uniswap is used.
- USDC: Circle "USDC contract addresses" (native USDC on every chain, not USDC.e).
- USDT: Tether (Ethereum, Optimism), USDT0 on Arbitrum, bridged USDT on Base.
- WETH: the canonical WETH9 on Ethereum and Arbitrum, the `0x4200…0006`
  predeploy on Base and Optimism.
- `expected` pools: the well-known Uniswap V3 WETH/USDC 0.05 % pools on Ethereum
  (`0x88e6…5640`), Arbitrum (`0xC696…E8D0`) and Base (`0xd0b5…F224`), and
  USDC/USDT 0.01 % on Ethereum (`0x3416…27C6`).

The build sandbox could not reach any public RPC (egress blocked), so none of
these were checked on-chain while this was written. The start-up checks above do
that on your PC; read the first lines of `data/fleet/xchain-monitor.log` after
the first run.

## What a later inventory strategy would need (your decision)

This monitor is step one. Trading these gaps would need, at least:

- **Capital on every chain it trades**: both assets on both sides (e.g. USDC on
  the cheap chain to buy WETH, WETH on the dear chain to sell), sized so one
  window doesn't drain a side. Each chain's wallet funded by you, not the main
  wallet.
- **Rebalancing**: when one side runs dry, bridge back (Across / CCTP) at the
  costs above, ideally batched and only when the inventory skew passes a threshold.
- **Risk**: price moves while inventory sits (WETH exposure unless hedged), bridge
  delay and failure, a stale price on one side (L2 sequencer down, RPC lag),
  chain-specific gas spikes, and smart-contract risk of each bridge.
- **Execution**: two independent swaps, one per chain, each a plain market swap
  with its own slippage limit. No trading ahead of anyone's pending
  transaction.
- **Evidence first**: at least a week of this log showing windows that stay open
  for more than a few checks with net above, say, 5 bps after costs. If
  `openWindows24h` stays near zero, the answer is no.

Nothing here builds any of that. Whether to go further is Joshua's call.
