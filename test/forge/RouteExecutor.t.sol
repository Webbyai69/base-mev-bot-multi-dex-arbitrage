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

contract RouteExecutorTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

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
}
