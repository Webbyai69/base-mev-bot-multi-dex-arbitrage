/**
 * All contract interfaces used by the bot, built once from human-readable ABI
 * fragments. Event topic hashes are derived here rather than hard-coded so a
 * typo cannot silently break the classifier.
 */
import { Interface } from "ethers";

export const multicall3Iface = new Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
  "function getBlockNumber() view returns (uint256)",
]);

export const erc20Iface = new Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** Uniswap V2 style factory (also BaseSwap, SushiSwap). */
export const univ2FactoryIface = new Interface([
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
  "function getPair(address,address) view returns (address)",
]);

/** Uniswap V2 style pair. */
export const univ2PairIface = new Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function factory() view returns (address)",
  "function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Sync(uint112 reserve0, uint112 reserve1)",
]);

export const univ2RouterIface = new Interface([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
]);

/** Aerodrome (Velodrome V2 fork) factory & pool. */
export const aeroFactoryIface = new Interface([
  "function allPoolsLength() view returns (uint256)",
  "function allPools(uint256) view returns (address)",
  "function getPool(address tokenA, address tokenB, bool stable) view returns (address)",
  "function getFee(address pool, bool stable) view returns (uint256)",
]);

export const aeroPoolIface = new Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function stable() view returns (bool)",
  "function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)",
  "function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)",
  "function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)",
  "event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)",
]);

/** Uniswap V3 pool — classifier only. */
export const univ3PoolIface = new Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

/** OP-stack GasPriceOracle predeploy. */
export const gasOracleIface = new Interface([
  "function getL1Fee(bytes data) view returns (uint256)",
  "function l1BaseFee() view returns (uint256)",
]);

/** Our executor contract (contracts/ArbExecutor.sol). */
export const executorIface = new Interface([
  "function executeWithCapital(address buyPool, address sellPool, address tokenIn, uint256 amountIn, uint256 amountMid, uint256 amountOut, uint256 minProfit)",
  "function executeFlash(address buyPool, address sellPool, address tokenIn, uint256 amountIn, uint256 amountMid, uint256 amountOut, uint256 minProfit)",
  "function simulate(address buyPool, address sellPool, address tokenIn, uint256 amountIn, uint256 amountMid, uint256 amountOut, bool flash) returns (uint256 profit)",
  "function withdraw(address token, uint256 amount)",
  "function owner() view returns (address)",
  "error Simulated(uint256 profit)",
  "error InsufficientProfit(uint256 got, uint256 want)",
]);

export const TOPIC_SWAP_V2 = univ2PairIface.getEvent("Swap")!.topicHash;
export const TOPIC_SWAP_AERO = aeroPoolIface.getEvent("Swap")!.topicHash;
export const TOPIC_SWAP_V3 = univ3PoolIface.getEvent("Swap")!.topicHash;
export const TOPIC_TRANSFER = erc20Iface.getEvent("Transfer")!.topicHash;
export const TOPIC_SYNC = univ2PairIface.getEvent("Sync")!.topicHash;
