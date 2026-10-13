// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * CompoundLiquidator: DRAFT flash liquidation for Compound III (Comet). NOT DEPLOYED.
 *
 * Written from scratch for this repo (clean room). Only the public Comet interface
 * (absorb, buyCollateral, quoteCollateral, baseToken) was read from
 * compound-finance/comet (GPL-2.0-or-later); no Comet code is copied here.
 *
 * How Compound III liquidation works, in two permissionless steps:
 *   1. absorb(absorber, accounts): Comet takes over each underwater account. Its debt
 *      is written off against the protocol's reserves and its collateral becomes
 *      protocol-owned. The absorber is paid nothing directly (only "liquidator points").
 *   2. buyCollateral(asset, minAmount, baseAmount, recipient): while the protocol's
 *      reserves are below targetReserves, anyone can buy that collateral for the base
 *      token at a discount (storeFrontPriceFactor x (1 - liquidationFactor)).
 *
 * This contract does both in one transaction with no capital of its own:
 *   absorb -> flash-borrow `baseAmount` of the base token (Morpho Blue, free)
 *   -> buyCollateral at the discount -> swap the collateral back to the base token
 *   -> repay the flash loan -> keep the rest. Anything less than `minProfit` reverts.
 *
 * Safety pattern (same rules as contracts/LiquidationExecutor.sol, stricter in places):
 *   - owner (Joshua's own wallet) deploys, withdraws, sets the operator and the list of
 *     Comet markets it may touch. The operator (a hot key) may only call liquidate().
 *   - A leaked operator key must cost gas, never principal:
 *       * the Comet must be on the owner's allowlist (no fake markets);
 *       * every token on the swap path is snapshotted before the run and must not end
 *         lower than it started, and the base token must end strictly higher;
 *       * a concentrated-liquidity callback may claim at most the amount we asked to
 *         swap, from the pool we are swapping with, during that swap only;
 *       * flash-loan callbacks are only accepted from the lender, while we asked for one.
 *   - No owner-free paths: no arbitrary calls, no delegatecall, no approvals left behind.
 *
 * `simulate` runs everything and always reverts with Simulated(profit), for eth_call.
 */

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// The subset of Comet we call. Signatures from the public interface; no code copied.
interface IComet {
    function absorb(address absorber, address[] calldata accounts) external;
    function buyCollateral(address asset, uint256 minAmount, uint256 baseAmount, address recipient) external;
    function quoteCollateral(address asset, uint256 baseAmount) external view returns (uint256);
    function baseToken() external view returns (address);
}

interface IMorphoFlash {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IPairV2 {
    function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IAerodromePool {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
}

interface IConcentratedPool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

contract CompoundLiquidator {
    struct Hop {
        address pool;
        uint8 kind; // 0 V2 (fee in ppm), 1 Aerodrome (getAmountOut), 2 concentrated liquidity (V3 / Slipstream)
        uint32 feePpm;
    }

    struct Job {
        address comet; // must be allowlisted by the owner
        address[] accounts; // accounts to absorb first (may be empty: buy collateral already for sale)
        address asset; // collateral to buy
        uint256 baseAmount; // base token spent on buyCollateral (= flash loan size)
        uint256 minCollateral; // passed to buyCollateral as its slippage floor
    }

    uint8 public constant SOURCE_OWN = 0;
    uint8 public constant SOURCE_MORPHO = 1;
    uint160 private constant SQRT_MIN_PLUS_ONE = 4295128740;
    uint160 private constant SQRT_MAX_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    /// Morpho Blue on this chain (Base and Ethereum: 0xBBBB...EEFFCb). Immutable, set at deploy.
    address public immutable flashLender;

    address public owner;
    address public operator;
    mapping(address => bool) public cometAllowed;

    // Transient guards for callbacks (cleared after each use).
    address private expectedLender;
    address private expectedPool;
    uint256 private expectedMaxOwed;
    address private expectedTokenIn;
    uint256 private lastBought;

    error NotOwner();
    error NotOperator();
    error CometNotAllowed(address comet);
    error BadRoute();
    error BadCallback();
    error OverClaim(uint256 owed, uint256 max);
    error NothingBought();
    error BalanceDropped(address token, uint256 before, uint256 afterwards);
    error InsufficientProfit(uint256 got, uint256 want);
    error Simulated(uint256 profit);
    error TransferFailed();

    event Liquidated(address indexed comet, address indexed asset, uint256 accounts, uint256 baseAmount, uint256 collateralBought, uint256 profit);
    event OperatorSet(address indexed operator);
    event CometSet(address indexed comet, bool allowed);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != owner) revert NotOperator();
        _;
    }

    constructor(address lender) {
        flashLender = lender;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ---------------------------------------------------------------------
    // Entry points
    // ---------------------------------------------------------------------

    /// @param swapTokens [asset, ..., baseToken]: how the bought collateral goes back to the base token.
    /// @param hops       one per step of swapTokens.
    /// @param source     0 own capital already held here, 1 Morpho Blue flash loan.
    function liquidate(Job calldata job, address[] calldata swapTokens, Hop[] calldata hops, uint256 minProfit, uint8 source)
        external
        onlyOperator
        returns (uint256 profit)
    {
        uint256 bought;
        (profit, bought) = _run(job, swapTokens, hops, source);
        if (profit < minProfit) revert InsufficientProfit(profit, minProfit);
        emit Liquidated(job.comet, job.asset, job.accounts.length, job.baseAmount, bought, profit);
    }

    /// Dry run for eth_call. Always reverts; Simulated(profit) means it would have worked.
    function simulate(Job calldata job, address[] calldata swapTokens, Hop[] calldata hops, uint8 source) external onlyOperator {
        (uint256 profit, ) = _run(job, swapTokens, hops, source);
        revert Simulated(profit);
    }

    // ---------------------------------------------------------------------
    // Core
    // ---------------------------------------------------------------------

    function _run(Job calldata job, address[] calldata swapTokens, Hop[] calldata hops, uint8 source)
        internal
        returns (uint256 profit, uint256 bought)
    {
        if (!cometAllowed[job.comet]) revert CometNotAllowed(job.comet);
        address base = IComet(job.comet).baseToken();
        uint256 n = hops.length;
        if (
            n == 0 || swapTokens.length != n + 1 || swapTokens[0] != job.asset || swapTokens[n] != base || job.asset == base
                || job.baseAmount == 0
        ) revert BadRoute();

        // Snapshot every token we touch: none may end lower than it started.
        uint256[] memory before = new uint256[](n + 1);
        for (uint256 i = 0; i <= n; i++) {
            before[i] = IERC20Like(swapTokens[i]).balanceOf(address(this));
        }

        if (job.accounts.length > 0) IComet(job.comet).absorb(address(this), job.accounts);

        bytes memory data = abi.encode(job, swapTokens, hops);
        if (source == SOURCE_OWN) {
            bought = _buyAndSwap(data, job.baseAmount);
        } else if (source == SOURCE_MORPHO) {
            expectedLender = flashLender;
            IMorphoFlash(flashLender).flashLoan(base, job.baseAmount, data);
            if (expectedLender != address(0)) revert BadCallback(); // the lender never called back
            bought = lastBought; // set by onMorphoFlashLoan
            lastBought = 0;
        } else {
            revert BadRoute();
        }

        for (uint256 i = 0; i < n; i++) {
            uint256 nowBal = IERC20Like(swapTokens[i]).balanceOf(address(this));
            if (nowBal < before[i]) revert BalanceDropped(swapTokens[i], before[i], nowBal);
        }
        uint256 baseAfter = IERC20Like(base).balanceOf(address(this));
        if (baseAfter <= before[n]) revert InsufficientProfit(0, 1);
        profit = baseAfter - before[n];
    }

    /// Morpho Blue has sent `assets` of the base token; it pulls them back after we return.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != flashLender || expectedLender != flashLender) revert BadCallback();
        expectedLender = address(0);
        uint256 bought = _buyAndSwap(data, assets);
        (Job memory job, , ) = abi.decode(data, (Job, address[], Hop[]));
        _approve(IComet(job.comet).baseToken(), flashLender, assets);
        lastBought = bought;
    }

    function _buyAndSwap(bytes memory data, uint256 baseAmount) internal returns (uint256 bought) {
        (Job memory job, address[] memory swapTokens, Hop[] memory hops) = abi.decode(data, (Job, address[], Hop[]));
        address base = swapTokens[swapTokens.length - 1];

        uint256 colBefore = IERC20Like(job.asset).balanceOf(address(this));
        _approve(base, job.comet, baseAmount);
        IComet(job.comet).buyCollateral(job.asset, job.minCollateral, baseAmount, address(this));
        _approve(base, job.comet, 0);
        bought = IERC20Like(job.asset).balanceOf(address(this)) - colBefore;
        if (bought == 0) revert NothingBought();

        uint256 amount = bought;
        for (uint256 i = 0; i < hops.length; i++) {
            amount = _swap(hops[i], swapTokens[i], swapTokens[i + 1], amount);
        }
    }

    // ---------------------------------------------------------------------
    // Swaps: amounts are always measured, never trusted
    // ---------------------------------------------------------------------

    function _swap(Hop memory h, address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256 out) {
        uint256 outBefore = IERC20Like(tokenOut).balanceOf(address(this));
        bool zeroForOne = tokenIn < tokenOut;
        if (h.kind == 2) {
            expectedPool = h.pool;
            expectedMaxOwed = amountIn;
            expectedTokenIn = tokenIn;
            IConcentratedPool(h.pool).swap(
                address(this), zeroForOne, int256(amountIn), zeroForOne ? SQRT_MIN_PLUS_ONE : SQRT_MAX_MINUS_ONE, ""
            );
            expectedPool = address(0);
            expectedMaxOwed = 0;
            expectedTokenIn = address(0);
        } else {
            uint256 quoted;
            if (h.kind == 1) {
                quoted = IAerodromePool(h.pool).getAmountOut(amountIn, tokenIn);
            } else if (h.kind == 0) {
                (uint256 r0, uint256 r1, ) = IPairV2(h.pool).getReserves();
                (uint256 rIn, uint256 rOut) = zeroForOne ? (r0, r1) : (r1, r0);
                uint256 inAfterFee = amountIn * (1_000_000 - h.feePpm);
                quoted = (inAfterFee * rOut) / (rIn * 1_000_000 + inAfterFee);
            } else {
                revert BadRoute();
            }
            _transfer(tokenIn, h.pool, amountIn);
            IPairV2(h.pool).swap(zeroForOne ? 0 : quoted, zeroForOne ? quoted : 0, address(this), "");
        }
        out = IERC20Like(tokenOut).balanceOf(address(this)) - outBefore;
    }

    /// Uniswap V3 and Aerodrome Slipstream both call this name.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != expectedPool || expectedPool == address(0)) revert BadCallback();
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        if (owed > expectedMaxOwed) revert OverClaim(owed, expectedMaxOwed);
        expectedPool = address(0); // one payment per swap
        _transfer(expectedTokenIn, msg.sender, owed);
    }

    // ---------------------------------------------------------------------
    // Token helpers (tolerate tokens that return nothing)
    // ---------------------------------------------------------------------

    function _transfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20Like.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20Like.approve.selector, spender, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    // ---------------------------------------------------------------------
    // Owner only
    // ---------------------------------------------------------------------

    function setComet(address comet, bool allowed) external onlyOwner {
        cometAllowed[comet] = allowed;
        emit CometSet(comet, allowed);
    }

    /// address(0) revokes the operator.
    function setOperator(address newOperator) external onlyOwner {
        operator = newOperator;
        emit OperatorSet(newOperator);
    }

    function withdraw(address token, uint256 amount) external onlyOwner {
        _transfer(token, owner, amount == 0 ? IERC20Like(token).balanceOf(address(this)) : amount);
    }

    function withdrawETH() external onlyOwner {
        (bool ok, ) = owner.call{value: address(this).balance}("");
        if (!ok) revert TransferFailed();
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert NotOwner();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    receive() external payable {}
}
