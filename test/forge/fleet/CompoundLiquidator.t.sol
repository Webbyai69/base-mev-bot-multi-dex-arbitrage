// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Tests for contracts/fleet/CompoundLiquidator.sol (`forge test --match-path "test/forge/fleet/*"`).
 *
 * These run everywhere: a small model of a Comet market (our own mock, not Comet code)
 * that sells absorbed collateral at a fixed discount, a Morpho-style flash lender and a
 * constant-product pool. They cover the happy path, the profit floor, and a leaked
 * operator key trying every drain we could think of: each one must revert and leave
 * the contract's balances untouched.
 *
 * The Base-fork tests are in CompoundLiquidatorFork.t.sol and skip unless FORK_URL is set.
 */
import "../../../contracts/fleet/CompoundLiquidator.sol";

interface Vm {
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata data) external;
    function expectRevert() external;
}

contract TToken {
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

/// A toy Comet market: absorb moves an underwater account's collateral into the
/// protocol, buyCollateral sells protocol collateral at `discountBps` below fair value.
contract MockComet {
    error NotLiquidatable();
    error NotForSale();
    error TooMuchSlippage();

    TToken public immutable base;
    TToken public immutable collateral;
    uint256 public immutable fairCollateralPerBase; // 1e18-scaled
    uint256 public immutable discountBps;
    bool public forSale = true;
    mapping(address => uint256) public underwaterCollateral;
    uint256 public absorbed;

    constructor(TToken b, TToken c, uint256 fair, uint256 disc) {
        base = b;
        collateral = c;
        fairCollateralPerBase = fair;
        discountBps = disc;
    }

    function baseToken() external view returns (address) {
        return address(base);
    }

    function setUnderwater(address account, uint256 amount) external {
        underwaterCollateral[account] = amount;
    }

    function setForSale(bool v) external {
        forSale = v;
    }

    function absorb(address, address[] calldata accounts) external {
        for (uint256 i = 0; i < accounts.length; i++) {
            uint256 c = underwaterCollateral[accounts[i]];
            if (c == 0) revert NotLiquidatable();
            underwaterCollateral[accounts[i]] = 0;
            collateral.mint(address(this), c);
            absorbed++;
        }
    }

    function quoteCollateral(address, uint256 baseAmount) public view returns (uint256) {
        return (baseAmount * fairCollateralPerBase / 1e18) * 10_000 / (10_000 - discountBps);
    }

    function buyCollateral(address, uint256 minAmount, uint256 baseAmount, address recipient) external {
        if (!forSale) revert NotForSale();
        uint256 q = quoteCollateral(address(collateral), baseAmount);
        if (q < minAmount) revert TooMuchSlippage();
        require(base.transferFrom(msg.sender, address(this), baseAmount), "pull");
        require(collateral.transfer(recipient, q), "reserves");
    }
}

contract MockMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        require(TToken(token).transfer(msg.sender, assets), "lend");
        CompoundLiquidator(payable(msg.sender)).onMorphoFlashLoan(assets, data);
        require(TToken(token).transferFrom(msg.sender, address(this), assets), "repay");
    }
}

/// Constant-product pair with a ppm fee that checks k on its own balances.
contract Pair {
    address public token0;
    address public token1;
    uint256 public r0;
    uint256 public r1;
    uint256 public feePpm;

    constructor(address a, address b, uint256 fee) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        feePpm = fee;
    }

    function sync() public {
        r0 = TToken(token0).balanceOf(address(this));
        r1 = TToken(token1).balanceOf(address(this));
    }

    function getReserves() external view returns (uint256, uint256, uint256) {
        return (r0, r1, 0);
    }

    function swap(uint256 out0, uint256 out1, address to, bytes calldata) external {
        if (out0 > 0) TToken(token0).transfer(to, out0);
        if (out1 > 0) TToken(token1).transfer(to, out1);
        uint256 b0 = TToken(token0).balanceOf(address(this));
        uint256 b1 = TToken(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - out0 ? b0 - (r0 - out0) : 0;
        uint256 in1 = b1 > r1 - out1 ? b1 - (r1 - out1) : 0;
        uint256 a0 = b0 * 1_000_000 - in0 * feePpm;
        uint256 a1 = b1 * 1_000_000 - in1 * feePpm;
        require(a0 * a1 >= r0 * r1 * 1e12, "k");
        sync();
    }
}

