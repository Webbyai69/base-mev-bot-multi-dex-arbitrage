/**
 * Minimal Keccak-256 (the pre-NIST padding Ethereum uses), written for this monitor so it has no
 * npm dependencies. Only used at start-up to derive the handful of 4-byte function selectors it
 * calls, so it favours clarity (BigInt lanes) over speed.
 */
const MASK = (1n << 64n) - 1n;
const RC: bigint[] = [];
const ROT: number[][] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

(function roundConstants() {
  let r = 1;
  for (let i = 0; i < 24; i++) {
    let c = 0n;
    for (let j = 0; j < 7; j++) {
      r = ((r << 1) ^ ((r >> 7) * 0x71)) % 256;
      if (r & 2) c ^= 1n << ((1n << BigInt(j)) - 1n);
    }
    RC.push(c);
  }
})();

const rotl = (x: bigint, n: number): bigint => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK);

function permute(s: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const c: bigint[] = [];
    for (let x = 0; x < 5; x++) c.push(s[x]! ^ s[x + 5]! ^ s[x + 10]! ^ s[x + 15]! ^ s[x + 20]!);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 5; y++) s[x + 5 * y] = s[x + 5 * y]! ^ d;
    }
    const b: bigint[] = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y]!, ROT[x]![y]!);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y]! ^ (~b[((x + 1) % 5) + 5 * y]! & MASK & b[((x + 2) % 5) + 5 * y]!);
    s[0] = s[0]! ^ RC[round]!;
  }
}

/** Keccak-256 of a UTF-8 string or bytes, as 0x-prefixed hex. */
export function keccak256(input: string | Uint8Array): string {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const rate = 136;
  const padLen = rate - (data.length % rate);
  const msg = new Uint8Array(data.length + padLen);
  msg.set(data);
  msg[data.length] = msg[data.length]! ^ 0x01;
  msg[msg.length - 1] = msg[msg.length - 1]! ^ 0x80;
  const s: bigint[] = new Array(25).fill(0n);
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(msg[off + i * 8 + k]!);
      s[i] = s[i]! ^ lane;
    }
    permute(s);
  }
  let hex = "0x";
  for (let i = 0; i < 4; i++) {
    let lane = s[i]!;
    for (let k = 0; k < 8; k++) {
      hex += Number(lane & 0xffn).toString(16).padStart(2, "0");
      lane >>= 8n;
    }
  }
  return hex;
}

/** The 4-byte selector of a Solidity signature such as "slot0()". */
export const selector = (signature: string): string => keccak256(signature).slice(0, 10);
