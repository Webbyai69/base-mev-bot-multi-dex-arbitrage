// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * EVM tests for contracts/RouteExecutor.sol (run with `forge test`).
 *
 * Mocks are faithful to the parts the executor depends on:
 *   - V2 pair: optimistic transfer of the requested output, then the
 *     fee-adjusted K check against the tokens actually received (ppm fee).
 *   - Aerodrome pool: getAmountOut in bps, same optimistic swap.
 *   - CL pool: sends the output first, then calls uniswapV3SwapCallback and
 *     requires the owed input to have arrived (exactly how Uniswap V3 /
 *     Slipstream settle), at a fixed price for simplicity.
 *   - Morpho / Balancer: lend, call back, then pull / check repayment.
 * The lenders are placed at their real Base addresses with vm.etch because
 * the executor hard-codes those addresses.
 */
import "../../contracts/RouteExecutor.sol";

interface Vm {
    function etch(address target, bytes calldata code) external;
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert() external;
    function deal(address to, uint256 give) external;
}

contract Token {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allow");
        require(balanceOf[f] >= a, "bal");
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

contract V2Pair {
    address public token0;
    address public token1;
    uint256 public feePpm;
    bool public aero; // true: getAmountOut uses the bps model

    constructor(address a, address b, uint256 fee, bool isAero) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        feePpm = fee;
        aero = isAero;
    }

    function getReserves() public view returns (uint112, uint112, uint32) {
        return (uint112(Token(token0).balanceOf(address(this))), uint112(Token(token1).balanceOf(address(this))), 0);
    }

    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256) {
        (uint112 r0, uint112 r1, ) = getReserves();
        (uint256 rIn, uint256 rOut) = tokenIn == token0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 inAfter = amountIn - (amountIn * (feePpm / 100)) / 10_000;
        return (inAfter * rOut) / (rIn + inAfter);
    }

    uint256 private lastR0;
    uint256 private lastR1;

    function sync() external {
        lastR0 = Token(token0).balanceOf(address(this));
        lastR1 = Token(token1).balanceOf(address(this));
    }

    function swap(uint256 out0, uint256 out1, address to, bytes calldata) external {
        // Reserves before this swap are what the pool held before the trader's input arrived.
        uint256 r0 = lastR0;
        uint256 r1 = lastR1;
        if (out0 > 0) Token(token0).transfer(to, out0);
        if (out1 > 0) Token(token1).transfer(to, out1);
        uint256 b0 = Token(token0).balanceOf(address(this));
        uint256 b1 = Token(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - out0 ? b0 - (r0 - out0) : 0;
        uint256 in1 = b1 > r1 - out1 ? b1 - (r1 - out1) : 0;
        require(in0 > 0 || in1 > 0, "no input");
        if (aero) {
            // Aerodrome volatile: fee on input in bps, constant product on the remainder
            uint256 a0 = b0 - (in0 * (feePpm / 100)) / 10_000;
            uint256 a1 = b1 - (in1 * (feePpm / 100)) / 10_000;
            require(a0 * a1 >= r0 * r1, "K");
        } else {
            uint256 a0 = b0 * 1_000_000 - in0 * feePpm;
            uint256 a1 = b1 * 1_000_000 - in1 * feePpm;
            require(a0 * a1 >= r0 * r1 * 1e12, "K");
        }
        lastR0 = b0;
        lastR1 = b1;
    }
}

interface ICLCallback {
    function uniswapV3SwapCallback(int256, int256, bytes calldata) external;
}

/// Fixed-price CL pool: one `a` buys num/den `b`, minus fee. Settles like Uniswap V3.
contract CLPool {
    address public token0;
    address public token1;
    address public a;
    uint256 public num;
    uint256 public den;
    uint256 public feePips;

    constructor(address _a, address b, uint256 _num, uint256 _den, uint256 fee) {
        (token0, token1) = _a < b ? (_a, b) : (b, _a);
        a = _a;
        num = _num;
        den = _den;
        feePips = fee;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data) external returns (int256, int256) {
        require(amountSpecified > 0, "exact in only");
        uint256 amountIn = uint256(amountSpecified);
        uint256 lessFee = (amountIn * (1_000_000 - feePips)) / 1_000_000;
        (address tin, address tout) = zeroForOne ? (token0, token1) : (token1, token0);
        uint256 out = tin == a ? (lessFee * num) / den : (lessFee * den) / num;
        Token(tout).transfer(recipient, out);
        uint256 before = Token(tin).balanceOf(address(this));
        (int256 d0, int256 d1) = zeroForOne ? (int256(amountIn), -int256(out)) : (-int256(out), int256(amountIn));
        ICLCallback(msg.sender).uniswapV3SwapCallback(d0, d1, data);
        require(Token(tin).balanceOf(address(this)) >= before + amountIn, "IIA");
        return (d0, d1);
    }
}

