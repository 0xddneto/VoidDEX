// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VoidUniswapV2Pair} from "../contracts/VoidUniswapV2Pair.sol";
import {IVoidChainAppRuntime} from "../contracts/ChainAppBase.sol";

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public feeBps;

    constructor(uint256 feeBps_) { feeBps = feeBps_; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { _move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount);
        allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }
    function _move(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        balanceOf[to] += amount - (amount * feeBps / 10_000);
    }
}

contract MockRuntime is IVoidChainAppRuntime {
    uint256 public executingChain;
    address public executingCaller;
    function execute(address user, uint256 chain, address target, bytes calldata data) external returns (bool, bytes memory) {
        executingCaller = user;
        executingChain = chain;
        (bool ok, bytes memory result) = target.call(data);
        executingCaller = address(0);
        executingChain = 0;
        return (ok, result);
    }
    function spendFrom(address token, address to, uint256 amount) external {
        require(MockToken(token).transferFrom(executingCaller, to, amount));
    }
    function spendNftFrom(address, address, uint256) external pure { revert(); }
}

contract VoidPairTest {
    MockRuntime runtime;
    MockToken token0;
    MockToken token1;
    VoidUniswapV2Pair pair;

    function setUp() public {
        runtime = new MockRuntime();
        token0 = new MockToken(0);
        token1 = new MockToken(0);
        pair = new VoidUniswapV2Pair(runtime, 1, address(token0), address(token1));
        token0.mint(address(this), 1_000_000 ether);
        token1.mint(address(this), 1_000_000 ether);
        token0.approve(address(runtime), type(uint256).max);
        token1.approve(address(runtime), type(uint256).max);
    }

    function testLiquidityAndSwapTrackActualBalances() public {
        (bool added,) = runtime.execute(address(this), 1, address(pair), abi.encodeCall(pair.addLiquidity, (100 ether, 100 ether, 0)));
        require(added, "add failed");
        (bool swapped,) = runtime.execute(address(this), 1, address(pair), abi.encodeCall(pair.swap, (true, 10 ether, 9 ether)));
        require(swapped, "swap failed");
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        require(reserve0 == token0.balanceOf(address(pair)), "phantom reserve0");
        require(reserve1 == token1.balanceOf(address(pair)), "phantom reserve1");
        require(uint256(reserve0) * reserve1 >= 100 ether * 100 ether, "invariant fell");
    }

    function testRejectsFeeOnTransferInput() public {
        MockToken taxed = new MockToken(100);
        VoidUniswapV2Pair taxedPair = new VoidUniswapV2Pair(runtime, 1, address(taxed), address(token1));
        taxed.mint(address(this), 100 ether);
        taxed.approve(address(runtime), type(uint256).max);
        (bool ok,) = runtime.execute(address(this), 1, address(taxedPair), abi.encodeCall(taxedPair.addLiquidity, (10 ether, 10 ether, 0)));
        require(!ok, "taxed token accepted");
        require(taxedPair.totalSupply() == 0, "phantom LP minted");
    }
}

