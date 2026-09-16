// SPDX-License-Identifier: MIT
pragma solidity ^0.7.3;

// Minimal mocks for testing ArbExecutor in an in-process EVM. Faithful to the
// parts of UniswapV2Pair / Aerodrome Pool that matter: optimistic transfer of
// the output, callback when data is non-empty, and the fee-adjusted K check.

interface IERC20M {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

contract MockERC20 {
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;

    constructor(string memory _symbol, uint8 _decimals) {
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

interface IUniCallee {
    function uniswapV2Call(address, uint256, uint256, bytes calldata) external;
}

interface IAeroCallee {
    function hook(address, uint256, uint256, bytes calldata) external;
}

interface IWeirdCallee {
    function someForkCall(address, uint256, uint256, bytes calldata) external;
}

/// kind: 0 = uniswapV2Call + ppm fee, 1 = Aerodrome hook + bps fee, 2 = unknown callback name + ppm fee
contract MockPair {
    address public token0;
    address public token1;
    uint112 private reserve0;
    uint112 private reserve1;
    uint256 public feePpm;
    uint8 public kind;

    constructor(address _t0, address _t1, uint256 _feePpm, uint8 _kind) {
        token0 = _t0;
        token1 = _t1;
        feePpm = _feePpm;
        kind = _kind;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 0);
    }

    function stable() external pure returns (bool) {
        return false;
    }

    function sync() external {
        reserve0 = uint112(IERC20M(token0).balanceOf(address(this)));
        reserve1 = uint112(IERC20M(token1).balanceOf(address(this)));
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external {
        require(amount0Out > 0 || amount1Out > 0, "INSUFFICIENT_OUTPUT_AMOUNT");
        (uint256 r0, uint256 r1) = (reserve0, reserve1);
        require(amount0Out < r0 && amount1Out < r1, "INSUFFICIENT_LIQUIDITY");
        if (amount0Out > 0) IERC20M(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20M(token1).transfer(to, amount1Out);
        if (data.length > 0) {
            if (kind == 0) IUniCallee(to).uniswapV2Call(msg.sender, amount0Out, amount1Out, data);
            else if (kind == 1) IAeroCallee(to).hook(msg.sender, amount0Out, amount1Out, data);
            else IWeirdCallee(to).someForkCall(msg.sender, amount0Out, amount1Out, data);
        }
        uint256 b0 = IERC20M(token0).balanceOf(address(this));
        uint256 b1 = IERC20M(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - amount0Out ? b0 - (r0 - amount0Out) : 0;
        uint256 in1 = b1 > r1 - amount1Out ? b1 - (r1 - amount1Out) : 0;
        require(in0 > 0 || in1 > 0, "INSUFFICIENT_INPUT_AMOUNT");
        if (kind == 1) {
            // Aerodrome volatile: fee (bps = feePpm/100) taken off the input before the K check.
            uint256 a0 = b0 - (in0 * (feePpm / 100)) / 10000;
            uint256 a1 = b1 - (in1 * (feePpm / 100)) / 10000;
            require(a0 * a1 >= r0 * r1, "K");
        } else {
            uint256 a0 = b0 * 1_000_000 - in0 * feePpm;
            uint256 a1 = b1 * 1_000_000 - in1 * feePpm;
            require(a0 * a1 >= r0 * r1 * 1_000_000 * 1_000_000, "K");
        }
        reserve0 = uint112(b0);
        reserve1 = uint112(b1);
    }
}
