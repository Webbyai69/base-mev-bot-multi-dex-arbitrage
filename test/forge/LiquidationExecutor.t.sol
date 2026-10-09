// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * EVM tests for contracts/LiquidationExecutor.sol (run with `forge test`).
 *
 * A mock Aave pool models liquidationCall faithfully: it pulls `debtToCover` of
 * the debt asset from the caller (who approved it) and sends back the same value
 * of collateral plus a bonus. The seized collateral is then swapped back to the
 * debt asset through a V2 pool, the flash loan is repaid, and the bonus (minus
 * the swap fee) is the profit. Covers the own-capital and flash paths, the
 * profit guard, role separation, and that a leaked operator key cannot drain the
 * contract (the end-of-run balance invariant undoes any fake-pool trickery).
 */
import "../../contracts/LiquidationExecutor.sol";

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

    constructor(address a, address b, uint256 fee) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        feePpm = fee;
    }

    function getReserves() public view returns (uint112, uint112, uint32) {
        return (uint112(Token(token0).balanceOf(address(this))), uint112(Token(token1).balanceOf(address(this))), 0);
    }

    uint256 private lastR0;
    uint256 private lastR1;

    function sync() external {
        lastR0 = Token(token0).balanceOf(address(this));
        lastR1 = Token(token1).balanceOf(address(this));
    }

    function swap(uint256 out0, uint256 out1, address to, bytes calldata) external {
        uint256 r0 = lastR0;
        uint256 r1 = lastR1;
        if (out0 > 0) Token(token0).transfer(to, out0);
        if (out1 > 0) Token(token1).transfer(to, out1);
        uint256 b0 = Token(token0).balanceOf(address(this));
        uint256 b1 = Token(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - out0 ? b0 - (r0 - out0) : 0;
        uint256 in1 = b1 > r1 - out1 ? b1 - (r1 - out1) : 0;
        require(in0 > 0 || in1 > 0, "no input");
        uint256 a0 = b0 * 1_000_000 - in0 * feePpm;
        uint256 a1 = b1 * 1_000_000 - in1 * feePpm;
        require(a0 * a1 >= r0 * r1 * 1e12, "K");
        lastR0 = b0;
        lastR1 = b1;
    }
}