/// Takes whatever it is sent and pays nothing (a leaked operator's "pool").
contract SinkPool {
    function getReserves() external pure returns (uint256, uint256, uint256) {
        return (1e30, 1e30, 0);
    }

    function swap(uint256, uint256, address, bytes calldata) external {}
}

/// A fake concentrated-liquidity pool that tries to claim more than it was offered.
contract GreedyCLPool {
    uint256 public claim;

    constructor(uint256 c) {
        claim = c;
    }

    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256) {
        CompoundLiquidator(payable(msg.sender)).uniswapV3SwapCallback(int256(claim), 0, "");
        return (0, 0);
    }
}

/// A fake pool that, mid-swap, pretends to be the flash lender.
contract ImpostorPool {
    function getReserves() external pure returns (uint256, uint256, uint256) {
        return (1e30, 1e30, 0);
    }

    function swap(uint256, uint256, address, bytes calldata) external {
        CompoundLiquidator(payable(msg.sender)).onMorphoFlashLoan(1, "");
    }
}

contract CompoundLiquidatorTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant OPERATOR = address(0xB0B);
    address constant STRANGER = address(0xBAD);
    address constant BORROWER = address(0xDEB7);

    TToken base;
    TToken weth;
    MockComet comet;
    MockMorpho morpho;
    Pair pair;
    CompoundLiquidator liq;

    function setUp() public {
        base = new TToken();
        weth = new TToken();
        // 1 WETH = 2,000 base; 5% discount on collateral bought from the protocol.
        comet = new MockComet(base, weth, 1e18 / 2000, 500);
        morpho = new MockMorpho();
        base.mint(address(morpho), 10_000_000e18);
        pair = new Pair(address(weth), address(base), 3000);
        weth.mint(address(pair), 1_000e18);
        base.mint(address(pair), 2_000_000e18);
        pair.sync();

        liq = new CompoundLiquidator(address(morpho));
        liq.setComet(address(comet), true);
        liq.setOperator(OPERATOR);
        comet.setUnderwater(BORROWER, 6e18);
    }

    // ---- helpers ------------------------------------------------------------

    function _job(address c, bool withAccount, uint256 baseAmount) internal pure returns (CompoundLiquidator.Job memory j) {
        address[] memory accts = new address[](withAccount ? 1 : 0);
        if (withAccount) accts[0] = BORROWER;
        j = CompoundLiquidator.Job({comet: c, accounts: accts, asset: address(0), baseAmount: baseAmount, minCollateral: 0});
    }

    function _path(address pool, uint8 kind) internal view returns (address[] memory t, CompoundLiquidator.Hop[] memory h) {
        t = new address[](2);
        t[0] = address(weth);
        t[1] = address(base);
        h = new CompoundLiquidator.Hop[](1);
        h[0] = CompoundLiquidator.Hop({pool: pool, kind: kind, feePpm: 3000});
    }

    function _assertEq(uint256 a, uint256 b, string memory why) internal pure {
        require(a == b, why);
    }

    // ---- happy path ---------------------------------------------------------

    function testFlashAbsorbBuySwapIsProfitable() public {
        CompoundLiquidator.Job memory j = _job(address(comet), true, 10_000e18);
        j.asset = address(weth);
        (address[] memory t, CompoundLiquidator.Hop[] memory h) = _path(address(pair), 0);
        vm.prank(OPERATOR);
        uint256 profit = liq.liquidate(j, t, h, 1e18, 1);
        require(profit > 300e18 && profit < 600e18, "profit about 5% of 10k minus fees");
        _assertEq(base.balanceOf(address(liq)), profit, "profit stays in the contract");
        _assertEq(weth.balanceOf(address(liq)), 0, "no collateral left behind");
        _assertEq(comet.absorbed(), 1, "account absorbed");
        _assertEq(base.allowance(address(liq), address(comet)), 0, "no approval left to Comet");
    }

    function testBuyWithoutAbsorb() public {
        weth.mint(address(comet), 10e18); // collateral already held by the protocol
        CompoundLiquidator.Job memory j = _job(address(comet), false, 10_000e18);
        j.asset = address(weth);
        (address[] memory t, CompoundLiquidator.Hop[] memory h) = _path(address(pair), 0);
        vm.prank(OPERATOR);
        require(liq.liquidate(j, t, h, 0, 1) > 0, "profit");
        _assertEq(comet.absorbed(), 0, "nothing absorbed");
    }

    function testProfitFloorReverts() public {
        CompoundLiquidator.Job memory j = _job(address(comet), true, 10_000e18);
        j.asset = address(weth);
        (address[] memory t, CompoundLiquidator.Hop[] memory h) = _path(address(pair), 0);
        vm.prank(OPERATOR);
        vm.expectRevert();
        liq.liquidate(j, t, h, 5_000e18, 1);
        _assertEq(base.balanceOf(address(liq)), 0, "nothing changed");
    }

    function testHealthyAccountReverts() public {
        comet.setUnderwater(BORROWER, 0);
        CompoundLiquidator.Job memory j = _job(address(comet), true, 10_000e18);
        j.asset = address(weth);
        (address[] memory t, CompoundLiquidator.Hop[] memory h) = _path(address(pair), 0);
        vm.prank(OPERATOR);
        vm.expectRevert(MockComet.NotLiquidatable.selector);
        liq.liquidate(j, t, h, 0, 1);
    }

    function testNotForSaleReverts() public {
        comet.setForSale(false);
        CompoundLiquidator.Job memory j = _job(address(comet), true, 10_000e18);
        j.asset = address(weth);
        (address[] memory t, CompoundLiquidator.Hop[] memory h) = _path(address(pair), 0);
        vm.prank(OPERATOR);
        vm.expectRevert(MockComet.NotForSale.selector);
        liq.liquidate(j, t, h, 0, 1);
    }

    function testSimulateRevertsWithProfit() public {
        CompoundLiquidator.Job memory j = _job(address(comet), true, 10_000e18);
        j.asset = address(weth);
        (address[] memory t, CompoundLiquidator.Hop[] memory h) = _path(address(pair), 0);
        vm.prank(OPERATOR);
        (bool ok, bytes memory ret) = address(liq).call(abi.encodeCall(CompoundLiquidator.simulate, (j, t, h, 1)));
        require(!ok && bytes4(ret) == CompoundLiquidator.Simulated.selector, "Simulated(profit)");
        _assertEq(base.balanceOf(address(liq)), 0, "simulate changes nothing");
    }

    // ---- a leaked operator key costs gas, never principal -------------------

    /// The operator key leaks while the contract holds 50,000 base of profit and 10 WETH.
    /// Every route the attacker controls must revert with balances untouched.
    function testLeakedOperatorDrainAttemptReverts() public {
        base.mint(address(liq), 50_000e18);
        weth.mint(address(liq), 10e18);
        weth.mint(address(comet), 100e18);

        vm.startPrank(OPERATOR);

        // 1. admin functions
        vm.expectRevert(CompoundLiquidator.NotOwner.selector);
        liq.withdraw(address(base), 0);
        vm.expectRevert(CompoundLiquidator.NotOwner.selector);
        liq.withdrawETH();
        vm.expectRevert(CompoundLiquidator.NotOwner.selector);
        liq.setOperator(STRANGER);
        vm.expectRevert(CompoundLiquidator.NotOwner.selector);
        liq.setComet(STRANGER, true);
        vm.expectRevert(CompoundLiquidator.NotOwner.selector);
        liq.transferOwnership(STRANGER);

        // 2. a fake "Comet" that would pull our approved base token
        MockComet fake = new MockComet(base, weth, 1e18 / 2000, 500);
        CompoundLiquidator.Job memory j = _job(address(fake), false, 50_000e18);
        j.asset = address(weth);
        (address[] memory t, CompoundLiquidator.Hop[] memory h) = _path(address(pair), 0);
        vm.expectRevert(abi.encodeWithSelector(CompoundLiquidator.CometNotAllowed.selector, address(fake)));
        liq.liquidate(j, t, h, 0, 0);

        // 3. own capital through a pool that keeps everything
        j = _job(address(comet), false, 50_000e18);
        j.asset = address(weth);
        (t, h) = _path(address(new SinkPool()), 0);
        vm.expectRevert();
        liq.liquidate(j, t, h, 0, 0);

        // 4. flash loan through the same sink: cannot repay, reverts
        vm.expectRevert();
        liq.liquidate(j, t, h, 0, 1);

        // 5. a concentrated-liquidity "pool" claiming our 10 WETH on top of the swap
        j = _job(address(comet), false, 1_000e18);
        j.asset = address(weth);
        (t, h) = _path(address(new GreedyCLPool(20e18)), 2);
        vm.expectRevert();
        liq.liquidate(j, t, h, 0, 1);

        // 6. a pool that pretends to be the flash lender mid-swap
        (t, h) = _path(address(new ImpostorPool()), 0);
        vm.expectRevert(CompoundLiquidator.BadCallback.selector);
        liq.liquidate(j, t, h, 0, 1);

        // 7. a swap path that does not end in the base token
        t[1] = address(weth);
        vm.expectRevert(CompoundLiquidator.BadRoute.selector);
        liq.liquidate(j, t, h, 0, 1);

        vm.stopPrank();

        _assertEq(base.balanceOf(address(liq)), 50_000e18, "base untouched");
        _assertEq(weth.balanceOf(address(liq)), 10e18, "WETH untouched");

        // the owner can still take everything out
        liq.withdraw(address(base), 0);
        liq.withdraw(address(weth), 0);
        _assertEq(base.balanceOf(address(this)), 50_000e18, "owner withdrew base");
    }

    function testGreedyCallbackIsCappedAtAmountIn() public {
        weth.mint(address(liq), 10e18);
        weth.mint(address(comet), 100e18);
        CompoundLiquidator.Job memory j = _job(address(comet), false, 1_000e18);
        j.asset = address(weth);
        (address[] memory t, CompoundLiquidator.Hop[] memory h) = _path(address(new GreedyCLPool(20e18)), 2);
        vm.prank(OPERATOR);
        // bought = 1000/2000/0.95 = 0.526 WETH; the pool asks for 20 WETH
        vm.expectRevert(abi.encodeWithSelector(CompoundLiquidator.OverClaim.selector, 20e18, uint256(526315789473684210)));
        liq.liquidate(j, t, h, 0, 1);
    }

    function testStrangersAndRevokedOperatorsAreRefused() public {
        CompoundLiquidator.Job memory j = _job(address(comet), true, 10_000e18);
        j.asset = address(weth);
        (address[] memory t, CompoundLiquidator.Hop[] memory h) = _path(address(pair), 0);
        vm.prank(STRANGER);
        vm.expectRevert(CompoundLiquidator.NotOperator.selector);
        liq.liquidate(j, t, h, 0, 1);

        liq.setOperator(address(0));
        vm.prank(OPERATOR);
        vm.expectRevert(CompoundLiquidator.NotOperator.selector);
        liq.liquidate(j, t, h, 0, 1);

        vm.prank(STRANGER);
        vm.expectRevert(CompoundLiquidator.BadCallback.selector);
        liq.onMorphoFlashLoan(1, "");

        vm.prank(address(morpho)); // even the lender, when we did not ask for a loan
        vm.expectRevert(CompoundLiquidator.BadCallback.selector);
        liq.onMorphoFlashLoan(1, "");

        vm.prank(STRANGER);
        vm.expectRevert(CompoundLiquidator.BadCallback.selector);
        liq.uniswapV3SwapCallback(1, 0, "");
    }
}
