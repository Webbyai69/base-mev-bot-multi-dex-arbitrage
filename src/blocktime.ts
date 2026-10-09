/**
 * Block time, in one place — so the bot survives Base's Denim hardfork.
 *
 * Base produces a 2-second block today, so every "N blocks" threshold in the
 * bot was sized against 2s. Base's Denim hardfork (targeted late 2026) replaces
 * Flashblocks with native 200ms canonical blocks — 10x faster — which would make
 * every fixed block-count threshold 10x too short in wall-clock terms: a
 * "20 minute" mute window would become 2 minutes, a "last ~minute" memory window
 * 6 seconds, and so on.
 *
 * To survive that cutover without a scramble, wall-clock thresholds are written
 * as a duration and converted to a block count through blocksFor(). The only
 * thing to change at Denim is the block time: set BLOCK_TIME_MS=200 and every
 * derived threshold rescales automatically.
 *
 * Already derived from this (so Denim-safe):
 *   - Scanner.failureMuteBlocks  (revert mute window, ~20 min)   — src/scanner.ts
 *   - GasEstimator.l1RefreshBlocks (L1 data-fee refresh, ~20 s)  — src/gas.ts
 *   - FlashblockWatcher memory window (~60 s)                    — src/flashblocks.ts
 *
 * Still fixed block counts, to migrate when Denim reaches a testnet we can test
 * against (left alone for now because scaling them 10x also multiplies the
 * eth_getLogs range they fetch, which must be weighed against provider limits):
 *   - discoveryLookbackBlocks, liqLookbackBlocks, fullRefreshBlocks, maxLogGap,
 *     liqCheckEvery  — all in src/config.ts, each env-overridable.
 *
 * Note: block *detection* needs no change for Denim — Chain.subscribeBlocks
 * (src/rpc.ts) already learns the real block time adaptively and clamps to
 * [100, 5000] ms, so it follows 200ms blocks on its own. This module governs the
 * fixed thresholds only.
 */

/** Current Base block time in milliseconds. 2000 today; set BLOCK_TIME_MS=200 at the Denim hardfork. */
export function blockTimeMs(): number {
  const v = Number(process.env.BLOCK_TIME_MS);
  return Number.isFinite(v) && v > 0 ? v : 2000;
}

/** A wall-clock duration (ms) as a number of blocks at the current block time (at least 1). */
export function blocksFor(ms: number): number {
  return Math.max(1, Math.round(ms / blockTimeMs()));
}

/**
 * The block tag read for pre-confirmed (sub-block) state in the Flashblocks loop.
 * Today Base answers the "pending" tag from the latest 200ms flashblock. At Denim
 * the "pending" tag goes away and the newest 200ms *canonical* block takes its
 * place; that migration (widening the read path to accept "latest" and validating
 * it on a Denim testnet) is the remaining step. Kept here as the single switch
 * point so the Flashblocks loop references one name instead of a scattered literal.
 */
export const PRECONF_TAG = "pending" as const;
