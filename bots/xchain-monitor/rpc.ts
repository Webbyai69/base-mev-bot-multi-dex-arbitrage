/**
 * Plain JSON-RPC over fetch, read-only. The monitor only ever sends eth_chainId, eth_getCode and
 * eth_call; anything else is refused here so a later edit can't turn it into a sender by accident.
 *
 * RPC URLs often carry an API key in the path or query, so no URL is ever logged, thrown or written:
 * every error message passes through redact() first.
 */

export const READ_METHODS = new Set(["eth_chainId", "eth_getCode", "eth_call", "eth_blockNumber"]);

export interface RpcCall {
  method: string;
  params: unknown[];
}

/** Anything that can answer a batch of read calls (a real endpoint, or a mock in tests). */
export type RpcTransport = (calls: RpcCall[]) => Promise<unknown[]>;

/** Remove anything URL-shaped (and the given secrets) from a message. */
export function redact(message: string, secrets: string[] = []): string {
  let out = message;
  for (const s of secrets) if (s) out = out.split(s).join("<rpc>");
  out = out.replace(/\b(?:https?|wss?):\/\/[^\s"'<>)]+/gi, "<rpc>");
  return out.slice(0, 200);
}

export class RpcError extends Error {}

/**
 * A transport for one endpoint. Sends the calls as one JSON-RPC batch; if the endpoint refuses
 * batches, falls back to one request per call. Results come back in call order; a failed call
 * yields an RpcError in its slot rather than failing the whole batch.
 */
export function httpTransport(url: string, timeoutMs = 8000, fetchImpl: typeof fetch = fetch): RpcTransport {
  const post = async (body: unknown): Promise<unknown> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) throw new RpcError(`http ${res.status}`);
      return await res.json();
    } catch (e) {
      throw new RpcError(redact(e instanceof Error ? e.message : String(e), [url]));
    } finally {
      clearTimeout(timer);
    }
  };
  const unwrap = (r: unknown): unknown => {
    const o = r as { result?: unknown; error?: { message?: string } } | null;
    if (!o || typeof o !== "object") return new RpcError("malformed response");
    if (o.error) return new RpcError(redact(String(o.error.message ?? "rpc error"), [url]));
    return o.result;
  };
  return async (calls) => {
    for (const c of calls) if (!READ_METHODS.has(c.method)) throw new RpcError(`refused non-read method ${c.method}`);
    if (calls.length === 0) return [];
    const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params }));
    const res = await post(body);
    if (Array.isArray(res) && res.length === calls.length) {
      const byId = new Map<number, unknown>();
      for (const r of res) byId.set(Number((r as { id?: unknown })?.id), r);
      return calls.map((_, i) => unwrap(byId.get(i + 1)));
    }
    // No batch support: one by one.
    const out: unknown[] = [];
    for (const [i, c] of calls.entries()) {
      try {
        out.push(unwrap(await post({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params })));
      } catch (e) {
        out.push(e instanceof RpcError ? e : new RpcError("rpc error"));
      }
    }
    return out;
  };
}

// ---- ABI helpers (only the static types this monitor reads) -------------------------------------

export const pad32 = (hex: string): string => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
export const encAddress = (a: string): string => pad32(a);
export function encInt24(v: number): string {
  const x = v < 0 ? (1n << 256n) + BigInt(v) : BigInt(v);
  return x.toString(16).padStart(64, "0");
}
export const encUint = (v: number | bigint): string => BigInt(v).toString(16).padStart(64, "0");

/** The n-th 32-byte word of an eth_call result as a bigint (unsigned). */
export function word(result: unknown, n = 0): bigint {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result)) throw new RpcError("bad call result");
  const hex = result.slice(2 + n * 64, 2 + (n + 1) * 64);
  if (hex.length !== 64) throw new RpcError("short call result");
  return BigInt("0x" + hex);
}

export function wordAddress(result: unknown, n = 0): string {
  return "0x" + word(result, n).toString(16).padStart(40, "0").slice(-40);
}

export const isZeroAddress = (a: string): boolean => /^0x0{40}$/i.test(a);
export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
