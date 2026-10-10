/**
 * A tiny in-memory "Base" for tests: a JSON-RPC HTTP server with Multicall3,
 * factories, pools, routers, tokens and the gas oracle implemented as call
 * handlers. Pools use the real constant-product formulas so the bot's maths
 * can be checked against "on-chain" quotes, and blocks can be advanced with
 * scripted reserve changes and Swap logs.
 */
import { createServer } from "node:http";
import { Interface, AbiCoder, keccak256, toUtf8Bytes, id } from "ethers";

const abi = AbiCoder.defaultAbiCoder();
const CHAIN_ID = 8453;
export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
export const GAS_ORACLE = "0x420000000000000000000000000000000000000f";

const ifaces = {
  multicall: new Interface(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])", "function getBlockNumber() view returns (uint256)"]),
  erc20: new Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]),
  v2factory: new Interface(["function allPairsLength() view returns (uint256)", "function allPairs(uint256) view returns (address)", "function getPair(address,address) view returns (address)"]),
  aerofactory: new Interface(["function allPoolsLength() view returns (uint256)", "function allPools(uint256) view returns (address)", "function getFee(address,bool) view returns (uint256)", "function getPool(address,address,bool) view returns (address)"]),
  pair: new Interface(["function token0() view returns (address)", "function token1() view returns (address)", "function getReserves() view returns (uint112,uint112,uint32)", "function stable() view returns (bool)", "function getAmountOut(uint256,address) view returns (uint256)", "function factory() view returns (address)", "function fee() view returns (uint24)"]),
  router: new Interface(["function getAmountsOut(uint256,address[]) view returns (uint256[])"]),
  oracle: new Interface(["function getL1Fee(bytes) view returns (uint256)", "function l1BaseFee() view returns (uint256)"]),
};

const SIMULATE_SELECTOR = new Interface(["function simulate(address,address,address,uint256,uint256,uint256,bool)"]).getFunction("simulate").selector;
export const TOPIC_SWAP_V2 = id("Swap(address,uint256,uint256,uint256,uint256,address)");
export const TOPIC_SWAP_AERO = id("Swap(address,address,uint256,uint256,uint256,uint256)");
// Real pools emit Sync with the new reserves whenever they change (Uniswap V2 forks: uint112, Aerodrome: uint256).
export const TOPIC_SYNC_V2 = id("Sync(uint112,uint112)");
export const TOPIC_SYNC_AERO = id("Sync(uint256,uint256)");

function v2Out(amountIn, rIn, rOut, feePpm) {
  const withFee = amountIn * BigInt(1_000_000 - feePpm);
  return (withFee * rOut) / (rIn * 1_000_000n + withFee);
}
function aeroOut(amountIn, rIn, rOut, feeBps) {
  const inAfter = amountIn - (amountIn * BigInt(feeBps)) / 10_000n;
  return (inAfter * rOut) / (rIn + inAfter);
}

export class MockChain {
  constructor() {
    this.block = 1000;
    this.contracts = new Map(); // address -> (calldata, block) => hex
    this.tokens = new Map();
    this.pools = new Map(); // address -> pool state
    this.factories = new Map(); // address -> { kind, pools: [], router }
    this.logsByBlock = new Map();
    /** Logs to include in the next block (from setReserves). */
    this.queuedLogs = [];
    this.txsByBlock = new Map();
    this.baseFee = 10_000_000n; // 0.01 gwei
    this.l1Fee = 20_000_000_000_000n; // 0.00002 ETH
    this.requests = [];
    this.httpCount = 0;
    /** Tokens that skim 5% on every transfer (only visible to real execution / simulation). */
    this.feeOnTransfer = new Set();
    /** Max eth_getLogs block range (0 = unlimited), like Alchemy's free tier (10). */
    this.logsRangeLimit = 0;
    /** Simulate a rate-limited public endpoint: every Nth request fails ("jsonrpc" error or "http" 429). */
    this.rateLimitEvery = 0;
    this.rateLimitMode = "jsonrpc";
    this.rateLimited = 0;
    this.gasOracle();
    this.contracts.set(MULTICALL3, (data) => {
      if (data.slice(0, 10) === ifaces.multicall.getFunction("getBlockNumber").selector) return abi.encode(["uint256"], [this.block]);
      return this.multicall(data);
    });
  }

