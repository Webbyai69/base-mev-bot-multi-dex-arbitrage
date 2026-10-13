// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Base-fork tests for contracts/fleet/CompoundLiquidator.sol. Skipped unless FORK_URL is set:
 *
 *   FORK_URL=<your Base RPC> forge test --match-path "test/forge/fleet/*" -vv
 *
 * They read the real Comet USDC market on Base and run the leaked-operator drain attempt
 * against real contracts (Morpho Blue's real flash loan, real Comet). Optional:
 *   FORK_BLOCK=<n>               pin the fork to a block
 *   COMPOUND_FORK_ACCOUNT=<addr>  an account that is liquidatable at FORK_BLOCK (the monitor
 *                                 logs them); runs the full absorb + buy + swap path
 *   COMPOUND_FORK_POOL=<addr>     a WETH/USDC concentrated-liquidity pool for that swap
 */
import "../../../contracts/fleet/CompoundLiquidator.sol";

interface VmFork {
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256);
    function envOr(string calldata name, address defaultValue) external view returns (address);
    function createSelectFork(string calldata urlOrAlias) external returns (uint256);
    function createSelectFork(string calldata urlOrAlias, uint256 blockNumber) external returns (uint256);
    function skip(bool skipTest) external;
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function deal(address account, uint256 newBalance) external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
}

interface ICometRead {
    function baseToken() external view returns (address);
    function numAssets() external view returns (uint8);
    function isLiquidatable(address account) external view returns (bool);
    function quoteCollateral(address asset, uint256 baseAmount) external view returns (uint256);
    function getReserves() external view returns (int256);
    function targetReserves() external view returns (uint256);
}

interface IWETH {
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract CompoundLiquidatorForkTest {
    VmFork constant vm = VmFork(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Base mainnet. Comet address from compound-finance/comet deployments/base/usdc/roots.json @ f766f51.
    address constant COMET_USDC = 0xb125E6687d4313864e53df431d5425969c15Eb2F;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant OPERATOR = address(0xB0B);

    CompoundLiquidator liq;
    bool forked;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) return;
        uint256 blk = vm.envOr("FORK_BLOCK", uint256(0));
        if (blk == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, blk);
        forked = true;
        liq = new CompoundLiquidator(MORPHO);
        liq.setComet(COMET_USDC, true);
        liq.setOperator(OPERATOR);
    }

    function testForkCometInterfaceMatches() public {
        vm.skip(!forked);
        require(COMET_USDC.code.length > 0, "no code at the Comet USDC proxy");
        require(ICometRead(COMET_USDC).baseToken() == USDC, "base token is USDC");
        require(ICometRead(COMET_USDC).numAssets() > 0, "has collateral assets");
        // 1,000 USDC buys more WETH than 1,000 USDC is worth: quote > 0 is all we can assert without a price feed here
        require(ICometRead(COMET_USDC).quoteCollateral(WETH, 1_000e6) > 0, "quote");
        require(!ICometRead(COMET_USDC).isLiquidatable(address(0xBEEF)), "empty account is not liquidatable");
    }

    function testForkHealthyAccountCannotBeAbsorbed() public {
        vm.skip(!forked);
        address[] memory accts = new address[](1);
        accts[0] = address(0xBEEF);
        CompoundLiquidator.Job memory j =
            CompoundLiquidator.Job({comet: COMET_USDC, accounts: accts, asset: WETH, baseAmount: 1_000e6, minCollateral: 0});
        address[] memory t = new address[](2);
        t[0] = WETH;
        t[1] = USDC;
        CompoundLiquidator.Hop[] memory h = new CompoundLiquidator.Hop[](1);
        h[0] = CompoundLiquidator.Hop({pool: address(0x1), kind: 2, feePpm: 0});
        vm.prank(OPERATOR);
        vm.expectRevert();
        liq.liquidate(j, t, h, 0, 1);
    }

    /// The operator key leaks while the contract holds 5 WETH. With real Morpho and real Comet,
    /// buying collateral and routing it to a pool that keeps it must revert, and the WETH stays.
    function testForkLeakedOperatorDrainAttemptReverts() public {
        vm.skip(!forked);
        vm.deal(address(this), 5 ether);
        IWETH(WETH).deposit{value: 5 ether}();
        IWETH(WETH).transfer(address(liq), 5 ether);

        address sink = address(new ForkSink());
        CompoundLiquidator.Job memory j = CompoundLiquidator.Job({
            comet: COMET_USDC,
            accounts: new address[](0),
            asset: WETH,
            baseAmount: 1_000e6,
            minCollateral: 0
        });
        address[] memory t = new address[](2);
        t[0] = WETH;
        t[1] = USDC;
        CompoundLiquidator.Hop[] memory h = new CompoundLiquidator.Hop[](1);
        h[0] = CompoundLiquidator.Hop({pool: sink, kind: 0, feePpm: 0});

        vm.startPrank(OPERATOR);
        vm.expectRevert(); // NotForSale if reserves are at target, otherwise the flash loan cannot be repaid
        liq.liquidate(j, t, h, 0, 1);
        vm.expectRevert(); // own capital: we hold no USDC, buyCollateral cannot pull it
        liq.liquidate(j, t, h, 0, 0);
        vm.expectRevert(CompoundLiquidator.NotOwner.selector);
        liq.withdraw(WETH, 0);
        vm.stopPrank();

        require(IWETH(WETH).balanceOf(address(liq)) == 5 ether, "WETH untouched");
    }

    /// Full path, only when you name an account that is liquidatable at FORK_BLOCK.
    function testForkAbsorbBuySwap() public {
        address account = vm.envOr("COMPOUND_FORK_ACCOUNT", address(0));
        address pool = vm.envOr("COMPOUND_FORK_POOL", address(0));
        vm.skip(!forked || account == address(0) || pool == address(0));
        require(ICometRead(COMET_USDC).isLiquidatable(account), "COMPOUND_FORK_ACCOUNT is not liquidatable at this block");
        address[] memory accts = new address[](1);
        accts[0] = account;
        uint256 baseAmount = vm.envOr("COMPOUND_FORK_BASE_AMOUNT", uint256(1_000e6));
        CompoundLiquidator.Job memory j =
            CompoundLiquidator.Job({comet: COMET_USDC, accounts: accts, asset: WETH, baseAmount: baseAmount, minCollateral: 0});
        address[] memory t = new address[](2);
        t[0] = WETH;
        t[1] = USDC;
        CompoundLiquidator.Hop[] memory h = new CompoundLiquidator.Hop[](1);
        h[0] = CompoundLiquidator.Hop({pool: pool, kind: 2, feePpm: 0});
        vm.prank(OPERATOR);
        uint256 profit = liq.liquidate(j, t, h, 0, 1);
        require(profit > 0, "profit");
    }
}

contract ForkSink {
    function getReserves() external pure returns (uint256, uint256, uint256) {
        return (1e30, 1e30, 0);
    }

    function swap(uint256, uint256, address, bytes calldata) external {}
}
