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
  "event Sync(uint256 reserve0, uint256 reserve1)",
]);

/** Uniswap V3 pool (classifier + concentrated-liquidity trading). */
export const univ3PoolIface = new Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function factory() view returns (address)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
  "function tickBitmap(int16 wordPosition) view returns (uint256)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
]);

/**
 * Aerodrome Slipstream CL pool. Same Swap event and callback as Uniswap V3,
 * but slot0() has NO feeProtocol field (6 values, not 7) and fee() is dynamic.
 */
export const slipstreamPoolIface = new Interface([
  "function fee() view returns (uint24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)",
]);

export const univ3FactoryIface = new Interface([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);

export const slipstreamFactoryIface = new Interface([
  "function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)",
]);

/** Uniswap QuoterV2 (non-view; call with eth_call / inside Multicall3). */
export const univ3QuoterIface = new Interface([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

/** Slipstream QuoterV2: tickSpacing instead of fee. */
export const slipstreamQuoterIface = new Interface([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

/** Our multi-hop executor (contracts/RouteExecutor.sol). */
export const routeExecutorIface = new Interface([
  "function execute(address[] tokens, (address pool, uint8 kind, uint32 feePpm)[] hops, uint256 amountIn, uint256 minProfit, uint8 source)",
  "function simulate(address[] tokens, (address pool, uint8 kind, uint32 feePpm)[] hops, uint256 amountIn, uint8 source)",
  "error Simulated(uint256 profit)",
  "error InsufficientProfit(uint256 got, uint256 want)",
  "error BadCallback()",
  "error TransferFailed()",
  "error NotOwner()",
  "error NotOperator()",
  "function owner() view returns (address)",
  "function operator() view returns (address)",
  "function setOperator(address newOperator)",
  "function withdraw(address token, uint256 amount)",
]);

/** Multicall3 extras used by the dashboard's balance reads. */
export const multicallEthIface = new Interface(["function getEthBalance(address addr) view returns (uint256 balance)"]);

/** Aave V3 Pool / data provider / oracle (liquidation monitor). */
export const aavePoolIface = new Interface([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getReservesList() view returns (address[])",
  "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)",
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
]);

export const aaveDataProviderIface = new Interface([
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
  "function getLiquidationProtocolFee(address asset) view returns (uint256)",
]);

export const aaveOracleIface = new Interface([
  "function getAssetsPrices(address[] assets) view returns (uint256[])",
  "function BASE_CURRENCY_UNIT() view returns (uint256)",
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
  "function withdrawETH()",
  "function owner() view returns (address)",
  "function operator() view returns (address)",
  "function setOperator(address newOperator)",
  "error Simulated(uint256 profit)",
  "error InsufficientProfit(uint256 got, uint256 want)",
  "error BadCallback()",
  "error TransferFailed()",
  "error NotOwner()",
  "error NotOperator()",
]);

export const TOPIC_SWAP_V2 = univ2PairIface.getEvent("Swap")!.topicHash;
export const TOPIC_SWAP_AERO = aeroPoolIface.getEvent("Swap")!.topicHash;
export const TOPIC_SWAP_V3 = univ3PoolIface.getEvent("Swap")!.topicHash;
export const TOPIC_TRANSFER = erc20Iface.getEvent("Transfer")!.topicHash;
export const TOPIC_SYNC = univ2PairIface.getEvent("Sync")!.topicHash;
/** Aerodrome pools emit Sync(uint256,uint256), a different topic from Uniswap V2's Sync(uint112,uint112). */
export const TOPIC_SYNC_AERO = aeroPoolIface.getEvent("Sync")!.topicHash;
export const TOPIC_MINT_V3 = univ3PoolIface.getEvent("Mint")!.topicHash;
export const TOPIC_BURN_V3 = univ3PoolIface.getEvent("Burn")!.topicHash;
export const TOPIC_AAVE_BORROW = aavePoolIface.getEvent("Borrow")!.topicHash;
export const TOPIC_AAVE_LIQUIDATION = aavePoolIface.getEvent("LiquidationCall")!.topicHash;
