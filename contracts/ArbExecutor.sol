// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * ArbExecutor — atomic two-pool arbitrage on Uniswap-V2-style pools
 * (Uniswap V2, SushiSwap, BaseSwap, Aerodrome volatile pools, ...).
 *
 * Route: tokenIn --(buyPool)--> tokenMid --(sellPool)--> tokenIn, ending with
 * more tokenIn than we started with. Two funding modes:
 *
 *   executeWithCapital  the contract already holds `amountIn` of tokenIn.
 *   executeFlash        no capital needed: sellPool "flash-swaps" `amountOut`
 *                       of tokenIn to us first; inside its callback we send
 *                       `amountIn` to buyPool, whose output (tokenMid) is
 *                       delivered straight to sellPool as the repayment.
 *                       Profit = amountOut - amountIn stays here.
 *
 * Both modes revert with InsufficientProfit unless the tokenIn balance grew
 * by at least `minProfit`, so a stale quote costs gas but never principal.
 *
 * The flash callback name differs between forks (uniswapV2Call, pancakeCall,
 * hook, baseSwapCall, ...) but the arguments are always
 * (address sender, uint amount0, uint amount1, bytes data), so a fallback
 * handler accepts any selector and validates msg.sender against the pool we
 * are expecting a callback from.
 *
 * `simulate` runs a full execution and then reverts with Simulated(profit);
 * the bot calls it via eth_call to get an exact on-chain answer without
 * spending gas.
 *
 * Roles: the owner (your own wallet, e.g. Brave or MetaMask) deploys it,
 * withdraws profits and sets the operator; the operator (the bot's hot key)
 * can only execute trades, and every trade must leave the contract holding
 * more of the token than before. A leaked bot key can therefore spend its own
 * gas money but never withdraw anything from here.
 */

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IV2Pool {
    function token0() external view returns (address);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

contract ArbExecutor {
    address public owner;
    /// @notice The bot's hot key: may execute trades, nothing else.
    address public operator;
    /// @dev Set only while one of our flash swaps is in progress; callbacks from anyone else revert.
    address private expectedCaller;

    error NotOwner();
    error NotOperator();
    error InsufficientProfit(uint256 got, uint256 want);
    error Simulated(uint256 profit);
    error BadCallback();
    error TransferFailed();

    event Arbitrage(address indexed tokenIn, address buyPool, address sellPool, uint256 amountIn, uint256 profit, bool flash);
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
    // Execution
    // ---------------------------------------------------------------------

    function executeWithCapital(
        address buyPool,
        address sellPool,
        address tokenIn,
        uint256 amountIn,
        uint256 amountMid,
        uint256 amountOut,
        uint256 minProfit
    ) external onlyOperator returns (uint256 profit) {
        profit = _runWithCapital(buyPool, sellPool, tokenIn, amountIn, amountMid, amountOut);
        if (profit < minProfit) revert InsufficientProfit(profit, minProfit);
        emit Arbitrage(tokenIn, buyPool, sellPool, amountIn, profit, false);
    }

    function executeFlash(
        address buyPool,
        address sellPool,
        address tokenIn,
        uint256 amountIn,
        uint256 amountMid,
        uint256 amountOut,
        uint256 minProfit
    ) external onlyOperator returns (uint256 profit) {
        profit = _runFlash(buyPool, sellPool, tokenIn, amountIn, amountMid, amountOut);
        if (profit < minProfit) revert InsufficientProfit(profit, minProfit);
        emit Arbitrage(tokenIn, buyPool, sellPool, amountIn, profit, true);
    }

    /// @notice Dry run for eth_call: always reverts, with Simulated(profit) on success.
    function simulate(
        address buyPool,
        address sellPool,
        address tokenIn,
        uint256 amountIn,
        uint256 amountMid,
        uint256 amountOut,
        bool flash
    ) external {
        uint256 profit = flash
            ? _runFlash(buyPool, sellPool, tokenIn, amountIn, amountMid, amountOut)
            : _runWithCapital(buyPool, sellPool, tokenIn, amountIn, amountMid, amountOut);
        revert Simulated(profit);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _runWithCapital(
        address buyPool,
        address sellPool,
        address tokenIn,
        uint256 amountIn,
        uint256 amountMid,
        uint256 amountOut
    ) internal returns (uint256 profit) {
        uint256 before = IERC20(tokenIn).balanceOf(address(this));
        // Hop 1: pay buyPool, have it deliver tokenMid directly to sellPool.
        _transfer(tokenIn, buyPool, amountIn);
        _swap(buyPool, tokenIn, false, amountMid, sellPool, "");
        // Hop 2: sellPool now holds our tokenMid; take tokenIn out.
        _swap(sellPool, tokenIn, true, amountOut, address(this), "");
        uint256 after_ = IERC20(tokenIn).balanceOf(address(this));
        if (after_ <= before) revert InsufficientProfit(0, 1);
        profit = after_ - before;
    }

    function _runFlash(
        address buyPool,
        address sellPool,
        address tokenIn,
        uint256 amountIn,
        uint256 amountMid,
        uint256 amountOut
    ) internal returns (uint256 profit) {
        uint256 before = IERC20(tokenIn).balanceOf(address(this));
        expectedCaller = sellPool;
        _swap(sellPool, tokenIn, true, amountOut, address(this), abi.encode(buyPool, tokenIn, amountIn, amountMid));
        expectedCaller = address(0);
        uint256 after_ = IERC20(tokenIn).balanceOf(address(this));
        if (after_ <= before) revert InsufficientProfit(0, 1);
        profit = after_ - before;
    }

    /// @dev Flash-swap callback body: buy tokenMid with the borrowed tokenIn and
    ///      send it straight to the lending pool as repayment.
    function _onCallback(address sender, bytes memory data) internal {
        if (msg.sender != expectedCaller || sender != address(this)) revert BadCallback();
        (address buyPool, address tokenIn, uint256 amountIn, uint256 amountMid) = abi.decode(data, (address, address, uint256, uint256));
        _transfer(tokenIn, buyPool, amountIn);
        _swap(buyPool, tokenIn, false, amountMid, msg.sender, "");
    }

    /// @param tokenInIsOutput true when we want `tokenIn` OUT of the pool (hop 2 / flash borrow),
    ///        false when we put tokenIn IN and want the other token out (hop 1).
    function _swap(address pool, address tokenIn, bool tokenInIsOutput, uint256 amount, address to, bytes memory data) internal {
        bool tokenInIs0 = IV2Pool(pool).token0() == tokenIn;
        bool outIs0 = tokenInIsOutput ? tokenInIs0 : !tokenInIs0;
        IV2Pool(pool).swap(outIs0 ? amount : 0, outIs0 ? 0 : amount, to, data);
    }

    function _transfer(address token, address to, uint256 amount) internal {
        // Tolerate non-standard tokens that return nothing (USDT-style).
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    // ---------------------------------------------------------------------
    // Callbacks (every V2 fork uses the same argument layout)
    // ---------------------------------------------------------------------

    function uniswapV2Call(address sender, uint256, uint256, bytes calldata data) external {
        _onCallback(sender, data);
    }

    /// @dev Aerodrome / Velodrome V2
    function hook(address sender, uint256, uint256, bytes calldata data) external {
        _onCallback(sender, data);
    }

    /// @dev Any other fork's callback name (pancakeCall, baseSwapCall, swapV2Call, ...).
    fallback() external {
        if (msg.data.length < 4 + 32 * 4) revert BadCallback();
        (address sender, , , bytes memory data) = abi.decode(msg.data[4:], (address, uint256, uint256, bytes));
        _onCallback(sender, data);
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