/// Mock Aave V3 pool: pulls `debtToCover` of debt (caller approved us) and sends
/// collateral worth the same (1:1 price here) plus `bonusBps`.
contract MockAavePool {
    uint256 public bonusBps; // e.g. 800 = +8%

    // No constructor state: vm.etch copies runtime code only, so the bonus is set after etch.
    function setBonus(uint256 b) external {
        bonusBps = b;
    }

    function liquidationCall(address collateralAsset, address debtAsset, address, uint256 debtToCover, bool) external {
        Token(debtAsset).transferFrom(msg.sender, address(this), debtToCover);
        uint256 seized = debtToCover + (debtToCover * bonusBps) / 10_000;
        Token(collateralAsset).transfer(msg.sender, seized);
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

/// A fake swap pool a leaked operator could point the swap hop at, to try to pull the contract's funds.
contract ThiefPool {
    address public token0;
    address public executor;
    address public loot;

    constructor(address _token0, address _executor, address _loot) {
        token0 = _token0;
        executor = _executor;
        loot = _loot;
    }

    function getReserves() external pure returns (uint112, uint112, uint32) {
        return (1e30, 1e30, 0);
    }

    function swap(uint256, uint256, address, bytes calldata) external {
        // Keep whatever was sent, deliver nothing (the run's end balance check then reverts everything).
    }
}

contract LiquidationExecutorTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant AAVE = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant BOT = address(0xB07);
    address constant STRANGER = address(0xBAD);

    LiquidationExecutor ex;
    Token debt; // e.g. USDC
    Token coll; // e.g. cbETH, priced 1:1 with debt in the swap pool for simplicity
    V2Pair pool; // coll/debt, deep, 0.30%
    MockAavePool aave;

    function setUp() public {
        ex = new LiquidationExecutor();
        debt = new Token();
        coll = new Token();
        // Deep 1:1 pool so the collateral->debt swap is ~1:1 minus the 0.30% fee.
        pool = new V2Pair(address(coll), address(debt), 3000);
        coll.mint(address(pool), 1_000_000e18);
        debt.mint(address(pool), 1_000_000e18);
        pool.sync();
        // Aave mock at its real Base address (the contract hard-codes it); +8% bonus, holding collateral.
        aave = new MockAavePool();
        vm.etch(AAVE, address(aave).code);
        MockAavePool(AAVE).setBonus(800);
        coll.mint(AAVE, 1_000_000e18);
        // Fund the flash lender.
        vm.etch(MORPHO, address(new MockMorpho()).code);
        debt.mint(MORPHO, 1_000_000e18);
    }

    function _liq(uint256 debtToCover) internal view returns (LiquidationExecutor.Liq memory) {
        return LiquidationExecutor.Liq({collateralAsset: address(coll), debtAsset: address(debt), user: address(0xdead), debtToCover: debtToCover});
    }

    function _swap() internal view returns (address[] memory tokens, LiquidationExecutor.Hop[] memory hops) {
        tokens = new address[](2);
        tokens[0] = address(coll);
        tokens[1] = address(debt);
        hops = new LiquidationExecutor.Hop[](1);
        hops[0] = LiquidationExecutor.Hop(address(pool), 0, 3000);
    }

    function _simulate(uint256 debtToCover, uint8 source) internal returns (uint256 profit) {
        LiquidationExecutor.Liq memory liq = _liq(debtToCover);
        (address[] memory tokens, LiquidationExecutor.Hop[] memory hops) = _swap();
        try ex.simulate(liq, tokens, hops, source) {
            revert("simulate must revert");
        } catch (bytes memory err) {
            require(bytes4(err) == LiquidationExecutor.Simulated.selector, "expected Simulated(profit)");
            assembly {
                profit := mload(add(err, 36))
            }
        }
    }

    function testMorphoFlashLiquidationProfitsAndMatchesSimulation() public {
        uint256 sim = _simulate(10_000e18, 1);
        require(sim > 0, "no profit in simulation");
        LiquidationExecutor.Liq memory liq = _liq(10_000e18);
        (address[] memory tokens, LiquidationExecutor.Hop[] memory hops) = _swap();
        uint256 profit = ex.liquidate(liq, tokens, hops, sim, 1);
        require(profit == sim, "liquidate != simulate");
        require(debt.balanceOf(address(ex)) == profit, "profit not held by executor");
        require(debt.balanceOf(MORPHO) == 1_000_000e18, "Morpho not repaid");
        // 8% bonus, minus the 0.30% swap fee and the price impact of selling 10,800 into a 1M pool: ~6.5%.
        require(profit > 600e18 && profit < 700e18, "profit in the expected band");
    }

    function testOwnCapitalLiquidation() public {
        debt.mint(address(ex), 10_000e18);
        uint256 sim = _simulate(10_000e18, 0);
        LiquidationExecutor.Liq memory liq = _liq(10_000e18);
        (address[] memory tokens, LiquidationExecutor.Hop[] memory hops) = _swap();
        uint256 profit = ex.liquidate(liq, tokens, hops, 1, 0);
        require(profit == sim && profit > 0, "capital path");
        require(debt.balanceOf(address(ex)) == 10_000e18 + profit, "balance");
    }

    function testMinProfitGuardReverts() public {
        uint256 sim = _simulate(10_000e18, 1);
        LiquidationExecutor.Liq memory liq = _liq(10_000e18);
        (address[] memory tokens, LiquidationExecutor.Hop[] memory hops) = _swap();
        try ex.liquidate(liq, tokens, hops, sim + 1, 1) {
            revert("should have reverted");
        } catch (bytes memory err) {
            require(bytes4(err) == LiquidationExecutor.InsufficientProfit.selector, "wrong error");
        }
    }

    function testUnprofitableBonusReverts() public {
        // A 0.1% bonus can't cover the 0.30% swap fee: the run must revert and lose nothing.
        MockAavePool(AAVE).setBonus(10);
        uint256 before = debt.balanceOf(MORPHO);
        LiquidationExecutor.Liq memory liq = _liq(10_000e18);
        (address[] memory tokens, LiquidationExecutor.Hop[] memory hops) = _swap();
        try ex.liquidate(liq, tokens, hops, 0, 1) {
            revert("thin bonus must revert");
        } catch {}
        require(debt.balanceOf(MORPHO) == before, "flash lender made whole");
        require(debt.balanceOf(address(ex)) == 0, "nothing lost");
    }

    function testStrangerCannotLiquidate() public {
        LiquidationExecutor.Liq memory liq = _liq(10_000e18);
        (address[] memory tokens, LiquidationExecutor.Hop[] memory hops) = _swap();
        vm.prank(STRANGER);
        try ex.liquidate(liq, tokens, hops, 0, 1) {
            revert("stranger liquidated");
        } catch (bytes memory err) {
            require(bytes4(err) == LiquidationExecutor.NotOperator.selector, "wrong error");
        }
    }

    function testOperatorRunsButCannotWithdrawOrReassign() public {
        ex.setOperator(BOT);
        require(ex.operator() == BOT, "operator not set");
        uint256 sim = _simulate(5_000e18, 1);
        LiquidationExecutor.Liq memory liq = _liq(5_000e18);
        (address[] memory tokens, LiquidationExecutor.Hop[] memory hops) = _swap();
        vm.prank(BOT);
        uint256 profit = ex.liquidate(liq, tokens, hops, sim, 1);
        require(profit == sim && profit > 0, "operator liquidate");
        vm.prank(BOT);
        try ex.withdraw(address(debt), 0) {
            revert("operator withdrew");
        } catch (bytes memory err) {
            require(bytes4(err) == LiquidationExecutor.NotOwner.selector, "withdraw: wrong error");
        }
        vm.prank(BOT);
        try ex.setOperator(BOT) {
            revert("operator changed roles");
        } catch (bytes memory err) {
            require(bytes4(err) == LiquidationExecutor.NotOwner.selector, "setOperator: wrong error");
        }
        uint256 bal = debt.balanceOf(address(this));
        ex.withdraw(address(debt), 0);
        require(debt.balanceOf(address(this)) == bal + profit, "owner withdraw");
        ex.setOperator(address(0));
        vm.prank(BOT);
        try ex.liquidate(liq, tokens, hops, 0, 1) {
            revert("revoked operator liquidated");
        } catch (bytes memory err) {
            require(bytes4(err) == LiquidationExecutor.NotOperator.selector, "revoked: wrong error");
        }
    }

    function testStrangerCannotCallCallbacks() public {
        try ex.uniswapV3SwapCallback(1, 0, abi.encode(address(debt))) {
            revert("callback accepted from stranger");
        } catch (bytes memory err) {
            require(bytes4(err) == LiquidationExecutor.BadCallback.selector, "wrong error");
        }
        try ex.onMorphoFlashLoan(1, "") {
            revert("morpho callback accepted from stranger");
        } catch (bytes memory err) {
            require(bytes4(err) == LiquidationExecutor.BadCallback.selector, "wrong error");
        }
    }

    function testLeakedOperatorCannotDrainViaFakeSwapPool() public {
        ex.setOperator(BOT);
        debt.mint(address(ex), 3_000e18); // profit sitting in the contract
        ThiefPool thief = new ThiefPool(address(coll), address(ex), address(debt));
        // Swap hop points at the thief, which keeps the collateral and returns no debt:
        // the end-of-run check (must hold MORE debt) reverts everything.
        address[] memory tokens = new address[](2);
        tokens[0] = address(coll);
        tokens[1] = address(debt);
        LiquidationExecutor.Hop[] memory hops = new LiquidationExecutor.Hop[](1);
        hops[0] = LiquidationExecutor.Hop(address(thief), 0, 3000);
        LiquidationExecutor.Liq memory liq = _liq(1_000e18);
        vm.prank(BOT);
        try ex.liquidate(liq, tokens, hops, 0, 1) {
            revert("drain must revert");
        } catch {}
        require(debt.balanceOf(address(ex)) == 3_000e18, "profit still in the contract");
    }

    function testRejectsMalformedSwapPath() public {
        LiquidationExecutor.Liq memory liq = _liq(10_000e18);
        address[] memory tokens = new address[](2);
        tokens[0] = address(coll);
        tokens[1] = address(coll); // does not end at the debt asset
        LiquidationExecutor.Hop[] memory hops = new LiquidationExecutor.Hop[](1);
        hops[0] = LiquidationExecutor.Hop(address(pool), 0, 3000);
        try ex.liquidate(liq, tokens, hops, 0, 1) {
            revert("malformed path accepted");
        } catch (bytes memory err) {
            require(bytes4(err) == LiquidationExecutor.BadRoute.selector, "wrong error");
        }
    }
}