interface IMorphoCb {
    function onMorphoFlashLoan(uint256, bytes calldata) external;
}

contract MockMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        Token(token).transfer(msg.sender, assets);
        IMorphoCb(msg.sender).onMorphoFlashLoan(assets, data);
        Token(token).transferFrom(msg.sender, address(this), assets);
    }
}

interface IBalCb {
    function receiveFlashLoan(address[] calldata, uint256[] calldata, uint256[] calldata, bytes calldata) external;
}

contract MockBalancer {
    function flashLoan(address recipient, address[] calldata tokens, uint256[] calldata amounts, bytes calldata data) external {
        uint256 before = Token(tokens[0]).balanceOf(address(this));
        Token(tokens[0]).transfer(recipient, amounts[0]);
        uint256[] memory fees = new uint256[](1);
        IBalCb(recipient).receiveFlashLoan(tokens, amounts, fees, data);
        require(Token(tokens[0]).balanceOf(address(this)) >= before, "not repaid");
    }
}

/// A fake CL pool a leaked operator key could point a hop at: in its swap it calls the
/// executor's uniswapV3SwapCallback asking it to send out all of a valuable token it holds.
contract ThiefCLPool {
    address public executor;
    address public loot;

    constructor(address _executor, address _loot) {
        executor = _executor;
        loot = _loot;
    }

    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256) {
        uint256 all = Token(loot).balanceOf(executor);
        // Pretend the executor owes us `all` of the loot token.
        ICLCallback(executor).uniswapV3SwapCallback(int256(all), int256(0), abi.encode(loot));
        return (int256(all), int256(0));
    }
}

interface IPancakeCallback {
    function pancakeV3SwapCallback(int256, int256, bytes calldata) external;
}

/// PancakeSwap V3 pool: identical to CLPool but it calls pancakeV3SwapCallback — the one
/// interface difference the executor has to handle. Settles exactly like Uniswap V3.
contract PancakeCLPool {
    address public token0;
    address public token1;
    address public a;
    uint256 public num;
    uint256 public den;
    uint256 public feePips;

    constructor(address _a, address b, uint256 _num, uint256 _den, uint256 fee) {
        (token0, token1) = _a < b ? (_a, b) : (b, _a);
        a = _a;
        num = _num;
        den = _den;
        feePips = fee;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data) external returns (int256, int256) {
        require(amountSpecified > 0, "exact in only");
        uint256 amountIn = uint256(amountSpecified);
        uint256 lessFee = (amountIn * (1_000_000 - feePips)) / 1_000_000;
        (address tin, address tout) = zeroForOne ? (token0, token1) : (token1, token0);
        uint256 out = tin == a ? (lessFee * num) / den : (lessFee * den) / num;
        Token(tout).transfer(recipient, out);
        uint256 before = Token(tin).balanceOf(address(this));
        (int256 d0, int256 d1) = zeroForOne ? (int256(amountIn), -int256(out)) : (-int256(out), int256(amountIn));
        IPancakeCallback(msg.sender).pancakeV3SwapCallback(d0, d1, data);
        require(Token(tin).balanceOf(address(this)) >= before + amountIn, "IIA");
        return (d0, d1);
    }
}

/// A fake Pancake pool a leaked operator key could aim a kind-2 hop at: in its swap it asks the
/// executor's pancakeV3SwapCallback to hand over a valuable token the executor holds.
contract ThiefPancakePool {
    address public executor;
    address public loot;

    constructor(address _executor, address _loot) {
        executor = _executor;
        loot = _loot;
    }

    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256) {
        uint256 all = Token(loot).balanceOf(executor);
        IPancakeCallback(executor).pancakeV3SwapCallback(int256(all), int256(0), abi.encode(loot));
        return (int256(all), int256(0));
    }
}