  gasOracle() {
    this.contracts.set(GAS_ORACLE, (data) => {
      const sel = data.slice(0, 10);
      if (sel === ifaces.oracle.getFunction("getL1Fee").selector) return abi.encode(["uint256"], [this.l1Fee]);
      if (sel === ifaces.oracle.getFunction("l1BaseFee").selector) return abi.encode(["uint256"], [1_000_000_000n]);
      throw new Error("oracle: unknown selector");
    });
  }

  addToken(address, symbol, decimals) {
    const a = address.toLowerCase();
    this.tokens.set(a, { symbol, decimals });
    this.contracts.set(a, (data) => {
      const sel = data.slice(0, 10);
      if (sel === ifaces.erc20.getFunction("symbol").selector) return abi.encode(["string"], [symbol]);
      if (sel === ifaces.erc20.getFunction("decimals").selector) return abi.encode(["uint8"], [decimals]);
      throw new Error("token: unknown selector");
    });
  }

  addFactory(address, kind, router, lookupOnly = false) {
    const a = address.toLowerCase();
    const f = { kind, pools: [], router: router.toLowerCase(), lookupOnly };
    this.factories.set(a, f);
    this.contracts.set(a, (data) => {
      const sel = data.slice(0, 10);
      if (kind === "aerodrome") {
        if (sel === ifaces.aerofactory.getFunction("allPoolsLength").selector) return abi.encode(["uint256"], [f.pools.length]);
        if (sel === ifaces.aerofactory.getFunction("allPools").selector) {
          const [i] = ifaces.aerofactory.decodeFunctionData("allPools", data);
          return abi.encode(["address"], [f.pools[Number(i)]]);
        }
        if (sel === ifaces.aerofactory.getFunction("getFee").selector) {
          const [pool] = ifaces.aerofactory.decodeFunctionData("getFee", data);
          return abi.encode(["uint256"], [this.pools.get(pool.toLowerCase()).feeBps]);
        }
        if (sel === ifaces.aerofactory.getFunction("getPool").selector) {
          const [t0, t1, stable] = ifaces.aerofactory.decodeFunctionData("getPool", data);
          const key = [t0.toLowerCase(), t1.toLowerCase()].sort().join("-");
          const found = f.pools.find((p) => this.pools.get(p).stable === stable && [this.pools.get(p).token0, this.pools.get(p).token1].sort().join("-") === key);
          return abi.encode(["address"], [found ?? "0x0000000000000000000000000000000000000000"]);
        }
      } else {
        if (sel === ifaces.v2factory.getFunction("allPairsLength").selector) return abi.encode(["uint256"], [f.lookupOnly ? 123456 : f.pools.length]);
        if (sel === ifaces.v2factory.getFunction("allPairs").selector) {
          const [i] = ifaces.v2factory.decodeFunctionData("allPairs", data);
          return abi.encode(["address"], [f.pools[Number(i)]]);
        }
        if (sel === ifaces.v2factory.getFunction("getPair").selector) {
          const [t0, t1] = ifaces.v2factory.decodeFunctionData("getPair", data);
          const key = [t0.toLowerCase(), t1.toLowerCase()].sort().join("-");
          const found = f.pools.find((p) => [this.pools.get(p).token0, this.pools.get(p).token1].sort().join("-") === key);
          return abi.encode(["address"], [found ?? "0x0000000000000000000000000000000000000000"]);
        }
      }
      throw new Error("factory: unknown selector");
    });
    this.contracts.set(f.router, (data) => {
      const sel = data.slice(0, 10);
      if (sel === ifaces.router.getFunction("getAmountsOut").selector) {
        const [amountIn, path] = ifaces.router.decodeFunctionData("getAmountsOut", data);
        const key = [path[0].toLowerCase(), path[1].toLowerCase()].sort().join("-");
        const poolAddr = f.pools.find((p) => [this.pools.get(p).token0, this.pools.get(p).token1].sort().join("-") === key);
        if (!poolAddr) throw new Error("router: no pool");
        const out = this.quote(this.pools.get(poolAddr), path[0].toLowerCase(), amountIn);
        return abi.encode(["uint256[]"], [[amountIn, out]]);
      }
      throw new Error("router: unknown selector");
    });
  }

  quote(pool, tokenIn, amountIn) {
    const zeroIn = tokenIn === pool.token0;
    const rIn = zeroIn ? pool.reserve0 : pool.reserve1;
    const rOut = zeroIn ? pool.reserve1 : pool.reserve0;
    return pool.kind === "aerodrome" ? aeroOut(amountIn, rIn, rOut, pool.feeBps) : v2Out(amountIn, rIn, rOut, pool.feePpm);
  }

