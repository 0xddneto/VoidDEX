// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.28;

interface IVoidDexTokenV11 {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title VoidDexPairV11
/// @notice Uniswap V2 constant-product accounting controlled exclusively by one DEX ChainApp.
contract VoidDexPairV11 {
    string public constant name = "VOID DEX LP";
    string public constant symbol = "VOID-LP";
    uint8 public constant decimals = 18;
    uint256 public constant MINIMUM_LIQUIDITY = 1_000;
    uint256 private constant FEE_NUMERATOR = 997;
    uint256 private constant FEE_DENOMINATOR = 1_000;

    address public immutable controller;
    address public immutable token0;
    address public immutable token1;
    uint112 public reserve0;
    uint112 public reserve1;
    uint32 public blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    uint256 private unlocked = 1;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Mint(address indexed provider, uint256 amount0, uint256 amount1);
    event Burn(address indexed provider, uint256 amount0, uint256 amount1);
    event Swap(address indexed user, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out);
    event Sync(uint112 reserve0, uint112 reserve1);

    error NotController(address caller);
    error Locked();
    error InvalidAmount();
    error InsufficientLiquidity();
    error InsufficientOutput();
    error Slippage();
    error TransferFailed();
    error UnsupportedTransferFee(address token, uint256 expected, uint256 received);

    modifier onlyController() { if (msg.sender != controller) revert NotController(msg.sender); _; }
    modifier lock() { if (unlocked != 1) revert Locked(); unlocked = 0; _; unlocked = 1; }

    constructor(address controller_, address token0_, address token1_) {
        if (controller_ == address(0) || token0_ == address(0) || token1_ == address(0) || token0_ == token1_) {
            revert InvalidAmount();
        }
        controller = controller_;
        token0 = token0_;
        token1 = token1_;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function addLiquidity(address provider, uint256 amount0, uint256 amount1, uint256 minLiquidity)
        external onlyController lock returns (uint256 liquidity)
    {
        if (amount0 == 0 || amount1 == 0) revert InvalidAmount();
        uint256 balance0 = _balance(token0);
        uint256 balance1 = _balance(token1);
        uint256 received0 = balance0 - reserve0;
        uint256 received1 = balance1 - reserve1;
        if (received0 != amount0) revert UnsupportedTransferFee(token0, amount0, received0);
        if (received1 != amount1) revert UnsupportedTransferFee(token1, amount1, received1);
        if (totalSupply == 0) {
            liquidity = _sqrt(received0 * received1);
            if (liquidity <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
            _mint(address(0), MINIMUM_LIQUIDITY);
            liquidity -= MINIMUM_LIQUIDITY;
        } else {
            liquidity = _min((received0 * totalSupply) / reserve0, (received1 * totalSupply) / reserve1);
            if (liquidity == 0) revert InsufficientLiquidity();
        }
        if (liquidity < minLiquidity) revert Slippage();
        _mint(provider, liquidity);
        _update(balance0, balance1);
        emit Mint(provider, received0, received1);
    }

    function removeLiquidity(address provider, uint256 liquidity, uint256 min0, uint256 min1)
        external onlyController lock returns (uint256 amount0, uint256 amount1)
    {
        if (liquidity == 0 || balanceOf[provider] < liquidity) revert InvalidAmount();
        amount0 = (liquidity * reserve0) / totalSupply;
        amount1 = (liquidity * reserve1) / totalSupply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidity();
        if (amount0 < min0 || amount1 < min1) revert Slippage();
        _burn(provider, liquidity);
        _safeTransfer(token0, provider, amount0);
        _safeTransfer(token1, provider, amount1);
        _update(_balance(token0), _balance(token1));
        emit Burn(provider, amount0, amount1);
    }

    function swap(address user, bool zeroForOne, uint256 amountIn, uint256 minAmountOut)
        external onlyController lock returns (uint256 amountOut)
    {
        if (amountIn == 0 || reserve0 == 0 || reserve1 == 0) revert InsufficientLiquidity();
        address tokenIn = zeroForOne ? token0 : token1;
        address tokenOut = zeroForOne ? token1 : token0;
        uint256 receivedIn = _balance(tokenIn) - (zeroForOne ? reserve0 : reserve1);
        if (receivedIn != amountIn) revert UnsupportedTransferFee(tokenIn, amountIn, receivedIn);
        amountOut = quote(zeroForOne, receivedIn);
        if (amountOut == 0 || amountOut < minAmountOut) revert InsufficientOutput();
        _safeTransfer(tokenOut, user, amountOut);
        _update(_balance(token0), _balance(token1));
        emit Swap(user, zeroForOne ? amountIn : 0, zeroForOne ? 0 : amountIn, zeroForOne ? 0 : amountOut, zeroForOne ? amountOut : 0);
    }

    function quote(bool zeroForOne, uint256 amountIn) public view returns (uint256) {
        if (amountIn == 0 || reserve0 == 0 || reserve1 == 0) return 0;
        (uint256 reserveIn, uint256 reserveOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        uint256 amountInWithFee = amountIn * FEE_NUMERATOR;
        return (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee);
    }

    function _update(uint256 balance0, uint256 balance1) private {
        if (balance0 > type(uint112).max || balance1 > type(uint112).max) revert InsufficientLiquidity();
        uint32 now32 = uint32(block.timestamp);
        uint32 elapsed;
        unchecked { elapsed = now32 - blockTimestampLast; }
        if (elapsed > 0 && reserve0 != 0 && reserve1 != 0) {
            price0CumulativeLast += ((uint256(reserve1) << 112) / reserve0) * elapsed;
            price1CumulativeLast += ((uint256(reserve0) << 112) / reserve1) * elapsed;
        }
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = now32;
        emit Sync(reserve0, reserve1);
    }
    function _mint(address to, uint256 value) private { totalSupply += value; balanceOf[to] += value; emit Transfer(address(0), to, value); }
    function _burn(address from, uint256 value) private { balanceOf[from] -= value; totalSupply -= value; emit Transfer(from, address(0), value); }
    function _safeTransfer(address token, address to, uint256 value) private {
        (bool ok, bytes memory result) = token.call(abi.encodeCall(IVoidDexTokenV11.transfer, (to, value)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
    function _balance(address token) private view returns (uint256) { return IVoidDexTokenV11(token).balanceOf(address(this)); }
    function _min(uint256 a, uint256 b) private pure returns (uint256) { return a < b ? a : b; }
    function _sqrt(uint256 value) private pure returns (uint256 y) { if (value == 0) return 0; uint256 z = (value + 1) / 2; y = value; while (z < y) { y = z; z = (value / z + z) / 2; } }
}
