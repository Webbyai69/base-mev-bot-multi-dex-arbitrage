/**
 * One eth_getLogs per block, shared by everything that needs the block's
 * events (low-RPC mode):
 *
 *   the MEV classifier       Swap logs of every DEX on Base
 *   the pool registry        Sync (V2/Aerodrome), Swap/Mint/Burn (V3/Slipstream) of watched pools
 *   the liquidation monitor  Aave V3 Borrow and LiquidationCall
 *
 * Filtering is by topic only (no address list), so the request stays the
 * same size however many pools are watched. On Alchemy an eth_getLogs costs
 * 60 compute units whatever it returns, which is why one shared call beats
 * three narrow ones.
 *
 * Providers cap the block range of eth_getLogs (Alchemy's free tier: 10
 * blocks); a larger catch-up range is split into windows, shrinking the
 * window when the provider says so.
 */
import type { Log } from "ethers";
import {
  TOPIC_AAVE_BORROW,
  TOPIC_AAVE_LIQUIDATION,
  TOPIC_BURN_V3,
  TOPIC_MINT_V3,
  TOPIC_SWAP_AERO,
  TOPIC_SWAP_V2,
  TOPIC_SWAP_V3,
  TOPIC_SYNC,
  TOPIC_SYNC_AERO,
} from "./abi.js";
import type { Chain } from "./rpc.js";
import { log } from "./log.js";

export class BlockLogFetcher {
  private range = 1000;
  readonly topics: string[];

  constructor(readonly chain: Chain, opts: { liquidations: boolean }) {
    this.topics = [TOPIC_SWAP_V2, TOPIC_SWAP_AERO, TOPIC_SWAP_V3, TOPIC_SYNC, TOPIC_SYNC_AERO, TOPIC_MINT_V3, TOPIC_BURN_V3];
    if (opts.liquidations) this.topics.push(TOPIC_AAVE_BORROW, TOPIC_AAVE_LIQUIDATION);
  }

  /** All matching logs in [from, to], in chain order. */
  async fetch(from: number, to: number): Promise<Log[]> {
    const out: Log[] = [];
    let start = from;
    while (start <= to) {
      const end = Math.min(to, start + this.range - 1);
      try {
        out.push(...(await this.chain.getLogs({ fromBlock: start, toBlock: end, topics: [this.topics] })));
        start = end + 1;
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (this.range > 1 && /block range|range|too many|limit|exceed|response size|query returned more/i.test(msg)) {
          const suggested = /up to a (\d+) block/i.exec(msg);
          this.range = suggested ? Math.max(1, Number(suggested[1])) : Math.max(1, Math.floor(this.range / 4));
          log.debug(`eth_getLogs range capped by the provider; using ${this.range}-block windows`);
          continue;
        }
        throw err;
      }
    }
    // Providers return chain order already; sort defensively when windows were merged.
    out.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
    return out;
  }
}