  addPool(address, factory, token0, token1, reserve0, reserve1, opts = {}) {
    const a = address.toLowerCase();
    const f = this.factories.get(factory.toLowerCase());
    const pool = { address: a, kind: f.kind, factory: factory.toLowerCase(), token0: token0.toLowerCase(), token1: token1.toLowerCase(), reserve0, reserve1, feePpm: opts.feePpm ?? 3000, feeBps: opts.feeBps ?? 30, stable: opts.stable ?? false };
    this.pools.set(a, pool);
    f.pools.push(a);
    this.contracts.set(a, (data) => {
      const sel = data.slice(0, 10);
      const g = (n) => ifaces.pair.getFunction(n).selector;
      if (sel === g("token0")) return abi.encode(["address"], [pool.token0]);
      if (sel === g("token1")) return abi.encode(["address"], [pool.token1]);
      if (sel === g("factory")) return abi.encode(["address"], [pool.factory]);
      if (sel === g("getReserves")) return abi.encode(["uint256", "uint256", "uint256"], [pool.reserve0, pool.reserve1, 0]);
      if (pool.kind === "aerodrome") {
        if (sel === g("stable")) return abi.encode(["bool"], [pool.stable]);
        if (sel === g("getAmountOut")) {
          const [amountIn, tokenIn] = ifaces.pair.decodeFunctionData("getAmountOut", data);
          return abi.encode(["uint256"], [this.quote(pool, tokenIn.toLowerCase(), amountIn)]);
        }
      }
      throw new Error(`pool: unknown selector ${sel}`);
    });
    return pool;
  }

  /** A block in which every pool trades a little (activity-based discovery needs to see a Swap). */
  activityBlock() {
    const pools = [...this.pools.values()];
    const txs = pools.map((p, i) => ({ hash: "0x" + (i + 1).toString(16).padStart(64, "0"), from: "0x" + "77".repeat(20), to: "0x" + "88".repeat(20) }));
    const swaps = pools.map((p, i) => {
      const amountIn = p.reserve0 / 1000n > 0n ? p.reserve0 / 1000n : 1n;
      return { tx: txs[i].hash, pool: p.address, from: "0x" + "88".repeat(20), tokenIn: p.token0, amountIn, amountOut: this.quote(p, p.token0, amountIn) };
    });
    return this.nextBlock({ txs, swaps });
  }

  /** Advance one block, optionally with scripted swap logs and txs. */
  nextBlock({ swaps = [], txs = [] } = {}) {
    this.block++;
    const logs = [];
    let logIndex = 0;
    const txList = txs.map((t, i) => ({ hash: t.hash, from: t.from.toLowerCase(), to: t.to ? t.to.toLowerCase() : null, transactionIndex: "0x" + i.toString(16) }));
    for (const s of swaps) {
      const pool = this.pools.get(s.pool.toLowerCase());
      const zeroIn = s.tokenIn.toLowerCase() === pool.token0;
      const a0In = zeroIn ? s.amountIn : 0n, a1In = zeroIn ? 0n : s.amountIn;
      const a0Out = zeroIn ? 0n : s.amountOut, a1Out = zeroIn ? s.amountOut : 0n;
      const txIdx = txList.findIndex((t) => t.hash === s.tx);
      const pad = (x) => "0x" + x.toLowerCase().replace("0x", "").padStart(64, "0");
      let log;
      if (pool.kind === "aerodrome") {
        log = { address: pool.address, topics: [TOPIC_SWAP_AERO, pad(s.from), pad(s.to ?? s.from)], data: abi.encode(["uint256", "uint256", "uint256", "uint256"], [a0In, a1In, a0Out, a1Out]) };
      } else {
        log = { address: pool.address, topics: [TOPIC_SWAP_V2, pad(s.from), pad(s.to ?? s.from)], data: abi.encode(["uint256", "uint256", "uint256", "uint256"], [a0In, a1In, a0Out, a1Out]) };
      }
      const meta = { blockNumber: "0x" + this.block.toString(16), blockHash: this.blockHash(this.block), transactionHash: s.tx, transactionIndex: "0x" + txIdx.toString(16), removed: false };
      if (s.applyToReserves) {
        if (zeroIn) { pool.reserve0 += s.amountIn; pool.reserve1 -= s.amountOut; } else { pool.reserve1 += s.amountIn; pool.reserve0 -= s.amountOut; }
        // Like the real contracts: _update() emits Sync with the new reserves, then Swap.
        logs.push({ ...this.syncLog(pool), ...meta, logIndex: "0x" + (logIndex++).toString(16) });
      }
      logs.push({ ...log, ...meta, logIndex: "0x" + (logIndex++).toString(16) });
    }
    for (const q of this.queuedLogs.splice(0)) {
      logs.push({ ...q, blockNumber: "0x" + this.block.toString(16), blockHash: this.blockHash(this.block), transactionHash: "0x" + "ee".repeat(32), transactionIndex: "0x0", logIndex: "0x" + (logIndex++).toString(16), removed: false });
    }
    this.logsByBlock.set(this.block, logs);
    this.txsByBlock.set(this.block, txList);
    return this.block;
  }

