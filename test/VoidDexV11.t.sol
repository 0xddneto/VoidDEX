// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VoidDexV11} from "../contracts/VoidDexV11.sol";
import {VoidDexPairV11} from "../contracts/VoidDexPairV11.sol";
import {IVoidChainAppRuntime} from "../contracts/ChainAppBase.sol";

contract V11Token {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public minter;

    constructor() { minter = msg.sender; }
    function setMinter(address value) external { require(msg.sender == minter); minter = value; }
    function mintTo(address to, uint256 value) external { require(msg.sender == minter); balanceOf[to] += value; }
    function mint(address to, uint256 value) external { balanceOf[to] += value; }
    function approve(address spender, uint256 value) external returns (bool) { allowance[msg.sender][spender] = value; return true; }
    function transfer(address to, uint256 value) external returns (bool) { balanceOf[msg.sender] -= value; balanceOf[to] += value; return true; }
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 permitted = allowance[from][msg.sender];
        require(permitted >= value);
        allowance[from][msg.sender] = permitted - value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        return true;
    }
}

contract V11Runtime is IVoidChainAppRuntime {
    uint256 public executingChain;
    address public executingCaller;

    function run(address user, uint256 chain, address target, bytes calldata data) external returns (bool, bytes memory) {
        executingCaller = user;
        executingChain = chain;
        (bool ok, bytes memory result) = target.call(data);
        executingCaller = address(0);
        executingChain = 0;
        return (ok, result);
    }

    function spendFrom(address token, address to, uint256 amount) external {
        require(V11Token(token).transferFrom(executingCaller, to, amount));
    }
    function spendNftFrom(address, address, uint256) external pure { revert(); }
}

contract VoidDexV11Test {
    V11Runtime private runtime;
    V11Token private token0;
    V11Token private token1;
    VoidDexV11 private dex;
    VoidDexPairV11 private pair;

    function setUp() public {
        runtime = new V11Runtime();
        token0 = new V11Token();
        token1 = new V11Token();
        dex = new VoidDexV11(runtime, 1, address(this), address(token0), address(token1));
        token0.setMinter(address(dex));
        token1.setMinter(address(dex));

        (bool created, bytes memory result) = runtime.run(
            address(this), 1, address(dex), abi.encodeCall(dex.createPool, (address(token0), address(token1)))
        );
        require(created, "pool creation failed");
        pair = VoidDexPairV11(abi.decode(result, (address)));
        token0.mint(address(this), 1_000_000 ether);
        token1.mint(address(this), 1_000_000 ether);
        token0.approve(address(runtime), type(uint256).max);
        token1.approve(address(runtime), type(uint256).max);
    }

    function testOnlyRuntimeCanReachDex() public {
        (bool ok,) = address(dex).call(abi.encodeCall(dex.swap, (address(pair), true, 1 ether, 0)));
        require(!ok, "direct execution bypassed runtime");
    }

    function testWrongChainCannotReachDex() public {
        (bool ok,) = runtime.run(address(this), 2, address(dex), abi.encodeCall(dex.claimTestAssets, (1 ether)));
        require(!ok, "wrong chain reached app");
    }

    function testLiquiditySwapAndRemovalPreserveBalances() public {
        (bool added,) = runtime.run(
            address(this), 1, address(dex), abi.encodeCall(dex.addLiquidity, (address(pair), 100 ether, 100 ether, 0))
        );
        require(added, "liquidity failed");
        uint256 productBefore = uint256(pair.reserve0()) * pair.reserve1();

        (bool swapped,) = runtime.run(
            address(this), 1, address(dex), abi.encodeCall(dex.swap, (address(pair), true, 10 ether, 9 ether))
        );
        require(swapped, "swap failed");
        require(uint256(pair.reserve0()) * pair.reserve1() >= productBefore, "constant product fell");
        require(pair.reserve0() == token0.balanceOf(address(pair)), "reserve0 mismatch");
        require(pair.reserve1() == token1.balanceOf(address(pair)), "reserve1 mismatch");

        uint256 shares = pair.balanceOf(address(this)) / 2;
        (bool removed,) = runtime.run(
            address(this), 1, address(dex), abi.encodeCall(dex.removeLiquidity, (address(pair), shares, 1, 1))
        );
        require(removed, "removal failed");
        require(pair.reserve0() == token0.balanceOf(address(pair)), "reserve0 after burn");
        require(pair.reserve1() == token1.balanceOf(address(pair)), "reserve1 after burn");
    }

    function testUnknownPoolRejected() public {
        VoidDexPairV11 fake = new VoidDexPairV11(address(dex), address(token0), address(token1));
        (bool ok,) = runtime.run(
            address(this), 1, address(dex), abi.encodeCall(dex.swap, (address(fake), true, 1 ether, 0))
        );
        require(!ok, "unregistered pool accepted");
    }

    function testClaimIsBounded() public {
        (bool ok,) = runtime.run(address(this), 1, address(dex), abi.encodeCall(dex.claimTestAssets, (1_000_001 ether)));
        require(!ok, "oversized claim accepted");
        (ok,) = runtime.run(address(this), 1, address(dex), abi.encodeCall(dex.claimTestAssets, (1_000 ether)));
        require(ok, "valid claim failed");
        require(token0.balanceOf(address(this)) == 1_001_000 ether, "claim token0 mismatch");
        require(token1.balanceOf(address(this)) == 1_001_000 ether, "claim token1 mismatch");
    }
}
