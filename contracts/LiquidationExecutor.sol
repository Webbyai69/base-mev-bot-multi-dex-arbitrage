// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * LiquidationExecutor — atomic Aave V3 liquidation funded by a free flash loan.
 *
 * When a borrower's Aave position is unhealthy (health factor < 1) anyone may
 * repay part of their debt and seize the same value of collateral plus a bonus
 * (typically 5-10%). This contract does it in one transaction with no capital:
 *
 *   1. flash-loan `debtToCover` of the debt asset (Morpho or Balancer, free),
 *   2. repay it into Aave via pool.liquidationCall(), receiving the seized
 *      collateral (as the underlying token, not an aToken),
 *   3. swap the seized collateral back to the debt asset through the given
 *      hops (V2 / Aerodrome / concentrated-liquidity, exactly like
 *      RouteExecutor),
 *   4. repay the flash loan,
 *   5. keep the remainder.
 *
 * The whole transaction reverts with InsufficientProfit unless the debt asset
 * balance grew by at least `minProfit`, so a stale opportunity, a bad swap or a
 * leaked operator key costs gas, never principal. Collateral is swapped at the
 * contract's *actual* received balance, so a liquidation that returns a little
 * more or less than modelled stays exact.
 *
 * Roles mirror ArbExecutor / RouteExecutor: the owner (your own wallet) deploys
 * it, withdraws profits and sets the operator; the operator (the bot's hot key)
 * can only run liquidations, never withdraw.
 *
 * `simulate` runs the whole thing and reverts with Simulated(profit); the bot
 * calls it with eth_call (optionally with this bytecode injected by a state
 * override) so nothing needs deploying to check a liquidation in paper mode.
 */

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IV2Pair {
    function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IAeroPool {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
}

interface ICLPool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IBalancerVault {
    function flashLoan(address recipient, address[] calldata tokens, uint256[] calldata amounts, bytes calldata userData) external;
}

interface IAavePool {
    function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external;
}

contract LiquidationExecutor {
    struct Hop {
        address pool;
        uint8 kind; // 0 V2 ppm fee, 1 Aerodrome getAmountOut, 2 CL (V3/Slipstream), 3 V2 bps fee
        uint32 feePpm;
    }

    struct Liq {
        address collateralAsset;
        address debtAsset;
        address user;
        uint256 debtToCover;
    }

    address public constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address public constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address public constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    address public owner;
    /// @notice The bot's hot key: may run liquidations, nothing else.
    address public operator;
    /// @dev Set only while a flash loan or CL swap of ours is in progress; callbacks from anyone else revert.
    address private expectedCaller;

    error NotOwner();
    error NotOperator();
    error InsufficientProfit(uint256 got, uint256 want);
    error Simulated(uint256 profit);
    error BadCallback();
    error BadRoute();
    error TransferFailed();

    event Liquidated(address indexed user, address indexed collateralAsset, address indexed debtAsset, uint256 debtToCover, uint256 profit, uint8 source);
    event OperatorSet(address indexed operator);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != owner) revert NotOperator();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    receive() external payable {}

    // ---------------------------------------------------------------------
    // Entry points
    // ---------------------------------------------------------------------

    /// @param swapTokens the swap path for the seized collateral: [collateralAsset, ..., debtAsset].
    /// @param swapHops   one hop per step of swapTokens.
    /// @param source     0 own capital, 1 Morpho flash loan, 2 Balancer flash loan (funds `debtToCover`).
    function liquidate(
        Liq calldata liq,
        address[] calldata swapTokens,
        Hop[] calldata swapHops,
        uint256 minProfit,
        uint8 source
    ) external onlyOperator returns (uint256 profit) {
        profit = _run(liq, swapTokens, swapHops, source);
        if (profit < minProfit) revert InsufficientProfit(profit, minProfit);
        emit Liquidated(liq.user, liq.collateralAsset, liq.debtAsset, liq.debtToCover, profit, source);
    }

    /// @notice Dry run for eth_call: always reverts, with Simulated(profit) on success.
    function simulate(Liq calldata liq, address[] calldata swapTokens, Hop[] calldata swapHops, uint8 source) external {
        uint256 profit = _run(liq, swapTokens, swapHops, source);
        revert Simulated(profit);
    }

    // ---------------------------------------------------------------------
    // Core
    // ---------------------------------------------------------------------

    function _run(Liq calldata liq, address[] calldata swapTokens, Hop[] calldata swapHops, uint8 source) internal returns (uint256 profit) {
        _validate(liq, swapTokens, swapHops);
        uint256 before = IERC20(liq.debtAsset).balanceOf(address(this));
        if (source == 0) {
            _liquidateAndSwap(liq, swapTokens, swapHops, liq.debtToCover);
        } else if (source == 1) {
            expectedCaller = MORPHO;
            IMorpho(MORPHO).flashLoan(liq.debtAsset, liq.debtToCover, abi.encode(liq, swapTokens, swapHops));
            expectedCaller = address(0);
        } else if (source == 2) {
            _balancerFlash(liq, swapTokens, swapHops);
        } else {
            revert BadRoute();
        }
        uint256 after_ = IERC20(liq.debtAsset).balanceOf(address(this));
        if (after_ <= before) revert InsufficientProfit(0, 1);
        profit = after_ - before;
    }

    /// The swap path must start at the collateral and end at the debt asset (what the flash loan is in).
    function _validate(Liq calldata liq, address[] calldata swapTokens, Hop[] calldata swapHops) internal pure {
        uint256 n = swapHops.length;
        if (n == 0 || swapTokens.length != n + 1 || swapTokens[0] != liq.collateralAsset || swapTokens[n] != liq.debtAsset || liq.debtToCover == 0) {
            revert BadRoute();
        }
    }

    function _balancerFlash(Liq calldata liq, address[] calldata swapTokens, Hop[] calldata swapHops) internal {
        address[] memory ts = new address[](1);
        ts[0] = liq.debtAsset;
        uint256[] memory amts = new uint256[](1);
        amts[0] = liq.debtToCover;
        expectedCaller = BALANCER_VAULT;
        IBalancerVault(BALANCER_VAULT).flashLoan(address(this), ts, amts, abi.encode(liq, swapTokens, swapHops));
        expectedCaller = address(0);
    }

    /// @dev Morpho Blue: funds are already here; Morpho pulls `assets` back after we return.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != MORPHO || expectedCaller != MORPHO) revert BadCallback();
        (Liq memory liq, address[] memory swapTokens, Hop[] memory swapHops) = abi.decode(data, (Liq, address[], Hop[]));
        _liquidateAndSwapMem(liq, swapTokens, swapHops, assets);
        _approve(liq.debtAsset, MORPHO, assets);
    }

    /// @dev Balancer V2: repay amount + fee by transfer before returning.
    function receiveFlashLoan(address[] calldata, uint256[] calldata amounts, uint256[] calldata feeAmounts, bytes calldata userData) external {
        if (msg.sender != BALANCER_VAULT || expectedCaller != BALANCER_VAULT) revert BadCallback();
        (Liq memory liq, address[] memory swapTokens, Hop[] memory swapHops) = abi.decode(userData, (Liq, address[], Hop[]));
        _liquidateAndSwapMem(liq, swapTokens, swapHops, amounts[0]);
        _transfer(liq.debtAsset, BALANCER_VAULT, amounts[0] + feeAmounts[0]);
    }

    function _liquidateAndSwap(Liq calldata liq, address[] calldata swapTokens, Hop[] calldata swapHops, uint256 debtToCover) internal {
        uint256 seized = _doLiquidate(liq, debtToCover);
        uint256 amount = seized;
        for (uint256 i = 0; i < swapHops.length; i++) {
            amount = _hop(swapHops[i].pool, swapHops[i].kind, swapHops[i].feePpm, swapTokens[i], swapTokens[i + 1], amount);
        }
    }

    function _liquidateAndSwapMem(Liq memory liq, address[] memory swapTokens, Hop[] memory swapHops, uint256 debtToCover) internal {
        uint256 seized = _doLiquidateMem(liq, debtToCover);
        uint256 amount = seized;
        for (uint256 i = 0; i < swapHops.length; i++) {
            amount = _hop(swapHops[i].pool, swapHops[i].kind, swapHops[i].feePpm, swapTokens[i], swapTokens[i + 1], amount);
        }
    }

    /// @return seized the collateral actually received from Aave (measured, not modelled).
    function _doLiquidate(Liq calldata liq, uint256 debtToCover) internal returns (uint256 seized) {
        uint256 before = IERC20(liq.collateralAsset).balanceOf(address(this));
        _approve(liq.debtAsset, AAVE_POOL, debtToCover);
        IAavePool(AAVE_POOL).liquidationCall(liq.collateralAsset, liq.debtAsset, liq.user, debtToCover, false);
        seized = IERC20(liq.collateralAsset).balanceOf(address(this)) - before;
        if (seized == 0) revert BadRoute();
    }

    function _doLiquidateMem(Liq memory liq, uint256 debtToCover) internal returns (uint256 seized) {
        uint256 before = IERC20(liq.collateralAsset).balanceOf(address(this));
        _approve(liq.debtAsset, AAVE_POOL, debtToCover);
        IAavePool(AAVE_POOL).liquidationCall(liq.collateralAsset, liq.debtAsset, liq.user, debtToCover, false);
        seized = IERC20(liq.collateralAsset).balanceOf(address(this)) - before;
        if (seized == 0) revert BadRoute();
    }

    // ---------------------------------------------------------------------
    // Swaps (identical mechanics to RouteExecutor)
    // ---------------------------------------------------------------------

    /// @return out amount of tokenOut actually received by this contract
    function _hop(address pool, uint8 kind, uint32 feePpm, address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256 out) {
        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));
        bool zeroForOne = tokenIn < tokenOut; // token0 is always the lower address
        if (kind == 2) {
            expectedCaller = pool;
            ICLPool(pool).swap(
                address(this),
                zeroForOne,
                int256(amountIn),
                zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
                abi.encode(tokenIn)
            );
            expectedCaller = address(0);
        } else {
            uint256 expected;
            if (kind == 1) {
                expected = IAeroPool(pool).getAmountOut(amountIn, tokenIn);
            } else if (kind == 0 || kind == 3) {
                (uint256 r0, uint256 r1, ) = IV2Pair(pool).getReserves();
                (uint256 rIn, uint256 rOut) = zeroForOne ? (r0, r1) : (r1, r0);
                if (kind == 0) {
                    uint256 inWithFee = amountIn * (1_000_000 - feePpm);
                    expected = (inWithFee * rOut) / (rIn * 1_000_000 + inWithFee);
                } else {
                    uint256 inAfter = amountIn - (amountIn * (feePpm / 100)) / 10_000;
                    expected = (inAfter * rOut) / (rIn + inAfter);
                }
            } else {
                revert BadRoute();
            }
            _transfer(tokenIn, pool, amountIn);
            IV2Pair(pool).swap(zeroForOne ? 0 : expected, zeroForOne ? expected : 0, address(this), "");
        }
        out = IERC20(tokenOut).balanceOf(address(this)) - balBefore;
    }

    /// @dev Uniswap V3 and Slipstream both call this name. Pay what the pool is owed.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != expectedCaller || expectedCaller == address(0)) revert BadCallback();
        address tokenIn = abi.decode(data, (address));
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        _transfer(tokenIn, msg.sender, owed);
    }

    // ---------------------------------------------------------------------
    // Token helpers (tolerate tokens that return nothing)
    // ---------------------------------------------------------------------

    function _transfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function withdraw(address token, uint256 amount) external onlyOwner {
        _transfer(token, owner, amount == 0 ? IERC20(token).balanceOf(address(this)) : amount);
    }

    function withdrawETH() external onlyOwner {
        (bool ok, ) = owner.call{value: address(this).balance}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Authorise the bot's hot key (address(0) revokes it).
    function setOperator(address newOperator) external onlyOwner {
        operator = newOperator;
        emit OperatorSet(newOperator);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert NotOwner();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