  syncLog(pool) {
    return pool.kind === "aerodrome"
      ? { address: pool.address, topics: [TOPIC_SYNC_AERO], data: abi.encode(["uint256", "uint256"], [pool.reserve0, pool.reserve1]) }
      : { address: pool.address, topics: [TOPIC_SYNC_V2], data: abi.encode(["uint112", "uint112"], [pool.reserve0, pool.reserve1]) };
  }

  /** Change a pool's reserves the way a mint/burn/sync would: the Sync log lands in the next block. */
  setReserves(address, reserve0, reserve1) {
    const pool = this.pools.get(address.toLowerCase());
    pool.reserve0 = reserve0;
    pool.reserve1 = reserve1;
    this.queuedLogs.push(this.syncLog(pool));
  }

  blockHash(n) {
    return keccak256(toUtf8Bytes("block" + n));
  }

  blockObject(n, full) {
    const txs = this.txsByBlock.get(n) ?? [];
    return {
      hash: this.blockHash(n), parentHash: this.blockHash(n - 1), number: "0x" + n.toString(16), timestamp: "0x" + (1_700_000_000 + n * 2).toString(16),
      nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x5208", miner: "0x4200000000000000000000000000000000000011", extraData: "0x",
      baseFeePerGas: "0x" + this.baseFee.toString(16), transactions: full ? txs.map((t) => ({ ...t, blockNumber: "0x" + n.toString(16), blockHash: this.blockHash(n), input: "0x", value: "0x0", nonce: "0x0", gas: "0x5208", gasPrice: "0x1" })) : txs.map((t) => t.hash),
      stateRoot: this.blockHash(n), receiptsRoot: this.blockHash(n), transactionsRoot: this.blockHash(n), sha3Uncles: this.blockHash(0), logsBloom: "0x" + "0".repeat(512), size: "0x100", totalDifficulty: "0x0", uncles: [], mixHash: this.blockHash(n),
    };
  }

  /**
   * Emulate an ArbExecutor.simulate() call made through a state override: the real bot injects the
   * contract's bytecode; this mock has no EVM, so it reproduces the contract's arithmetic with its own
   * pool formulas (and a fee-on-transfer trap). Always throws, like the contract: a revert with data.
   */
  simulateOverride(data) {
    if (data.slice(0, 10) !== SIMULATE_SELECTOR) throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
    const [buyPool, sellPool, tokenIn, amountIn, amountMid, amountOut] = abi.decode(["address", "address", "address", "uint256", "uint256", "uint256", "bool"], "0x" + data.slice(10));
    const buy = this.pools.get(buyPool.toLowerCase()), sell = this.pools.get(sellPool.toLowerCase());
    const revert = (payload) => { throw Object.assign(new Error("execution reverted"), { code: 3, data: payload }); };
    if (!buy || !sell) revert("0x");
    const tin = tokenIn.toLowerCase();
    const tokenMid = tin === buy.token0 ? buy.token1 : buy.token0;
    // fee-on-transfer tokens deliver less than the pool paid out -> hop 2 breaks the K check
    const taxed = (tok, amt) => (this.feeOnTransfer.has(tok) ? amt - amt / 20n : amt);
    const mid = this.quote(buy, tin, taxed(tin, amountIn));
    if (mid < amountMid) revert("0x" + "08c379a0" + abi.encode(["string"], ["K"]).slice(2));
    const out = this.quote(sell, tokenMid, taxed(tokenMid, amountMid));
    if (out < amountOut) revert("0x" + "08c379a0" + abi.encode(["string"], ["K"]).slice(2));
    const received = taxed(tin, amountOut);
    const profit = received - amountIn;
    if (profit <= 0n) revert("0x4e88422a" + abi.encode(["uint256", "uint256"], [0n, 1n]).slice(2));
    revert("0x6f149831" + abi.encode(["uint256"], [profit]).slice(2));
  }

