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

export class Chain {
  readonly provider: JsonRpcProvider;
  private ws: WebSocketProvider | undefined;
  readonly opts: Required<ChainOptions>;
  private pacer: Pacer;

  constructor(readonly rpcUrl: string, readonly wsUrl?: string, options: ChainOptions = {}) {
    this.opts = { ...defaultChainOptions(rpcUrl), ...options };
    this.pacer = new Pacer(this.opts.minIntervalMs);
    const network = Network.from(CHAIN_ID);
    this.provider = new JsonRpcProvider(rpcUrl, network, {
      staticNetwork: network,
      batchMaxCount: this.opts.batchMaxCount,
      batchStallTime: 5,
      polling: false,
      cacheTimeout: -1, // never serve a stale block number
    });
  }

  /** Every request goes through the pacer and the transient-error retry. */
  private async rpc<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(async () => {
      await this.pacer.wait();
      return fn();
    });
  }

  async send<T = unknown>(method: string, params: unknown[]): Promise<T> {
    return this.rpc(async () => (await this.provider.send(method, params)) as T);
  }

  async blockNumber(): Promise<number> {
    return this.rpc(() => this.provider.getBlockNumber());
  }

  async call(to: string, data: string, blockTag: BlockTag = "latest"): Promise<string> {
    return this.rpc(() => this.provider.call({ to, data, blockTag }));
  }

  /**
   * eth_call with a state override set (code/balance/storage injected for the
   * duration of the call). Reverts surface like provider.call reverts: a
   * CALL_EXCEPTION whose `data` is the revert payload.
   */
  async callWithOverrides(to: string, data: string, blockTag: BlockTag, overrides: Record<string, { code?: string; balance?: string }>): Promise<string> {
    const tag = typeof blockTag === "number" ? "0x" + blockTag.toString(16) : blockTag;
    return this.rpc(async () => (await this.provider.send("eth_call", [{ to, data }, tag, overrides])) as string);
  }

  /** Execute many view calls in as few round trips as possible. Order is preserved. */
  async multicall(calls: Call[], blockTag: BlockTag = "latest"): Promise<CallResult[]> {
    const out: CallResult[] = new Array(calls.length);
    const chunks: Array<{ start: number; calls: Call[] }> = [];
    for (let i = 0; i < calls.length; i += this.opts.chunkSize) {
      chunks.push({ start: i, calls: calls.slice(i, i + this.opts.chunkSize) });
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
        const raw = await this.rpc(() => this.provider.call({ to: MULTICALL3, data, blockTag }));
        const [results] = multicall3Iface.decodeFunctionResult("aggregate3", raw) as unknown as [
          Array<{ success: boolean; returnData: string }>,
        ];
        results.forEach((r, i) => {
          out[start + i] = { success: r.success, returnData: r.returnData };
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.opts.concurrency, chunks.length) }, worker));
    return out;
  }

  async getLogs(filter: { fromBlock: number; toBlock: number; address?: string | string[]; topics?: Array<string | string[] | null> }): Promise<Log[]> {
    return this.rpc(() => this.provider.getLogs(filter));
  }

  async getBlock(tag: BlockTag): Promise<{ number: number; timestamp: number; baseFeePerGas: bigint | null } | null> {
    const b = await this.rpc(() => this.provider.getBlock(tag));
    if (!b) return null;
    return { number: b.number, timestamp: b.timestamp, baseFeePerGas: b.baseFeePerGas ?? null };
  }

  /**
   * Invoke `onBlock` for every new block number, in order, never concurrently.
   * If a handler is still running when the next block arrives, only the newest
   * block is queued (intermediate blocks are skipped: stale opportunities are
   * worthless anyway).
   */
  async subscribeBlocks(onBlock: (blockNumber: number) => Promise<void>, pollMs = 500): Promise<() => void> {
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

    if (this.wsUrl) {
      try {
        this.ws = new WebSocketProvider(this.wsUrl, Network.from(CHAIN_ID), { staticNetwork: Network.from(CHAIN_ID) });
        await this.ws.on("block", (n: number) => void handle(n));
        log.info("subscribed to new blocks over websocket");
        return () => {
          void this.ws?.destroy();
        };
      } catch (err) {
        log.warn("websocket subscription failed, falling back to polling:", (err as Error).message);
      }
    }

    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const n = await this.blockNumber();
        await handle(n);
      } catch (err) {
        log.warn("blockNumber poll failed:", (err as Error).message);
      }
      if (!stopped) setTimeout(() => void tick(), pollMs);
    };
    void tick();
    log.info(`polling for new blocks every ${pollMs}ms`);
    return () => {
      stopped = true;
    };
  }

  async destroy(): Promise<void> {
    this.provider.destroy();
    if (this.ws) await this.ws.destroy();
  }
}