interface IUnlockCb {
    function unlockCallback(bytes calldata) external returns (bytes memory);
}

/**
 * Minimal but faithful Uniswap V4 singleton PoolManager. A swap runs inside unlock ->
 * unlockCallback, and the caller resolves its currency deltas with sync/settle (pay the input)
 * and take (pull the output). The mock tracks the caller's net delta per currency and REQUIRES
 * both to be zero before unlock returns — the real PoolManager invariant, and the thing that
 * makes a mispriced or buggy V4 hop revert (cost gas) instead of leaking principal.
 *
 * Price is registered per pool as "1 unit of currency0 == num/den units of currency1".
 * Native ETH is currency address(0); `settle` is paid with msg.value, `take` sends ETH.
 */
contract MockV4PoolManager {
    mapping(bytes32 => uint256) public priceNum;
    mapping(bytes32 => uint256) public priceDen;
    mapping(address => int256) public delta; // caller's net per-currency delta during this unlock
    mapping(address => uint256) private synced; // balance snapshot taken by sync()
    address private lastSynced;
    address private swapCur0;
    address private swapCur1;
    bool private swapped;

    receive() external payable {}

    function setPrice(address c0, address c1, uint24 fee, uint256 num, uint256 den) external {
        bytes32 id = keccak256(abi.encode(c0, c1, fee));
        priceNum[id] = num;
        priceDen[id] = den;
    }

    function _bal(address cur) internal view returns (uint256) {
        return cur == address(0) ? address(this).balance : Token(cur).balanceOf(address(this));
    }

    function unlock(bytes calldata data) external returns (bytes memory) {
        swapped = false;
        IUnlockCb(msg.sender).unlockCallback(data);
        require(swapped, "no swap");
        require(delta[swapCur0] == 0 && delta[swapCur1] == 0, "deltas unsettled");
        return "";
    }

    function swap(PoolKeyV4 calldata key, SwapParamsV4 calldata params, bytes calldata) external returns (int256) {
        bytes32 id = keccak256(abi.encode(key.currency0, key.currency1, key.fee));
        uint256 den = priceDen[id];
        require(den != 0, "no price");
        uint256 num = priceNum[id];
        uint256 amountIn = uint256(-params.amountSpecified); // negative == exact input
        uint256 lessFee = (amountIn * (1_000_000 - key.fee)) / 1_000_000;
        address inCur = params.zeroForOne ? key.currency0 : key.currency1;
        address outCur = params.zeroForOne ? key.currency1 : key.currency0;
        uint256 out = params.zeroForOne ? (lessFee * num) / den : (lessFee * den) / num;
        delta[inCur] -= int256(amountIn);
        delta[outCur] += int256(out);
        swapCur0 = key.currency0;
        swapCur1 = key.currency1;
        swapped = true;
        // Pack BalanceDelta: int128 amount0 in the high 128 bits, int128 amount1 in the low 128.
        int128 a0 = params.zeroForOne ? -int128(int256(amountIn)) : int128(int256(out));
        int128 a1 = params.zeroForOne ? int128(int256(out)) : -int128(int256(amountIn));
        return (int256(a0) << 128) | int256(uint256(uint128(a1)));
    }

    function sync(address currency) external {
        lastSynced = currency;
        synced[currency] = _bal(currency);
    }

    function settle() external payable returns (uint256 paid) {
        if (msg.value > 0) {
            delta[address(0)] += int256(msg.value);
            return msg.value;
        }
        paid = _bal(lastSynced) - synced[lastSynced];
        delta[lastSynced] += int256(paid);
    }

    function take(address currency, address to, uint256 amount) external {
        delta[currency] -= int256(amount);
        if (currency == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "eth take");
        } else {
            Token(currency).transfer(to, amount);
        }
    }
}

/// Canonical WETH (0x4200...0006) for the V4 native-ETH tests: an ERC20 plus deposit/withdraw.
contract WethMock {
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

    function approve(address, uint256) external returns (bool) {
        return true;
    }

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 a) external {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a;
        (bool ok, ) = msg.sender.call{value: a}("");
        require(ok, "eth");
    }

    receive() external payable {}
}