  multicall(data, overrides) {
    const [calls] = ifaces.multicall.decodeFunctionData("aggregate3", data);
    const results = calls.map((c) => {
      const target = c.target.toLowerCase();
      try {
        if (overrides && overrides[target] && overrides[target].code && !this.contracts.has(target)) this.simulateOverride(c.callData);
        return { success: true, returnData: this.dispatch(target, c.callData) };
      } catch (err) {
        if (!c.allowFailure) throw err;
        return { success: false, returnData: typeof err.data === "string" ? err.data : "0x" };
      }
    });
    return ifaces.multicall.encodeFunctionResult("aggregate3", [results]);
  }

  dispatch(to, data) {
    const h = this.contracts.get(to);
    if (!h) throw new Error(`no contract at ${to}`);
    return h(data);
  }

  handle(req) {
    const { method, params } = req;
    this.requests.push(method);
    if (this.rateLimitEvery && this.rateLimitMode === "jsonrpc" && this.requests.length % this.rateLimitEvery === 0) {
      this.rateLimited++;
      throw Object.assign(new Error("over rate limit"), { code: -32016 });
    }
    switch (method) {
      case "eth_chainId": return "0x" + CHAIN_ID.toString(16);
      case "net_version": return String(CHAIN_ID);
      case "eth_blockNumber": return "0x" + this.block.toString(16);
      case "eth_call": {
        const [tx, , overrides] = params;
        const to = tx.to.toLowerCase();
        // Emulate an ArbExecutor.simulate() call made through a state override (see simulateOverride).
        if (overrides && overrides[to] && overrides[to].code && !this.contracts.has(to)) this.simulateOverride(tx.data ?? tx.input);
        // A batch of simulations: Multicall3 under the same state override, as a real node runs it.
        if (overrides && to === MULTICALL3) return this.multicall(tx.data ?? tx.input, overrides);
        return this.dispatch(to, tx.data ?? tx.input);
      }
      case "eth_getBlockByNumber": {
        const [tag, full] = params;
        const n = tag === "latest" ? this.block : Number(tag);
        if (n > this.block) return null;
        return this.blockObject(n, full);
      }
      case "eth_getTransactionReceipt": {
        const [hash] = params;
        for (const [n, txs] of this.txsByBlock) {
          const t = txs.find((x) => x.hash === hash);
          if (t) return { transactionHash: hash, blockNumber: "0x" + n.toString(16), gasUsed: "0x30d40", effectiveGasPrice: "0x" + this.baseFee.toString(16), l1Fee: "0x" + (this.l1Fee / 4n).toString(16), status: "0x1" };
        }
        return null;
      }
      case "eth_getLogs": {
        const [f] = params;
        const from = Number(f.fromBlock), to = Number(f.toBlock);
        if (this.logsRangeLimit && to - from + 1 > this.logsRangeLimit) {
          throw Object.assign(new Error(`Under the Free tier plan, you can make eth_getLogs requests with up to a ${this.logsRangeLimit} block range. Upgrade to PAYG for expanded block range.`), { code: -32600 });
        }
        const wanted = f.topics?.[0];
        const out = [];
        for (let n = from; n <= to; n++) for (const l of this.logsByBlock.get(n) ?? []) {
          if (!wanted || (Array.isArray(wanted) ? wanted.includes(l.topics[0]) : wanted === l.topics[0])) out.push(l);
        }
        return out;
      }
      case "eth_getBlockReceipts": throw Object.assign(new Error("the method eth_getBlockReceipts does not exist/is not available"), { code: -32601 });
      case "eth_feeHistory": return { baseFeePerGas: ["0x" + this.baseFee.toString(16)], gasUsedRatio: [0.5], oldestBlock: "0x" + this.block.toString(16) };
      case "eth_gasPrice": return "0x" + this.baseFee.toString(16);
      case "eth_maxPriorityFeePerGas": return "0x1";
      default: throw Object.assign(new Error(`unsupported method ${method}`), { code: -32601 });
    }
  }

