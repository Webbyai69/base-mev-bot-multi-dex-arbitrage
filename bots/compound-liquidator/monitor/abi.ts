/**
 * Minimal ABI encoding for the read-only calls the monitor makes. No dependencies, so the
 * monitor runs with plain Node (>= 22.18, which runs .ts files directly).
 *
 * Selectors and topics were computed with Foundry's `cast sig` / `cast keccak`; the test
 * file pins them, and docs/fleet/compound-liquidator.md lists the commands to re-check.
 * There is deliberately no selector for absorb or buyCollateral here: the monitor never
 * builds a transaction.
 */

export const SEL = {
  baseToken: "0xc55dae63",
  baseTokenPriceFeed: "0xe7dad6bd",
  baseScale: "0x44c1e5eb",
  numAssets: "0xa46fe83b",
  getAssetInfo: "0xc8c7fe6b", // getAssetInfo(uint8)
  getPrice: "0x41976e09", // getPrice(address)
  quoteCollateral: "0x7ac88ed1", // quoteCollateral(address,uint256)
  getCollateralReserves: "0x9ff567f8", // getCollateralReserves(address)
  getReserves: "0x0902f1ac", // getReserves() -> int256
  targetReserves: "0x32176c49",
  isLiquidatable: "0x042e02cf", // isLiquidatable(address)
  collateralBalanceOf: "0x5c2549ee", // collateralBalanceOf(address,address)
  borrowBalanceOf: "0x374c49b4", // borrowBalanceOf(address)
  symbol: "0x95d89b41",
  aggregate3: "0x82ad56cb", // Multicall3.aggregate3((address,bool,bytes)[])
} as const;

export const TOPIC = {
  /** Withdraw(address indexed src, address indexed to, uint256 amount): src borrows or withdraws base */
  withdraw: "0x9b1bfa7fa9ee420a16e124f794c35ac9f90472acc99140eb2f6447c714cad8eb",
  /** SupplyCollateral(address indexed from, address indexed dst, address indexed asset, uint256 amount) */
  supplyCollateral: "0xfa56f7b24f17183d81894d3ac2ee654e3c26388d17a28dbd9549b8114304e1f4",
} as const;

/** Multicall3: same address on Base, Ethereum and Arbitrum. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

export function strip0x(h: string): string {
  return h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
}

export function word(v: bigint): string {
  if (v < 0n) v = (1n << 256n) + v;
  return v.toString(16).padStart(64, "0");
}

export function encAddress(a: string): string {
  const h = strip0x(a).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(h)) throw new Error(`bad address ${a}`);
  return h.padStart(64, "0");
}

export function call(selector: string, ...args: (string | bigint | number)[]): string {
  let out = selector;
  for (const a of args) {
    out += typeof a === "string" ? encAddress(a) : word(BigInt(a));
  }
  return out;
}

export function wordAt(hex: string, i: number): bigint {
  const h = strip0x(hex);
  const w = h.slice(i * 64, i * 64 + 64);
  if (w.length !== 64) throw new Error(`short return data (word ${i})`);
  return BigInt("0x" + w);
}

export function intAt(hex: string, i: number): bigint {
  const v = wordAt(hex, i);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
}

export function addressAt(hex: string, i: number): string {
  return "0x" + strip0x(hex).slice(i * 64 + 24, i * 64 + 64);
}

/** ABI string, or a bytes32 symbol (old tokens). Never throws: "?" when unreadable. */
export function decodeString(hex: string): string {
  const h = strip0x(hex);
  try {
    if (h.length >= 128) {
      const off = Number(wordAt(h, 0));
      const len = Number(BigInt("0x" + h.slice(off * 2, off * 2 + 64)));
      if (off === 32 && len <= 64) {
        return Buffer.from(h.slice(off * 2 + 64, off * 2 + 64 + len * 2), "hex").toString("utf8").replace(/[^\x20-\x7e]/g, "");
      }
    }
    if (h.length === 64) return Buffer.from(h, "hex").toString("utf8").replace(/\0+$/, "").replace(/[^\x20-\x7e]/g, "");
  } catch {
    /* fall through */
  }
  return "?";
}

export interface Call3 {
  target: string;
  data: string;
  allowFailure?: boolean;
}

export interface Result3 {
  success: boolean;
  returnData: string;
}

function bytesTail(data: string): string {
  const d = strip0x(data);
  const padded = d.padEnd(Math.ceil(d.length / 64) * 64, "0");
  return word(BigInt(d.length / 2)) + padded;
}

export function encodeAggregate3(calls: Call3[]): string {
  const elems = calls.map((c) => encAddress(c.target) + word(c.allowFailure === false ? 0n : 1n) + word(96n) + bytesTail(c.data));
  let offsets = "";
  let pos = 32 * calls.length;
  for (const e of elems) {
    offsets += word(BigInt(pos));
    pos += e.length / 2;
  }
  return SEL.aggregate3 + word(32n) + word(BigInt(calls.length)) + offsets + elems.join("");
}

export function decodeAggregate3Result(hex: string): Result3[] {
  const h = strip0x(hex);
  const arr = Number(wordAt(h, 0)) * 2;
  const n = Number(BigInt("0x" + h.slice(arr, arr + 64)));
  const base = arr + 64;
  const out: Result3[] = [];
  for (let i = 0; i < n; i++) {
    const elOff = base + Number(BigInt("0x" + h.slice(base + i * 64, base + i * 64 + 64))) * 2;
    const success = BigInt("0x" + h.slice(elOff, elOff + 64)) !== 0n;
    const bOff = elOff + Number(BigInt("0x" + h.slice(elOff + 64, elOff + 128))) * 2;
    const len = Number(BigInt("0x" + h.slice(bOff, bOff + 64)));
    out.push({ success, returnData: "0x" + h.slice(bOff + 64, bOff + 64 + len * 2) });
  }
  return out;
}

// --- the other direction, used by the tests' fake chain --------------------------------

export function decodeAggregate3Calls(calldata: string): Call3[] {
  const h = strip0x(calldata).slice(8);
  const arr = Number(wordAt(h, 0)) * 2;
  const n = Number(BigInt("0x" + h.slice(arr, arr + 64)));
  const base = arr + 64;
  const out: Call3[] = [];
  for (let i = 0; i < n; i++) {
    const elOff = base + Number(BigInt("0x" + h.slice(base + i * 64, base + i * 64 + 64))) * 2;
    const target = "0x" + h.slice(elOff + 24, elOff + 64);
    const allowFailure = BigInt("0x" + h.slice(elOff + 64, elOff + 128)) !== 0n;
    const bOff = elOff + Number(BigInt("0x" + h.slice(elOff + 128, elOff + 192))) * 2;
    const len = Number(BigInt("0x" + h.slice(bOff, bOff + 64)));
    out.push({ target, allowFailure, data: "0x" + h.slice(bOff + 64, bOff + 64 + len * 2) });
  }
  return out;
}

export function encodeAggregate3Result(results: Result3[]): string {
  const elems = results.map((r) => word(r.success ? 1n : 0n) + word(64n) + bytesTail(r.returnData));
  let offsets = "";
  let pos = 32 * results.length;
  for (const e of elems) {
    offsets += word(BigInt(pos));
    pos += e.length / 2;
  }
  return "0x" + word(32n) + word(BigInt(results.length)) + offsets + elems.join("");
}

export function encodeString(s: string): string {
  return "0x" + word(32n) + bytesTail(Buffer.from(s, "utf8").toString("hex"));
}
