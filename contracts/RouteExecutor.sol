// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * RouteExecutor — atomic multi-hop arbitrage across Uniswap-V2-style pools,
 * Aerodrome volatile pools and concentrated-liquidity pools (Uniswap V3 and
 * Aerodrome Slipstream), funded by a free flash loan or the contract's own
 * balance.
 *
 *   tokens[0] --hops[0]--> tokens[1] --hops[1]--> ... --> tokens[n] == tokens[0]
 *
 * Funding (`source`):
 *   0  own capital: the contract already holds `amountIn` of tokens[0]
 *   1  Morpho Blue flash loan  (no fee; repaid by transferFrom, so we approve it)
 *   2  Balancer V2 flash loan  (fee set by Balancer governance; zero so far)
 *
 * Hop kinds:
 *   0  Uniswap V2 style pair, fee in ppm   (out computed here from reserves)
 *   1  Aerodrome volatile pool             (out from pool.getAmountOut, exact)
 *   2  Uniswap V3 / Slipstream CL pool     (pool.swap + uniswapV3SwapCallback)
 *   3  Uniswap V2 style pair, fee in bps   (forks whose maths rounds like Aerodrome)
 *
 * Each V2-style hop computes its output from the tokens actually received and
 * the pool's live reserves, so a route stays exact even if an earlier CL hop
 * returned a few wei more or less than the bot's model. The whole transaction
 * reverts with InsufficientProfit unless tokens[0] grew by at least
 * `minProfit`, so a stale route costs gas, never principal.
 *
 * `simulate` runs the full route and always reverts with Simulated(profit);
 * the bot calls it with eth_call (optionally with this bytecode injected by a
 * state override, so nothing needs deploying for paper trading).
 *
 * Roles: the owner (your own wallet, e.g. MetaMask) deploys it, withdraws
 * profits and sets the operator; the operator (the bot's hot key) can only
 * execute routes. A leaked bot key can therefore never withdraw anything.
 *
 * STATUS: written alongside the bot's paper-trading upgrade and not yet
 * compiled or tested in an EVM. Compile and run the simulation path for a
 * few days (paper mode with ROUTE_EXECUTOR_ADDRESS set) before any live use.
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

contract RouteExecutor {
    struct Hop {
        address pool;
        uint8 kind;
        uint32 feePpm;
    }

    address public constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address public constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    address public owner;
    /// @notice The bot's hot key: may execute routes, nothing else.
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

    event RouteExecuted(address indexed token, uint256 amountIn, uint256 profit, uint8 hops, uint8 source);
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
    }

    receive() external payable {}

    // ---------------------------------------------------------------------
    // Entry points
    // ---------------------------------------------------------------------

    function execute(address[] calldata tokens, Hop[] calldata hops, uint256 amountIn, uint256 minProfit, uint8 source)
        external
        onlyOperator
        returns (uint256 profit)
    {
        profit = _run(tokens, hops, amountIn, source);
        if (profit < minProfit) revert InsufficientProfit(profit, minProfit);
        emit RouteExecuted(tokens[0], amountIn, profit, uint8(hops.length), source);
    }

    /// @notice Dry run for eth_call: always reverts, with Simulated(profit) on success.
    function simulate(address[] calldata tokens, Hop[] calldata hops, uint256 amountIn, uint8 source) external {
        uint256 profit = _run(tokens, hops, amountIn, source);
        revert Simulated(profit);
    }

    // ---------------------------------------------------------------------
    // Funding
    // ---------------------------------------------------------------------

    function _run(address[] calldata tokens, Hop[] calldata hops, uint256 amountIn, uint8 source) internal returns (uint256 profit) {
        uint256 n = hops.length;
        if (n == 0 || tokens.length != n + 1 || tokens[0] != tokens[n] || amountIn == 0) revert BadRoute();
        address token = tokens[0];
        uint256 before = IERC20(token).balanceOf(address(this));
        bytes memory data = abi.encode(tokens, hops, amountIn);

        if (source == 0) {
            _route(tokens, hops, amountIn);
        } else if (source == 1) {
            expectedCaller = MORPHO;
            IMorpho(MORPHO).flashLoan(token, amountIn, data);
            expectedCaller = address(0);
        } else if (source == 2) {
            address[] memory ts = new address[](1);
            ts[0] = token;
            uint256[] memory amts = new uint256[](1);
            amts[0] = amountIn;
            expectedCaller = BALANCER_VAULT;
            IBalancerVault(BALANCER_VAULT).flashLoan(address(this), ts, amts, data);
            expectedCaller = address(0);
        } else {
            revert BadRoute();
        }

        uint256 after_ = IERC20(token).balanceOf(address(this));
        if (after_ <= before) revert InsufficientProfit(0, 1);
        profit = after_ - before;
    }

    /// @dev Morpho Blue: funds are already here; Morpho pulls `assets` back after we return.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != MORPHO || expectedCaller != MORPHO) revert BadCallback();
        (address[] memory tokens, Hop[] memory hops, ) = abi.decode(data, (address[], Hop[], uint256));
        _routeMem(tokens, hops, assets);
        _approve(tokens[0], MORPHO, assets);
    }

    /// @dev Balancer V2: repay amount + fee by transfer before returning.
    function receiveFlashLoan(address[] calldata, uint256[] calldata amounts, uint256[] calldata feeAmounts, bytes calldata userData) external {
        if (msg.sender != BALANCER_VAULT || expectedCaller != BALANCER_VAULT) revert BadCallback();
        (address[] memory tokens, Hop[] memory hops, ) = abi.decode(userData, (address[], Hop[], uint256));
        _routeMem(tokens, hops, amounts[0]);
        _transfer(tokens[0], BALANCER_VAULT, amounts[0] + feeAmounts[0]);
    }

    // ---------------------------------------------------------------------
    // Swaps
    // ---------------------------------------------------------------------

    function _route(address[] calldata tokens, Hop[] calldata hops, uint256 amountIn) internal {
        uint256 amount = amountIn;
        for (uint256 i = 0; i < hops.length; i++) {
            amount = _hop(hops[i].pool, hops[i].kind, hops[i].feePpm, tokens[i], tokens[i + 1], amount);
        }
    }

    function _routeMem(address[] memory tokens, Hop[] memory hops, uint256 amountIn) internal {
        uint256 amount = amountIn;
        for (uint256 i = 0; i < hops.length; i++) {
            amount = _hop(hops[i].pool, hops[i].kind, hops[i].feePpm, tokens[i], tokens[i + 1], amount);
        }
    }

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
