// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * EVM tests for contracts/ArbExecutor.sol (run with `forge test`).
 *
 * Focus: the owner/operator split that live trading relies on. Your own wallet
 * deploys and owns the contract; the bot's hot key is only the operator. The
 * operator can trade, every trade must leave the contract with more of the
 * token than before, and only the owner can take anything out. Includes a
 * "leaked bot key" test where the operator points the contract at fake pools
 * to try to pull the profit out.
 *
 * Pools are faithful to Uniswap V2 / Aerodrome: optimistic transfer of the
 * requested output, the flash callback when data is non-empty, then the
 * fee-adjusted K check against what actually arrived.
 */
import "../../contracts/ArbExecutor.sol";

interface Vm {
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function deal(address who, uint256 newBalance) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
    function expectRevert() external;
    function expectEmit(bool, bool, bool, bool) external;
}

contract Token {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

interface IUniCallee {
    function uniswapV2Call(address, uint256, uint256, bytes calldata) external;
}

interface IAeroCallee {
    function hook(address, uint256, uint256, bytes calldata) external;
}

interface IOtherCallee {
    function baseSwapCall(address, uint256, uint256, bytes calldata) external;
}

/// kind 0: uniswapV2Call + ppm fee; 1: Aerodrome `hook` + bps fee; 2: another fork's callback name + ppm fee
contract Pair {
    address public token0;
    address public token1;
    uint256 public reserve0;
    uint256 public reserve1;
    uint256 public feePpm;
    uint8 public kind;

    constructor(address t0, address t1, uint256 fee, uint8 k) {
        token0 = t0;
        token1 = t1;
        feePpm = fee;
        kind = k;
    }

    function sync() external {
        reserve0 = Token(token0).balanceOf(address(this));
        reserve1 = Token(token1).balanceOf(address(this));
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external {
        require(amount0Out > 0 || amount1Out > 0, "INSUFFICIENT_OUTPUT_AMOUNT");
        (uint256 r0, uint256 r1) = (reserve0, reserve1);
        require(amount0Out < r0 && amount1Out < r1, "INSUFFICIENT_LIQUIDITY");
        if (amount0Out > 0) Token(token0).transfer(to, amount0Out);
        if (amount1Out > 0) Token(token1).transfer(to, amount1Out);
        if (data.length > 0) {
            if (kind == 0) IUniCallee(to).uniswapV2Call(msg.sender, amount0Out, amount1Out, data);
            else if (kind == 1) IAeroCallee(to).hook(msg.sender, amount0Out, amount1Out, data);
            else IOtherCallee(to).baseSwapCall(msg.sender, amount0Out, amount1Out, data);
        }
        uint256 b0 = Token(token0).balanceOf(address(this));
        uint256 b1 = Token(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - amount0Out ? b0 - (r0 - amount0Out) : 0;
        uint256 in1 = b1 > r1 - amount1Out ? b1 - (r1 - amount1Out) : 0;
        require(in0 > 0 || in1 > 0, "INSUFFICIENT_INPUT_AMOUNT");
        if (kind == 1) {
            uint256 a0 = b0 - (in0 * (feePpm / 100)) / 10000;
            uint256 a1 = b1 - (in1 * (feePpm / 100)) / 10000;
            require(a0 * a1 >= r0 * r1, "K");
        } else {
            uint256 a0 = b0 * 1_000_000 - in0 * feePpm;
            uint256 a1 = b1 * 1_000_000 - in1 * feePpm;
            require(a0 * a1 >= r0 * r1 * 1_000_000 * 1_000_000, "K");
        }
        reserve0 = b0;
        reserve1 = b1;
    }
}

/// A fake "pool" a leaked operator key could point the contract at: it calls
/// the flash callback itself, asking the executor to send its tokens here.
contract ThiefPool {
    address public token0;
    address public executor;
    address public loot;

    constructor(address _token0, address _executor, address _loot) {
        token0 = _token0;
        executor = _executor;
        loot = _loot;
    }

    function swap(uint256, uint256, address, bytes calldata data) external {
        if (data.length == 0) return; // as "buyPool": keep whatever was sent, deliver nothing
        uint256 all = Token(loot).balanceOf(executor);
        // Pretend to be the lending pool calling back: "send `all` of the loot to me".
        IUniCallee(executor).uniswapV2Call(executor, 0, 0, abi.encode(address(this), loot, all, uint256(0)));
    }
}

contract ArbExecutorTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant BOT = address(0xB07);
    address constant STRANGER = address(0xBAD);

    Token weth;
    Token usdc;
    Pair poolA; // WETH cheap: 100 WETH / 200,000 USDC
    Pair poolB; // WETH dear:   50 WETH / 105,000 USDC
    ArbExecutor ex;

    function setUp() public {
        weth = new Token();
        usdc = new Token();
        poolA = _pair(address(weth), address(usdc), 3000, 0, 100e18, 200_000e18);
        poolB = _pair(address(weth), address(usdc), 3000, 0, 50e18, 105_000e18);
        ex = new ArbExecutor(); // this test contract plays your wallet: the owner
    }

    function _pair(address t0, address t1, uint256 fee, uint8 kind, uint256 r0, uint256 r1) internal returns (Pair p) {
        p = new Pair(t0, t1, fee, kind);
        Token(t0).mint(address(p), r0);
        Token(t1).mint(address(p), r1);
        p.sync();
    }

    function _out(uint256 amountIn, uint256 rIn, uint256 rOut, uint256 feePpm) internal pure returns (uint256) {
        uint256 inWithFee = amountIn * (1_000_000 - feePpm);
        return (inWithFee * rOut) / (rIn * 1_000_000 + inWithFee);
    }

    /// Quote: 1 WETH sold into poolB (dear) for USDC, the USDC sold into poolA (cheap) for WETH.
    function _quote() internal view returns (uint256 amountIn, uint256 amountMid, uint256 amountOut) {
        amountIn = 1e18;
        amountMid = _out(amountIn, poolB.reserve0(), poolB.reserve1(), 3000);
        amountOut = _out(amountMid, poolA.reserve1(), poolA.reserve0(), 3000);
    }

    function _assertEq(uint256 a, uint256 b, string memory what) internal pure {
        require(a == b, what);
    }

    // ------------------------------------------------------------------ roles

    function test_DeployerIsOwnerAndNoOperatorYet() public view {
        require(ex.owner() == address(this), "owner");
        require(ex.operator() == address(0), "operator");
    }

    function test_OperatorTradesAndProfitStaysInContract() public {
        ex.setOperator(BOT);
        require(ex.operator() == BOT, "operator set");
        (uint256 amountIn, uint256 amountMid, uint256 amountOut) = _quote();
        require(amountOut > amountIn, "route must be profitable");
        vm.prank(BOT);
        uint256 profit = ex.executeFlash(address(poolB), address(poolA), address(weth), amountIn, amountMid, amountOut, (amountOut - amountIn) * 95 / 100);
        _assertEq(profit, amountOut - amountIn, "profit equals the quote to the wei");
        _assertEq(weth.balanceOf(address(ex)), profit, "profit held by the contract");
        _assertEq(weth.balanceOf(BOT), 0, "nothing goes to the bot wallet");
    }

    function test_OwnerCanTradeToo() public {
        (uint256 amountIn, uint256 amountMid, uint256 amountOut) = _quote();
        uint256 profit = ex.executeFlash(address(poolB), address(poolA), address(weth), amountIn, amountMid, amountOut, 1);
        _assertEq(profit, amountOut - amountIn, "profit");
    }

    function test_StrangerCannotTrade() public {
        (uint256 amountIn, uint256 amountMid, uint256 amountOut) = _quote();
        vm.prank(STRANGER);
        vm.expectRevert(ArbExecutor.NotOperator.selector);
        ex.executeFlash(address(poolB), address(poolA), address(weth), amountIn, amountMid, amountOut, 1);
        vm.prank(STRANGER);
        vm.expectRevert(ArbExecutor.NotOperator.selector);
        ex.executeWithCapital(address(poolB), address(poolA), address(weth), amountIn, amountMid, amountOut, 1);
    }

    function test_OperatorCannotWithdrawOrTakeOver() public {
        ex.setOperator(BOT);
        weth.mint(address(ex), 5e18);
        vm.deal(address(ex), 1 ether);
        vm.startPrank(BOT);
        vm.expectRevert(ArbExecutor.NotOwner.selector);
        ex.withdraw(address(weth), 0);
        vm.expectRevert(ArbExecutor.NotOwner.selector);
        ex.withdrawETH();
        vm.expectRevert(ArbExecutor.NotOwner.selector);
        ex.setOperator(STRANGER);
        vm.expectRevert(ArbExecutor.NotOwner.selector);
        ex.transferOwnership(BOT);
        vm.stopPrank();
        _assertEq(weth.balanceOf(address(ex)), 5e18, "tokens untouched");
        _assertEq(address(ex).balance, 1 ether, "ETH untouched");
    }

    function test_OwnerWithdrawsProfit() public {
        ex.setOperator(BOT);
        (uint256 amountIn, uint256 amountMid, uint256 amountOut) = _quote();
        vm.prank(BOT);
        uint256 profit = ex.executeFlash(address(poolB), address(poolA), address(weth), amountIn, amountMid, amountOut, 1);
        uint256 before = weth.balanceOf(address(this));
        ex.withdraw(address(weth), 0); // 0 = everything
        _assertEq(weth.balanceOf(address(this)), before + profit, "owner received the profit");
        _assertEq(weth.balanceOf(address(ex)), 0, "contract emptied");
    }

    function test_OwnerWithdrawsETH() public {
        vm.deal(address(ex), 0.5 ether);
        uint256 before = address(this).balance;
        ex.withdrawETH();
        _assertEq(address(this).balance, before + 0.5 ether, "ETH to owner");
    }

    receive() external payable {}

    function test_RevokedOperatorCannotTrade() public {
        ex.setOperator(BOT);
        ex.setOperator(address(0));
        (uint256 amountIn, uint256 amountMid, uint256 amountOut) = _quote();
        vm.prank(BOT);
        vm.expectRevert(ArbExecutor.NotOperator.selector);
        ex.executeFlash(address(poolB), address(poolA), address(weth), amountIn, amountMid, amountOut, 1);
    }

    function test_TransferOwnershipRejectsZeroAndMovesControl() public {
        vm.expectRevert(ArbExecutor.NotOwner.selector);
        ex.transferOwnership(address(0));
        ex.transferOwnership(STRANGER);
        require(ex.owner() == STRANGER, "new owner");
        vm.expectRevert(ArbExecutor.NotOwner.selector);
        ex.setOperator(BOT); // the old owner lost control
    }

    // ------------------------------------------------------- failure is cheap

    function test_StaleQuoteRevertsAndLosesNothing() public {
        ex.setOperator(BOT);
        (uint256 amountIn, uint256 amountMid, uint256 amountOut) = _quote();
        vm.prank(BOT);
        ex.executeFlash(address(poolB), address(poolA), address(weth), amountIn, amountMid, amountOut, 1);
        uint256 held = weth.balanceOf(address(ex));
        // Same trade again: the gap has closed, so a pool's K check (or the profit check) reverts.
        vm.prank(BOT);
        vm.expectRevert();
        ex.executeFlash(address(poolB), address(poolA), address(weth), amountIn, amountMid, amountOut, 1);
        _assertEq(weth.balanceOf(address(ex)), held, "no funds lost on a failed attempt");
    }

    function test_MinProfitIsEnforced() public {
        ex.setOperator(BOT);
        (uint256 amountIn, uint256 amountMid, uint256 amountOut) = _quote();
        uint256 profit = amountOut - amountIn;
        vm.prank(BOT);
        vm.expectRevert(abi.encodeWithSelector(ArbExecutor.InsufficientProfit.selector, profit, profit + 1));
        ex.executeFlash(address(poolB), address(poolA), address(weth), amountIn, amountMid, amountOut, profit + 1);
    }

    // ------------------------------------------------------ leaked bot key

    function test_LeakedOperatorKeyCannotDrainViaFakeFlashPool() public {
        ex.setOperator(BOT);
        weth.mint(address(ex), 3e18); // profit sitting in the contract
        ThiefPool thief = new ThiefPool(address(weth), address(ex), address(weth));
        vm.prank(BOT);
        vm.expectRevert(); // the balance check at the end undoes everything
        ex.executeFlash(address(thief), address(thief), address(weth), 1, 0, 1, 0);
        _assertEq(weth.balanceOf(address(ex)), 3e18, "profit still in the contract");
        _assertEq(weth.balanceOf(address(thief)), 0, "thief got nothing");
    }

    function test_LeakedOperatorKeyCannotDrainViaFakeBuyPool() public {
        ex.setOperator(BOT);
        weth.mint(address(ex), 3e18);
        ThiefPool thief = new ThiefPool(address(weth), address(ex), address(weth));
        // executeWithCapital sends amountIn to the "buy pool" first: a fake one keeps it.
        vm.prank(BOT);
        vm.expectRevert();
        ex.executeWithCapital(address(thief), address(thief), address(weth), 3e18, 0, 1, 0);
        _assertEq(weth.balanceOf(address(ex)), 3e18, "profit still in the contract");
        _assertEq(weth.balanceOf(address(thief)), 0, "thief got nothing");
    }

    function test_CallbackFromAnyoneElseIsRejected() public {
        vm.prank(STRANGER);
        vm.expectRevert(ArbExecutor.BadCallback.selector);
        ex.uniswapV2Call(address(ex), 0, 0, abi.encode(STRANGER, address(weth), uint256(1), uint256(0)));
        vm.prank(STRANGER);
        vm.expectRevert(ArbExecutor.BadCallback.selector);
        ex.hook(address(ex), 0, 0, abi.encode(STRANGER, address(weth), uint256(1), uint256(0)));
    }

    // ---------------------------------------------- callbacks of other forks

    function test_AerodromeHookAndUnknownForkCallbacks() public {
        ex.setOperator(BOT);
        // Lender with Aerodrome's `hook` callback (fee in bps), and one with another fork's callback name.
        Pair aero = _pair(address(weth), address(usdc), 3000, 1, 100e18, 200_000e18);
        Pair other = _pair(address(weth), address(usdc), 3000, 2, 100e18, 200_000e18);
        for (uint256 i = 0; i < 2; i++) {
            Pair lender = i == 0 ? aero : other;
            Pair dear = _pair(address(weth), address(usdc), 3000, 0, 50e18, 105_000e18);
            uint256 amountIn = 1e18;
            uint256 amountMid = _out(amountIn, dear.reserve0(), dear.reserve1(), 3000);
            // Both fee models agree at 0.30%; round down one wei for the bps mock's integer maths.
            uint256 amountOut = _out(amountMid, lender.reserve1(), lender.reserve0(), 3000) - 1;
            uint256 before = weth.balanceOf(address(ex));
            vm.prank(BOT);
            uint256 profit = ex.executeFlash(address(dear), address(lender), address(weth), amountIn, amountMid, amountOut, 1);
            _assertEq(weth.balanceOf(address(ex)), before + profit, "profit via the fork's callback");
        }
    }

    // ------------------------------------------------------------ simulate()

    function test_SimulateAlwaysRevertsWithTheProfitAndChangesNothing() public {
        (uint256 amountIn, uint256 amountMid, uint256 amountOut) = _quote();
        uint256 r0 = poolA.reserve0();
        vm.prank(STRANGER); // simulate is open to anyone: it can never keep a state change
        vm.expectRevert(abi.encodeWithSelector(ArbExecutor.Simulated.selector, amountOut - amountIn));
        ex.simulate(address(poolB), address(poolA), address(weth), amountIn, amountMid, amountOut, true);
        _assertEq(poolA.reserve0(), r0, "pools unchanged");
        _assertEq(weth.balanceOf(address(ex)), 0, "nothing kept");
    }
}
