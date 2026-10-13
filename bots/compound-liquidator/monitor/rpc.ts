/**
 * A read-only JSON-RPC client. It refuses every method that is not on READ_ONLY, so this
 * monitor cannot sign or send a transaction even by mistake: there is no key, no signer,
 * and eth_sendRawTransaction / eth_sendTransaction / eth_sign* are rejected before any
 * request leaves the process.
 */
import { MULTICALL3, decodeAggregate3Result, encodeAggregate3, type Call3, type Result3 } from "./abi.ts";

export const READ_ONLY = new Set(["eth_chainId", "eth_blockNumber", "eth_call", "eth_getLogs", "eth_getCode", "eth_gasPrice"]);

export interface Log {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
}

export class Rpc {
  private id = 0;
  calls = 0;
  private readonly url: string;
  private readonly timeoutMs: number;
  constructor(url: string, timeoutMs = 15_000) {
    if (!/^https?:\/\//i.test(url)) throw new Error("RPC URL must be http(s)");
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  /** Host only, for logs: never print the path or query (providers put keys there). */
  get host(): string {
    try {
      return new URL(this.url).host;
    } catch {
      return "?";
    }
  }

  async request<T>(method: string, params: unknown[] = []): Promise<T> {
    if (!READ_ONLY.has(method)) throw new Error(`refused: ${method} is not a read-only method`);
    this.calls++;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status} from ${this.host}`);
      const body = (await res.json()) as { result?: T; error?: { message?: string; code?: number } };
      if (body.error) throw new Error(`${method}: ${body.error.message ?? "error"} (${body.error.code ?? "?"})`);
      return body.result as T;
    } finally {
      clearTimeout(t);
    }
  }

  async blockNumber(): Promise<number> {
    return Number(BigInt(await this.request<string>("eth_blockNumber")));
  }

  async chainId(): Promise<number> {
    return Number(BigInt(await this.request<string>("eth_chainId")));
  }

  async gasPrice(): Promise<bigint> {
    return BigInt(await this.request<string>("eth_gasPrice"));
  }

  async code(address: string): Promise<string> {
    return this.request<string>("eth_getCode", [address, "latest"]);
  }

  async ethCall(to: string, data: string): Promise<string> {
    return this.request<string>("eth_call", [{ to, data }, "latest"]);
  }

  async logs(address: string, topics: (string | string[] | null)[], fromBlock: number, toBlock: number): Promise<Log[]> {
    return this.request<Log[]>("eth_getLogs", [{ address, topics, fromBlock: "0x" + fromBlock.toString(16), toBlock: "0x" + toBlock.toString(16) }]);
  }

  /** Multicall3.aggregate3 in batches; failed sub-calls come back as success=false, never throw. */
  async multicall(calls: Call3[], batch = 250): Promise<Result3[]> {
    const out: Result3[] = [];
    for (let i = 0; i < calls.length; i += batch) {
      const chunk = calls.slice(i, i + batch).map((c) => ({ ...c, allowFailure: true }));
      const ret = await this.ethCall(MULTICALL3, encodeAggregate3(chunk));
      out.push(...decodeAggregate3Result(ret));
    }
    return out;
  }
}
