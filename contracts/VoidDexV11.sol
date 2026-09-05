// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.28;

import {ChainAppBase, IVoidChainAppRuntime} from "./ChainAppBase.sol";
import {VoidDexPairV11} from "./VoidDexPairV11.sol";

interface IVoidDexMintableTokenV11 {
    function mintTo(address to, uint256 amount) external;
}

/// @title VoidDexV11
/// @notice A single registered ChainApp that owns every pool and routes all Uniswap-style actions.
contract VoidDexV11 is ChainAppBase {
    address public immutable bootstrapOwner;
    address public immutable testAsset0;
    address public immutable testAsset1;
    mapping(address tokenA => mapping(address tokenB => address pool)) public poolFor;
    address[] public allPools;

    event PoolCreated(address indexed token0, address indexed token1, address indexed pool, address creator);
    event TestAssetsClaimed(address indexed user, uint256 amountPerAsset);

    error IdenticalTokens();
    error PoolAlreadyExists(address token0, address token1);
    error UnknownPool(address pool);
    error NotBootstrapOwner(address caller);

    constructor(
        IVoidChainAppRuntime runtime_,
        uint256 chainId_,
        address bootstrapOwner_,
        address testAsset0_,
        address testAsset1_
    )
        ChainAppBase(runtime_, chainId_)
    {
        if (bootstrapOwner_ == address(0) || testAsset0_ == address(0) || testAsset1_ == address(0)) revert ZeroAddress();
        bootstrapOwner = bootstrapOwner_;
        testAsset0 = testAsset0_;
        testAsset1 = testAsset1_;
    }

    function createPool(address tokenA, address tokenB) external onlyFromMyChain returns (address pool) {
        if (tokenA == address(0) || tokenB == address(0)) revert ZeroAddress();
        if (tokenA == tokenB) revert IdenticalTokens();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (poolFor[token0][token1] != address(0)) revert PoolAlreadyExists(token0, token1);
        pool = address(new VoidDexPairV11(address(this), token0, token1));
        poolFor[token0][token1] = pool;
        poolFor[token1][token0] = pool;
        allPools.push(pool);
        emit PoolCreated(token0, token1, pool, caller());
    }

    function addLiquidity(address pool, uint256 amount0, uint256 amount1, uint256 minLiquidity)
        external onlyFromMyChain returns (uint256 liquidity)
    {
        _requirePool(pool);
        VoidDexPairV11 pair = VoidDexPairV11(pool);
        spend(pair.token0(), pool, amount0);
        spend(pair.token1(), pool, amount1);
        return pair.addLiquidity(caller(), amount0, amount1, minLiquidity);
    }

    function removeLiquidity(address pool, uint256 liquidity, uint256 min0, uint256 min1)
        external onlyFromMyChain returns (uint256 amount0, uint256 amount1)
    {
        _requirePool(pool);
        return VoidDexPairV11(pool).removeLiquidity(caller(), liquidity, min0, min1);
    }

    function swap(address pool, bool zeroForOne, uint256 amountIn, uint256 minAmountOut)
        external onlyFromMyChain returns (uint256 amountOut)
    {
        _requirePool(pool);
        VoidDexPairV11 pair = VoidDexPairV11(pool);
        spend(zeroForOne ? pair.token0() : pair.token1(), pool, amountIn);
        return pair.swap(caller(), zeroForOne, amountIn, minAmountOut);
    }

    function claimTestAssets(uint256 amountPerAsset) external onlyFromMyChain {
        if (amountPerAsset == 0 || amountPerAsset > 1_000_000e18) revert ZeroAddress();
        IVoidDexMintableTokenV11(testAsset0).mintTo(caller(), amountPerAsset);
        IVoidDexMintableTokenV11(testAsset1).mintTo(caller(), amountPerAsset);
        emit TestAssetsClaimed(caller(), amountPerAsset);
    }

    function poolsLength() external view returns (uint256) { return allPools.length; }
    function _requirePool(address pool) private view {
        VoidDexPairV11 pair = VoidDexPairV11(pool);
        if (pool == address(0) || poolFor[pair.token0()][pair.token1()] != pool) revert UnknownPool(pool);
    }
}