  async listen() {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let payload;
        try { payload = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
        if (this.rateLimitEvery && this.rateLimitMode === "http" && ++this.httpCount % this.rateLimitEvery === 0) {
          this.rateLimited++;
          res.writeHead(429, { "content-type": "text/plain" });
          return res.end("Too Many Requests");
        }
        const one = (r) => {
          try { return { jsonrpc: "2.0", id: r.id, result: this.handle(r) }; }
          catch (err) { return { jsonrpc: "2.0", id: r.id, error: { code: err.code ?? -32000, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) } }; }
        };
        const out = Array.isArray(payload) ? payload.map(one) : one(payload);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      });
    });
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this.url;
  }

  async close() {
    await new Promise((r) => this.server.close(r));
  }
}

/** A ready-made scenario mirroring the real Base config addresses. */
export function baseScenario() {
  const c = new MockChain();
  const WETH = "0x4200000000000000000000000000000000000006";
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const DAI = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
  const MEME = "0x1111111111111111111111111111111111111111";
  c.addToken(WETH, "WETH", 18);
  c.addToken(USDC, "USDC", 6);
  c.addToken(DAI, "DAI", 18);
  c.addToken(MEME, "MEME", 18);
  c.addToken("0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", "USDbC", 6);
  c.addToken("0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22", "cbETH", 18);
  const UNI_F = "0x8909dc15e40173ff4699343b6eb8132c65e18ec6", UNI_R = "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24";
  const SUSHI_F = "0x71524b4f93c58fcbf659783284e38825f0622859", SUSHI_R = "0x6bded42c6da8fbf0d2ba55b2fa120c5e0c8d7891";
  const BASESWAP_F = "0xfda619b6d20975be80a10332cd39b9a4b0faa8bb", BASESWAP_R = "0x327df1e6de05895d2ab08513aadd9313fe505d86";
  const AERO_F = "0x420dd381b31aef6683db6b902084cb0ffece40da", AERO_R = "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43";
  c.addFactory(UNI_F, "univ2", UNI_R, true);
  c.addFactory(SUSHI_F, "univ2", SUSHI_R);
  c.addFactory(BASESWAP_F, "univ2", BASESWAP_R);
  c.addFactory(AERO_F, "aerodrome", AERO_R);
  const E18 = 10n ** 18n, E6 = 10n ** 6n;
  // WETH/USDC at $2000 on Uniswap and Sushi, $2100 on Aerodrome -> arbitrage.
  const uniWethUsdc = c.addPool("0xaaaa000000000000000000000000000000000001", UNI_F, WETH, USDC, 100n * E18, 200_000n * E6);
  const sushiWethUsdc = c.addPool("0xaaaa000000000000000000000000000000000002", SUSHI_F, USDC, WETH, 200_000n * E6, 100n * E18);
  const aeroWethUsdc = c.addPool("0xaaaa000000000000000000000000000000000003", AERO_F, WETH, USDC, 50n * E18, 105_000n * E6, { feeBps: 30 });
  // BaseSwap with a 0.25% fee, balanced with Uniswap (no arb).
  const baseswapWethUsdc = c.addPool("0xaaaa000000000000000000000000000000000004", BASESWAP_F, WETH, USDC, 30n * E18, 60_000n * E6, { feePpm: 2500 });
  // A MEME/WETH pool on two DEXes, tiny spread (inside fees).
  c.addPool("0xaaaa000000000000000000000000000000000005", UNI_F, MEME, WETH, 1_000_000n * E18, 10n * E18);
  c.addPool("0xaaaa000000000000000000000000000000000006", SUSHI_F, MEME, WETH, 1_000_000n * E18, 10n * E18 + E18 / 100n);
  // Illiquid pool that must be filtered out, and a stable pool that must be skipped.
  c.addPool("0xaaaa000000000000000000000000000000000007", SUSHI_F, DAI, WETH, 100n * E18, E18 / 100n);
  c.addPool("0xaaaa000000000000000000000000000000000008", AERO_F, USDC, DAI, 100_000n * E6, 100_000n * E18, { stable: true });
  return { c, WETH, USDC, DAI, MEME, uniWethUsdc, sushiWethUsdc, aeroWethUsdc, baseswapWethUsdc, factories: { UNI_F, SUSHI_F, BASESWAP_F, AERO_F } };
}
