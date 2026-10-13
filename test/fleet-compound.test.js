/**
 * Compound III monitor (bots/compound-liquidator/monitor): selectors and topics re-derived with
 * an independent keccak, ABI round trips, the discount / profit maths, the read-only RPC guard,
 * the wrapper config, and one full --once run against a fake Base JSON-RPC node.
 * Imports the monitor's .ts files directly (Node >= 22.18 strips types).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SEL,
  TOPIC,
  call,
  decodeAggregate3Calls,
  decodeAggregate3Result,
  decodeString,
  encodeAggregate3,
  encodeAggregate3Result,
  encodeString,
  word,
  wordAt,
  addressAt,
} from "../bots/compound-liquidator/monitor/abi.ts";
import { buildMetrics, discountOf, estimateAccount, gasUsd } from "../bots/compound-liquidator/monitor/estimate.ts";
import { CHAINS, selectChains } from "../bots/compound-liquidator/monitor/markets.ts";
import { READ_ONLY, Rpc } from "../bots/compound-liquidator/monitor/rpc.ts";
import { main, resolveFeedUsd } from "../bots/compound-liquidator/monitor/monitor.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

// --- an independent keccak-256 (BigInt lanes; slow but only used on a few strings) ----------
const M64 = (1n << 64n) - 1n;
const RC = [
  0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n,
];
const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64);
function keccakF(s) {
  for (let r = 0; r < 24; r++) {
    const C = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let i = 0; i < 25; i++) s[i] ^= C[(i % 5 + 4) % 5] ^ rotl(C[(i % 5 + 1) % 5], 1);
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & M64 & B[((x + 2) % 5) + 5 * y]);
    s[0] ^= RC[r];
  }
}
function keccak256(str) {
  const bytes = Buffer.from(str, "utf8");
  const rate = 136;
  const p = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  p.set(bytes);
  p[bytes.length] ^= 0x01;
  p[p.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < p.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let v = 0n;
      for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(p[off + i * 8 + b]);
      s[i] ^= v;
    }
    keccakF(s);
  }
  let out = "";
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out += Number((s[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, "0");
  return "0x" + out;
}

test("keccak self-check, then every selector and topic the monitor uses", () => {
  assert.equal(keccak256(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  const sigs = {
    baseToken: "baseToken()",
    baseTokenPriceFeed: "baseTokenPriceFeed()",
    baseScale: "baseScale()",
    numAssets: "numAssets()",
    getAssetInfo: "getAssetInfo(uint8)",
    getPrice: "getPrice(address)",
    quoteCollateral: "quoteCollateral(address,uint256)",
    getCollateralReserves: "getCollateralReserves(address)",
    getReserves: "getReserves()",
    targetReserves: "targetReserves()",
    isLiquidatable: "isLiquidatable(address)",
    collateralBalanceOf: "collateralBalanceOf(address,address)",
    borrowBalanceOf: "borrowBalanceOf(address)",
    symbol: "symbol()",
    aggregate3: "aggregate3((address,bool,bytes)[])",
  };
  assert.deepEqual(Object.keys(sigs).sort(), Object.keys(SEL).sort(), "every selector is checked");
  for (const [k, sig] of Object.entries(sigs)) assert.equal(SEL[k], keccak256(sig).slice(0, 10), sig);
  assert.equal(TOPIC.withdraw, keccak256("Withdraw(address,address,uint256)"));
  assert.equal(TOPIC.supplyCollateral, keccak256("SupplyCollateral(address,address,address,uint256)"));
});

test("aggregate3 encodes and decodes both ways; strings and bytes32 symbols decode", () => {
  const calls = [
    { target: "0x" + "11".repeat(20), data: SEL.baseToken, allowFailure: true },
    { target: "0x" + "22".repeat(20), data: call(SEL.quoteCollateral, "0x" + "33".repeat(20), 10n ** 21n), allowFailure: true },
  ];
  const back = decodeAggregate3Calls(encodeAggregate3(calls));
  assert.deepEqual(back, calls);
  const res = [
    { success: true, returnData: "0x" + word(42n) },
    { success: false, returnData: "0x" },
  ];
  assert.deepEqual(decodeAggregate3Result(encodeAggregate3Result(res)), res);
  assert.equal(decodeString(encodeString("cbBTC")), "cbBTC");
  assert.equal(decodeString("0x" + Buffer.from("MKR").toString("hex").padEnd(64, "0")), "MKR");
  assert.equal(decodeString("0x1234"), "?");
  assert.equal(word(-1n), "f".repeat(64));
});

test("discount comes from quoteCollateral; the profit estimate subtracts swap cost and gas", () => {
  const m = {
    id: "base-usdc",
    chain: "base",
    comet: "0x",
    baseSymbol: "USDC",
    baseScale: 10n ** 6n,
    basePrice: 10n ** 8n,
    quoteBase: 1000n * 10n ** 6n,
    feedUsd: 1,
    forSale: true,
    assets: [{ asset: "0x" + "aa".repeat(20), symbol: "WETH", scale: 10n ** 18n, price: 2000n * 10n ** 8n, quote: (5n * 10n ** 17n * 100n) / 95n, reserves: 0n }],
  };
  assert.ok(Math.abs(discountOf(m, m.assets[0]) - 0.05) < 1e-5);
  assert.equal(discountOf(m, { ...m.assets[0], quote: 0n }), 0);

  const g = { absorbPerAccount: 120_000, absorbPerAsset: 45_000, flashBuySwap: 330_000 };
  assert.ok(Math.abs(gasUsd(g, 1, 1, 1, 10n ** 7n, 2000, 0.01) - (495_000 * 1e7 * 2000) / 1e18 - 0.01) < 1e-12);

  const f = estimateAccount(m, "0xb2", [{ asset: m.assets[0].asset, amount: 3n * 10n ** 18n }], g, 10n ** 7n, 2000, 0.01, 30);
  assert.ok(Math.abs(f.collateralUsd - 6000) < 1e-6);
  assert.ok(Math.abs(f.grossUsd - (300 - 18)) < 0.01);
  assert.ok(f.netUsd < f.grossUsd && f.netUsd > 281.9);
  assert.equal(f.pairs[0].pair, "WETH/USDC");

  const closed = estimateAccount({ ...m, forSale: false }, "0xb2", [{ asset: m.assets[0].asset, amount: 3n * 10n ** 18n }], g, 10n ** 7n, 2000, 0.01, 30);
  assert.equal(closed.grossUsd, 0, "nothing to buy while reserves are at target");
  assert.ok(closed.netUsd < 0, "absorb alone only costs gas");
});

test("auto-denominated markets get their USD scale from a USD market on the same chain", () => {
  const weth = "0x" + "aa".repeat(20);
  const views = [
    { baseSymbol: "USDC", basePrice: 10n ** 8n, assets: [{ asset: weth, symbol: "WETH", price: 2500n * 10n ** 8n }], feedUsd: 0 },
    { baseSymbol: "WETH", basePrice: 10n ** 8n, assets: [], feedUsd: 0 },
  ];
  const markets = [
    { def: { denom: "usd" }, base: "0x" + "bb".repeat(20) },
    { def: { denom: "auto" }, base: weth },
  ];
  assert.equal(resolveFeedUsd(markets, views, 0), 2500);
  assert.equal(views[0].feedUsd, 1);
  assert.equal(views[1].feedUsd, 2500);
});

test("metrics follow bots/CONTRACT.md and never report sends in detect mode", () => {
  const routes = Array.from({ length: 20 }, (_, i) => ({ chain: "base", market: `m${i}`, e: { pair: `T${i}/USDC`, collateralUsd: 100, discount: 0.05, grossUsd: i } }));
  const m = buildMetrics([{ chain: "base", markets: 5, borrowers: 1234, lastBlock: 99 }, { chain: "ethereum", markets: 0, borrowers: 0, lastBlock: 0, error: "no ETHEREUM_RPC_URL in bots/wrapper/.env" }], [], routes, 12.4);
  assert.equal(m.pnlUsd, 0);
  assert.equal(m.sends, 0);
  assert.equal(m.gasUsd, 0);
  assert.ok(m.routes.length <= 12);
  assert.equal(m.routes[0].usd, 19);
  assert.ok(Object.keys(m.metrics).length <= 12);
  for (const k of ["borrowersWatched", "absorbable", "bestUsd"]) assert.ok(k in m.metrics, k);
  assert.equal(m.metrics.borrowersWatched, 1234);
  assert.ok(m.detail.length <= 300);
  assert.match(m.detail, /no ETHEREUM_RPC_URL/);
});

test("the RPC client refuses anything that is not a read, before any request", async () => {
  assert.deepEqual([...READ_ONLY].sort(), ["eth_blockNumber", "eth_call", "eth_chainId", "eth_gasPrice", "eth_getCode", "eth_getLogs"]);
  const rpc = new Rpc("http://127.0.0.1:9");
  for (const m of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "eth_signTransaction", "personal_sign"]) {
    await assert.rejects(rpc.request(m, []), /refused/);
  }
  assert.equal(rpc.calls, 0);
  assert.throws(() => new Rpc("file:///etc/passwd"));
  const dir = join(ROOT, "bots/compound-liquidator/monitor");
  for (const f of readdirSync(dir)) {
    const src = readFileSync(join(dir, f), "utf8");
    assert.doesNotMatch(src, /PRIVATE_KEY|privateKey|new Wallet|absorb\(address,address\[\]\)|buyCollateral\(address,uint256/, f);
  }
});

test("chain selection defaults to Base and accepts per-chain overrides", () => {
  assert.deepEqual(selectChains({}).map((c) => c.name), ["base"]);
  const cs = selectChains({ COMPOUND_CHAINS: "base, arbitrum,nope", COMPOUND_CHECK_EVERY_BLOCKS_ARBITRUM: "8", COMPOUND_LOG_CHUNK_BASE: "-1" });
  assert.deepEqual(cs.map((c) => c.name), ["base", "arbitrum"]);
  assert.equal(cs[1].checkEveryBlocks, 8);
  assert.equal(cs[0].logChunk, CHAINS[0].logChunk, "bad numbers fall back to the default");
  for (const c of CHAINS) for (const m of c.markets) assert.match(m.comet, /^0x[0-9a-fA-F]{40}$/, m.id);
});

test("wrapper config: detect only, live and paper left empty", () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, "bots/wrapper/configs/compound-liquidator.json"), "utf8"));
  assert.equal(cfg.id, "compound-liquidator");
  assert.deepEqual(cfg.commands.live, []);
  assert.deepEqual(cfg.commands.paper, []);
  assert.deepEqual(cfg.commands.detect.slice(-2), ["--mode", "detect"]);
  assert.equal(cfg.metricsFile, "data/fleet/compound-liquidator.fleet-metrics.json");
});

test("only --mode detect exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cl-"));
  const code = await main(["--mode", "paper", "--metrics", join(dir, "m.json"), "--state", join(dir, "s.json")], {});
  assert.equal(code, 2);
});

// --- one full run against a fake Base node ------------------------------------------------

const A = (b) => "0x" + b.repeat(20);
const COMET = CHAINS[0].markets[0].comet.toLowerCase(); // base-usdc
const USDC = A("01"), WETH = A("02"), CBBTC = A("03");
const FEED_USDC = A("f0"), FEED_WETH = A("f1"), FEED_BTC = A("f2");
const B1 = A("b1"), B2 = A("b2"), B3 = A("b3");
const PRICES = { [FEED_USDC]: 10n ** 8n, [FEED_WETH]: 2000n * 10n ** 8n, [FEED_BTC]: 60000n * 10n ** 8n };
const ASSETS = [
  { asset: WETH, feed: FEED_WETH, scale: 10n ** 18n, sym: "WETH", reserves: 2n * 10n ** 18n },
  { asset: CBBTC, feed: FEED_BTC, scale: 10n ** 8n, sym: "cbBTC", reserves: 0n },
];
const hex = (v) => "0x" + word(v);
const addr = (a) => "0x" + a.slice(2).padStart(64, "0");

function answer(target, data) {
  const t = target.toLowerCase();
  const sel = data.slice(0, 10);
  const arg = (i) => data.slice(10 + i * 64, 10 + i * 64 + 64);
  const argAddr = (i) => "0x" + arg(i).slice(24);
  if (sel === SEL.symbol) return { [USDC]: "USDC", [WETH]: "WETH", [CBBTC]: "cbBTC" }[t] ? encodeString({ [USDC]: "USDC", [WETH]: "WETH", [CBBTC]: "cbBTC" }[t]) : null;
  if (t !== COMET) return null;
  switch (sel) {
    case SEL.baseToken: return addr(USDC);
    case SEL.baseTokenPriceFeed: return addr(FEED_USDC);
    case SEL.baseScale: return hex(10n ** 6n);
    case SEL.numAssets: return hex(2n);
    case SEL.getAssetInfo: {
      const a = ASSETS[Number(BigInt("0x" + arg(0)))];
      return "0x" + word(0n) + addr(a.asset).slice(2) + addr(a.feed).slice(2) + word(a.scale) + word(0n).repeat(4);
    }
    case SEL.getPrice: return hex(PRICES[argAddr(0)] ?? 0n);
    case SEL.quoteCollateral: {
      const a = ASSETS.find((x) => x.asset === argAddr(0));
      const amt = BigInt("0x" + arg(1));
      const fair = (amt * PRICES[FEED_USDC] * a.scale) / (PRICES[a.feed] * 10n ** 6n);
      return hex((fair * 100n) / 95n);
    }
    case SEL.getCollateralReserves: return hex(ASSETS.find((x) => x.asset === argAddr(0)).reserves);
    case SEL.getReserves: return hex(1000n * 10n ** 6n);
    case SEL.targetReserves: return hex(5_000_000n * 10n ** 6n);
    case SEL.isLiquidatable: return hex(argAddr(0) === B2 ? 1n : 0n);
    case SEL.collateralBalanceOf: return hex(argAddr(0) === B2 && argAddr(1) === WETH ? 3n * 10n ** 18n : 0n);
    default: return null;
  }
}

function fakeNode() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      seen.push(method);
      let result;
      if (method === "eth_chainId") result = "0x2105";
      else if (method === "eth_blockNumber") result = "0x100000";
      else if (method === "eth_gasPrice") result = "0x989680"; // 0.01 gwei
      else if (method === "eth_getCode") result = params[0].toLowerCase() === COMET ? "0x6080" : "0x";
      else if (method === "eth_getLogs") {
        const f = params[0];
        result = f.address.toLowerCase() !== COMET ? [] : [
          { address: COMET, topics: [TOPIC.withdraw, addr(B1), addr(B1)], data: "0x", blockNumber: f.fromBlock },
          { address: COMET, topics: [TOPIC.supplyCollateral, addr(B2), addr(B2), addr(WETH)], data: "0x", blockNumber: f.fromBlock },
          { address: COMET, topics: [TOPIC.supplyCollateral, addr(B2), addr(B3), addr(CBBTC)], data: "0x", blockNumber: f.fromBlock },
        ];
      } else if (method === "eth_call") {
        const calls = decodeAggregate3Calls(params[0].data);
        result = encodeAggregate3Result(calls.map((c) => {
          const r = answer(c.target, c.data);
          return r ? { success: true, returnData: r } : { success: false, returnData: "0x" };
        }));
      } else {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "not allowed in test" } }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test("one --once run on a fake Base node: drops markets without code, finds the absorbable account", async () => {
  const { server, seen, url } = await fakeNode();
  const dir = mkdtempSync(join(tmpdir(), "cl-"));
  const files = { metrics: join(dir, "metrics.json"), state: join(dir, "state.json"), finds: join(dir, "finds.jsonl") };
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(s);
  try {
    const code = await main(["--mode", "detect", "--once", "--metrics", files.metrics, "--state", files.state, "--finds", files.finds], {
      BASE_RPC_URL: url,
      COMPOUND_BACKFILL_BLOCKS_BASE: "1000",
    });
    assert.equal(code, 0);
  } finally {
    console.log = orig;
    server.close();
  }
  assert.ok(seen.every((m) => READ_ONLY.has(m)), "only read methods reached the node");
  assert.equal(logs.filter((l) => l.includes("market.dropped")).length, 4, "four markets without code are dropped");

  const m = JSON.parse(readFileSync(files.metrics, "utf8"));
  assert.equal(m.sends, 0);
  assert.equal(m.metrics.borrowersWatched, 3);
  assert.equal(m.metrics.absorbable, 1);
  assert.equal(m.metrics.markets, 1);
  assert.ok(m.metrics.bestUsd > 281 && m.metrics.bestUsd < 282.1, `bestUsd ${m.metrics.bestUsd}`);
  assert.ok(m.metrics.forSaleUsd > 187 && m.metrics.forSaleUsd < 188.1, `forSaleUsd ${m.metrics.forSaleUsd}`);
  const pairs = m.routes.map((r) => `${r.pair} ${r.venues[1]}`).sort();
  assert.deepEqual(pairs, ["WETH/USDC base-usdc", "WETH/USDC base-usdc:reserves"]);
  assert.match(m.detail, /base 3 borrowers\/1 markets @1048576; 1 absorbable/);

  const finds = readFileSync(files.finds, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(finds.length, 1);
  assert.equal(finds[0].account, B2);
  assert.equal(finds[0].event, "absorbable");

  const state = JSON.parse(readFileSync(files.state, "utf8"));
  assert.equal(state.chains.base.lastBlock, 0x100000);
  assert.deepEqual(state.chains.base.borrowers["base-usdc"].sort(), [B1, B2, B3]);
});

test("without an RPC URL it reports the missing setting instead of crashing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cl-"));
  const orig = console.log;
  console.log = () => {};
  try {
    const code = await main(["--mode", "detect", "--once", "--metrics", join(dir, "m.json"), "--state", join(dir, "s.json"), "--finds", join(dir, "f.jsonl")], {});
    assert.equal(code, 0);
  } finally {
    console.log = orig;
  }
  const m = JSON.parse(readFileSync(join(dir, "m.json"), "utf8"));
  assert.match(m.detail, /no BASE_RPC_URL in bots\/wrapper\/\.env/);
  assert.equal(m.metrics.borrowersWatched, 0);
});

// keep the helpers referenced (they are part of the module's public surface)
void wordAt;
void addressAt;