contract RouteExecutorTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant PM = 0x498581fF718922c3f8e6A244956aF099B2652b2b; // Uniswap V4 PoolManager
    address constant WETH9 = 0x4200000000000000000000000000000000000006; // canonical WETH on Base

    RouteExecutor ex;
    Token weth;
    Token usdc;
    Token aero;
    V2Pair v2; // WETH/USDC
    V2Pair ae; // USDC/AERO (Aerodrome-style)
    CLPool cl; // AERO/WETH concentrated liquidity (mispriced: AERO is dear here)

    function setUp() public {
        ex = new RouteExecutor();
        weth = new Token();
        usdc = new Token();
        aero = new Token();

        // WETH = 3000 USDC; AERO = 1 USDC on the V2 side.
        v2 = new V2Pair(address(weth), address(usdc), 3000, false);
        _fund(address(v2), weth, 1000e18, usdc, 3_000_000e18);
        ae = new V2Pair(address(usdc), address(aero), 3000, true);
        _fund(address(ae), usdc, 2_000_000e18, aero, 2_000_000e18);
        // CL pool: 1 WETH = 2870 AERO, so AERO is dearer here than via USDC: WETH->USDC->AERO->WETH profits.
        cl = new CLPool(address(weth), address(aero), 2870, 1, 500);
        aero.mint(address(cl), 10_000_000e18);
        weth.mint(address(cl), 10_000e18);

        vm.etch(MORPHO, address(new MockMorpho()).code);
        vm.etch(VAULT, address(new MockBalancer()).code);
        weth.mint(MORPHO, 1000e18);
        weth.mint(VAULT, 1000e18);
    }

    function _fund(address pool, Token a, uint256 x, Token b, uint256 y) internal {
        a.mint(pool, x);
        b.mint(pool, y);
        V2Pair(pool).sync();
    }

    function _route() internal view returns (address[] memory tokens, RouteExecutor.Hop[] memory hops) {
        tokens = new address[](4);
        tokens[0] = address(weth);
        tokens[1] = address(usdc);
        tokens[2] = address(aero);
        tokens[3] = address(weth);
        hops = new RouteExecutor.Hop[](3);
        hops[0] = RouteExecutor.Hop(address(v2), 0, 3000);
        hops[1] = RouteExecutor.Hop(address(ae), 1, 3000);
        hops[2] = RouteExecutor.Hop(address(cl), 2, 500);
    }

    function _simulate(uint256 amountIn, uint8 source) internal returns (uint256 profit) {
        (address[] memory tokens, RouteExecutor.Hop[] memory hops) = _route();
        try ex.simulate(tokens, hops, amountIn, source) {
            revert("simulate must revert");
        } catch (bytes memory err) {
            require(bytes4(err) == RouteExecutor.Simulated.selector, "expected Simulated(profit)");
            assembly {
                profit := mload(add(err, 36))
            }
        }
    }

    function testMorphoFlashRouteProfitsAndMatchesSimulation() public {
        uint256 sim = _simulate(1e18, 1);
        require(sim > 0, "no profit in simulation");
        (address[] memory tokens, RouteExecutor.Hop[] memory hops) = _route();
        uint256 profit = ex.execute(tokens, hops, 1e18, sim, 1);
        require(profit == sim, "execute != simulate");
        require(weth.balanceOf(address(ex)) == profit, "profit not held by executor");
        require(weth.balanceOf(MORPHO) == 1000e18, "Morpho not repaid");
    }

    function testBalancerFlashRoute() public {
        uint256 sim = _simulate(2e18, 2);
        require(sim > 0, "no profit");
        (address[] memory tokens, RouteExecutor.Hop[] memory hops) = _route();
        uint256 profit = ex.execute(tokens, hops, 2e18, 1, 2);
        require(profit == sim, "execute != simulate");
        require(weth.balanceOf(VAULT) == 1000e18, "vault not repaid");
    }

    function testOwnCapitalRoute() public {
        weth.mint(address(ex), 1e18);
        uint256 sim = _simulate(1e18, 0);
        (address[] memory tokens, RouteExecutor.Hop[] memory hops) = _route();
        uint256 profit = ex.execute(tokens, hops, 1e18, 1, 0);
        require(profit == sim && profit > 0, "capital route");
        require(weth.balanceOf(address(ex)) == 1e18 + profit, "balance");
    }

    function testMinProfitGuardReverts() public {
        uint256 sim = _simulate(1e18, 1);
        (address[] memory tokens, RouteExecutor.Hop[] memory hops) = _route();
        try ex.execute(tokens, hops, 1e18, sim + 1, 1) {
            revert("should have reverted");
        } catch (bytes memory err) {
            require(bytes4(err) == RouteExecutor.InsufficientProfit.selector, "wrong error");
        }
    }

    function testLosingDirectionReverts() public {
        // Reverse the cycle: WETH -> AERO (CL) -> USDC -> WETH loses money.
        address[] memory tokens = new address[](4);
        tokens[0] = address(weth);
        tokens[1] = address(aero);
        tokens[2] = address(usdc);
        tokens[3] = address(weth);
        RouteExecutor.Hop[] memory hops = new RouteExecutor.Hop[](3);
        hops[0] = RouteExecutor.Hop(address(cl), 2, 500);
        hops[1] = RouteExecutor.Hop(address(ae), 1, 3000);
        hops[2] = RouteExecutor.Hop(address(v2), 0, 3000);
        try ex.execute(tokens, hops, 1e18, 0, 1) {
            revert("losing route must revert");
        } catch {}
    }

    function testStrangerCannotExecute() public {
        (address[] memory tokens, RouteExecutor.Hop[] memory hops) = _route();
        vm.prank(address(0xBEEF));
        try ex.execute(tokens, hops, 1e18, 0, 1) {
            revert("stranger executed");
        } catch (bytes memory err) {
            require(bytes4(err) == RouteExecutor.NotOperator.selector, "wrong error");
        }
    }

    function testOperatorExecutesButCannotWithdrawOrReassign() public {
        address bot = address(0xB07);
        ex.setOperator(bot);
        require(ex.operator() == bot, "operator not set");
        uint256 sim = _simulate(1e18, 1);
        (address[] memory tokens, RouteExecutor.Hop[] memory hops) = _route();
        vm.prank(bot);
        uint256 profit = ex.execute(tokens, hops, 1e18, sim, 1);
        require(profit == sim && profit > 0, "operator execute");
        // The hot key can trade but never move the profits or change roles.
        vm.prank(bot);
        try ex.withdraw(address(weth), 0) {
            revert("operator withdrew");
        } catch (bytes memory err) {
            require(bytes4(err) == RouteExecutor.NotOwner.selector, "withdraw: wrong error");
        }
        vm.prank(bot);
        try ex.setOperator(bot) {
            revert("operator changed roles");
        } catch (bytes memory err) {
            require(bytes4(err) == RouteExecutor.NotOwner.selector, "setOperator: wrong error");
        }
        // The owner withdraws everything to itself.
        uint256 before = weth.balanceOf(address(this));
        ex.withdraw(address(weth), 0);
        require(weth.balanceOf(address(this)) == before + profit, "owner withdraw");
        // Revoking the operator stops it.
        ex.setOperator(address(0));
        vm.prank(bot);
        try ex.execute(tokens, hops, 1e18, 0, 1) {
            revert("revoked operator executed");
        } catch (bytes memory err) {
            require(bytes4(err) == RouteExecutor.NotOperator.selector, "revoked: wrong error");
        }
    }

    function testStrangerCannotCallCallbacks() public {
        try ex.uniswapV3SwapCallback(1, 0, abi.encode(address(weth))) {
            revert("callback accepted from stranger");
        } catch (bytes memory err) {
            require(bytes4(err) == RouteExecutor.BadCallback.selector, "wrong error");
        }
        try ex.onMorphoFlashLoan(1, "") {
            revert("morpho callback accepted from stranger");
        } catch (bytes memory err) {
            require(bytes4(err) == RouteExecutor.BadCallback.selector, "wrong error");
        }
    }

    function testLeakedOperatorKeyCannotDrainViaFakeCLPool() public {
        address bot = address(0xB07);
        ex.setOperator(bot);
        weth.mint(address(ex), 5e18); // profit sitting in the contract
        ThiefCLPool thief = new ThiefCLPool(address(ex), address(weth));
        // A route whose first hop is the thief "pool": it pulls the WETH in its callback, but the
        // route returns nothing, so the end-of-run balance check (must hold MORE WETH) reverts it all.
        address[] memory tokens = new address[](3);
        tokens[0] = address(weth);
        tokens[1] = address(aero);
        tokens[2] = address(weth);
        RouteExecutor.Hop[] memory hops = new RouteExecutor.Hop[](2);
        hops[0] = RouteExecutor.Hop(address(thief), 2, 500);
        hops[1] = RouteExecutor.Hop(address(ae), 1, 3000);
        vm.prank(bot);
        try ex.execute(tokens, hops, 1e18, 0, 0) {
            revert("drain must revert");
        } catch {}
        require(weth.balanceOf(address(ex)) == 5e18, "profit still in the contract");
        require(weth.balanceOf(address(thief)) == 0, "thief got nothing");
    }

    function testRejectsMalformedRoute() public {
        (address[] memory tokens, RouteExecutor.Hop[] memory hops) = _route();
        tokens[3] = address(usdc); // does not return to the start token
        try ex.execute(tokens, hops, 1e18, 0, 1) {
            revert("malformed route accepted");
        } catch (bytes memory err) {
            require(bytes4(err) == RouteExecutor.BadRoute.selector, "wrong error");
        }
    }

    // =====================================================================
    // PancakeSwap V3 + Uniswap V4 execution (commits 6906269 / f51bfe9)
    // =====================================================================

    /// Generic simulate helper for an arbitrary route (the file's _simulate is pinned to _route()).
    function _sim(address[] memory tokens, RouteExecutor.Hop[] memory hops, uint256 amountIn, uint8 source)
        internal
        returns (uint256 profit)
    {
        try ex.simulate(tokens, hops, amountIn, source) {
            revert("simulate must revert");
        } catch (bytes memory err) {
            require(bytes4(err) == RouteExecutor.Simulated.selector, "expected Simulated(profit)");
            assembly {
                profit := mload(add(err, 36))
            }
        }
    }

    /// Put the V4 PoolManager and canonical WETH at the addresses the contract hard-codes.
    function _etchV4() internal {
        vm.etch(PM, address(new MockV4PoolManager()).code);
        vm.etch(WETH9, address(new WethMock()).code);
    }

    /// A PancakeSwap V3 leg (kind 2, pancakeV3SwapCallback) settles and composes with other hops,
    /// exactly like the Uniswap-V3 leg it mirrors. Same profitable WETH->USDC->AERO->WETH cycle.
    function testPancakeV3RouteSettlesViaAlias() public {
        PancakeCLPool pcl = new PancakeCLPool(address(weth), address(aero), 2870, 1, 500);
        aero.mint(address(pcl), 10_000_000e18);
        weth.mint(address(pcl), 10_000e18);

        address[] memory tokens = new address[](4);
        tokens[0] = address(weth);
        tokens[1] = address(usdc);
        tokens[2] = address(aero);
        tokens[3] = address(weth);
        RouteExecutor.Hop[] memory hops = new RouteExecutor.Hop[](3);
        hops[0] = RouteExecutor.Hop(address(v2), 0, 3000);
        hops[1] = RouteExecutor.Hop(address(ae), 1, 3000);
        hops[2] = RouteExecutor.Hop(address(pcl), 2, 500);

        uint256 sim = _sim(tokens, hops, 1e18, 1);
        require(sim > 0, "no profit via pancake");
        uint256 profit = ex.execute(tokens, hops, 1e18, sim, 1);
        require(profit == sim, "execute != simulate");
        require(weth.balanceOf(address(ex)) == profit, "profit not held by executor");
        require(weth.balanceOf(MORPHO) == 1000e18, "Morpho not repaid");
    }

    /// Uniswap V4, token/token (kind 4): WETH ->(V4 at 3000)-> USDC ->(V2 at 2900)-> WETH profits,
    /// exercising unlock -> swap -> sync/settle -> take and the balanceOf-based hop accounting.
    function testV4TokenRouteProfits() public {
        _etchV4();
        (address c0, address c1) = address(weth) < address(usdc) ? (address(weth), address(usdc)) : (address(usdc), address(weth));
        if (c0 == address(weth)) MockV4PoolManager(payable(PM)).setPrice(c0, c1, 500, 3000, 1);
        else MockV4PoolManager(payable(PM)).setPrice(c0, c1, 500, 1, 3000);
        usdc.mint(PM, 10_000_000e18); // inventory the PoolManager pays out via take()

        V2Pair v2cheap = new V2Pair(address(weth), address(usdc), 3000, false); // WETH cheaper here
        _fund(address(v2cheap), weth, 1000e18, usdc, 2_900_000e18);

        address[] memory tokens = new address[](3);
        tokens[0] = address(weth);
        tokens[1] = address(usdc);
        tokens[2] = address(weth);
        RouteExecutor.Hop[] memory hops = new RouteExecutor.Hop[](2);
        hops[0] = RouteExecutor.Hop(PM, 4, 500); // pool field is ignored for kind 4/5 (POOL_MANAGER is fixed)
        hops[1] = RouteExecutor.Hop(address(v2cheap), 0, 3000);

        uint256 sim = _sim(tokens, hops, 1e18, 1);
        require(sim > 0, "no V4 profit");
        uint256 profit = ex.execute(tokens, hops, 1e18, sim, 1);
        require(profit == sim, "execute != simulate");
        require(weth.balanceOf(address(ex)) == profit, "profit not held");
    }

    /// Uniswap V4, native-ETH pool, WETH as the INPUT (kind 5): the executor unwraps WETH->ETH to
    /// pay (settle{value}) and takes USDC. WETH ->(V4 native at 3000)-> USDC ->(V2 at 2900)-> WETH.
    function testV4NativeInputRouteProfits() public {
        _etchV4();
        MockV4PoolManager(payable(PM)).setPrice(address(0), address(usdc), 500, 3000, 1); // 3000 USDC per ETH
        usdc.mint(PM, 10_000_000e18); // take(USDC) inventory
        vm.deal(WETH9, 100e18); // ETH backing so WETH.withdraw can pay out

        V2Pair v2cheap = new V2Pair(WETH9, address(usdc), 3000, false);
        WethMock(payable(WETH9)).mint(address(v2cheap), 1000e18);
        usdc.mint(address(v2cheap), 2_900_000e18);
        V2Pair(address(v2cheap)).sync();

        WethMock(payable(WETH9)).mint(address(ex), 1e18); // own capital
        address[] memory tokens = new address[](3);
        tokens[0] = WETH9;
        tokens[1] = address(usdc);
        tokens[2] = WETH9;
        RouteExecutor.Hop[] memory hops = new RouteExecutor.Hop[](2);
        hops[0] = RouteExecutor.Hop(PM, 5, 500); // kind 5: the WETH side of this pool is native ETH
        hops[1] = RouteExecutor.Hop(address(v2cheap), 0, 3000);

        uint256 sim = _sim(tokens, hops, 1e18, 0);
        require(sim > 0, "no native-V4 profit");
        uint256 profit = ex.execute(tokens, hops, 1e18, sim, 0);
        require(profit == sim && profit > 0, "execute != simulate");
        require(WethMock(payable(WETH9)).balanceOf(address(ex)) == 1e18 + profit, "profit not held");
    }

    /// Uniswap V4, native-ETH pool, WETH as the OUTPUT (kind 5): the executor takes native ETH and
    /// wraps ETH->WETH on receipt (deposit{value}). USDC ->(V4 native at 3000)-> WETH ->(V2 at 3100)-> USDC.
    function testV4NativeOutputRouteProfits() public {
        _etchV4();
        MockV4PoolManager(payable(PM)).setPrice(address(0), address(usdc), 500, 3000, 1);
        vm.deal(PM, 100e18); // ETH inventory so take(ETH) can pay the executor

        V2Pair v2dear = new V2Pair(WETH9, address(usdc), 3000, false); // WETH dearer here
        WethMock(payable(WETH9)).mint(address(v2dear), 1000e18);
        usdc.mint(address(v2dear), 3_100_000e18);
        V2Pair(address(v2dear)).sync();

        usdc.mint(address(ex), 3000e18); // own capital
        address[] memory tokens = new address[](3);
        tokens[0] = address(usdc);
        tokens[1] = WETH9;
        tokens[2] = address(usdc);
        RouteExecutor.Hop[] memory hops = new RouteExecutor.Hop[](2);
        hops[0] = RouteExecutor.Hop(PM, 5, 500);
        hops[1] = RouteExecutor.Hop(address(v2dear), 0, 3000);

        uint256 sim = _sim(tokens, hops, 3000e18, 0);
        require(sim > 0, "no profit");
        uint256 profit = ex.execute(tokens, hops, 3000e18, sim, 0);
        require(profit == sim && profit > 0, "execute != simulate");
        require(usdc.balanceOf(address(ex)) == 3000e18 + profit, "profit not held");
    }

    /// A mispriced V4 hop costs gas, never principal: price the V4 pool below the V2 return leg so
    /// the round trip loses, and assert the whole execute reverts with the principal untouched.
    function testV4LosingRouteRevertsAndKeepsPrincipal() public {
        _etchV4();
        (address c0, address c1) = address(weth) < address(usdc) ? (address(weth), address(usdc)) : (address(usdc), address(weth));
        if (c0 == address(weth)) MockV4PoolManager(payable(PM)).setPrice(c0, c1, 500, 2800, 1);
        else MockV4PoolManager(payable(PM)).setPrice(c0, c1, 500, 1, 2800);
        usdc.mint(PM, 10_000_000e18);

        V2Pair v2mid = new V2Pair(address(weth), address(usdc), 3000, false);
        _fund(address(v2mid), weth, 1000e18, usdc, 3_000_000e18);

        weth.mint(address(ex), 2e18); // principal sitting in the contract
        address[] memory tokens = new address[](3);
        tokens[0] = address(weth);
        tokens[1] = address(usdc);
        tokens[2] = address(weth);
        RouteExecutor.Hop[] memory hops = new RouteExecutor.Hop[](2);
        hops[0] = RouteExecutor.Hop(PM, 4, 500);
        hops[1] = RouteExecutor.Hop(address(v2mid), 0, 3000);

        try ex.execute(tokens, hops, 1e18, 0, 0) {
            revert("losing V4 route must revert");
        } catch {}
        require(weth.balanceOf(address(ex)) == 2e18, "principal intact");
    }

    /// Neither new callback can be driven by a stranger: with no swap in progress (expectedCaller == 0)
    /// both revert BadCallback, same guard as uniswapV3SwapCallback / onMorphoFlashLoan.
    function testStrangerCannotCallNewCallbacks() public {
        try ex.pancakeV3SwapCallback(int256(1), int256(0), abi.encode(address(weth))) {
            revert("pancake callback accepted from stranger");
        } catch (bytes memory err) {
            require(bytes4(err) == RouteExecutor.BadCallback.selector, "pancake: wrong error");
        }
        bytes memory d = abi.encode(address(weth), address(usdc), uint256(1), uint32(500), false);
        try ex.unlockCallback(d) returns (bytes memory) {
            revert("unlock callback accepted from stranger");
        } catch (bytes memory err) {
            require(bytes4(err) == RouteExecutor.BadCallback.selector, "unlock: wrong error");
        }
    }

    /// The leaked-operator drain guard holds for the Pancake alias too: the thief's callback pulls the
    /// WETH, but the end-of-run balance check reverts the whole tx, so the loot never leaves.
    function testLeakedOperatorCannotDrainViaFakePancakePool() public {
        address bot = address(0xB07);
        ex.setOperator(bot);
        weth.mint(address(ex), 5e18);
        ThiefPancakePool thief = new ThiefPancakePool(address(ex), address(weth));
        address[] memory tokens = new address[](3);
        tokens[0] = address(weth);
        tokens[1] = address(aero);
        tokens[2] = address(weth);
        RouteExecutor.Hop[] memory hops = new RouteExecutor.Hop[](2);
        hops[0] = RouteExecutor.Hop(address(thief), 2, 500);
        hops[1] = RouteExecutor.Hop(address(ae), 1, 3000);
        vm.prank(bot);
        try ex.execute(tokens, hops, 1e18, 0, 0) {
            revert("drain must revert");
        } catch {}
        require(weth.balanceOf(address(ex)) == 5e18, "profit still in the contract");
        require(weth.balanceOf(address(thief)) == 0, "thief got nothing");
    }
}
