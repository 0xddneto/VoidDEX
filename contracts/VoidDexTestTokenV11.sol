// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Valueless EIP-2612 test asset whose permanent minter is the canonical DEX ChainApp.
contract VoidDexTestTokenV11 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;
    address public bootstrapOwner;
    address public dex;
    bytes32 public constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    error NotBootstrapOwner(address caller);
    error NotDex(address caller);
    error AlreadyConfigured();
    error InsufficientBalance(uint256 available, uint256 required);
    error InsufficientAllowance(uint256 available, uint256 required);
    error PermitExpired(uint256 deadline);
    error BadPermitSignature();

    constructor(string memory name_, string memory symbol_, address bootstrapOwner_) {
        if (bootstrapOwner_ == address(0)) revert NotBootstrapOwner(address(0));
        name = name_;
        symbol = symbol_;
        bootstrapOwner = bootstrapOwner_;
    }
    function setDexOnce(address dex_) external {
        if (msg.sender != bootstrapOwner) revert NotBootstrapOwner(msg.sender);
        if (dex != address(0) || dex_ == address(0)) revert AlreadyConfigured();
        dex = dex_;
        bootstrapOwner = address(0);
    }
    function mintTo(address to, uint256 amount) external {
        if (msg.sender != dex) revert NotDex(msg.sender);
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
    function transfer(address to, uint256 value) external returns (bool) { _transfer(msg.sender, to, value); return true; }
    function approve(address spender, uint256 value) external returns (bool) { allowance[msg.sender][spender] = value; emit Approval(msg.sender, spender, value); return true; }
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance(allowed, value);
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak256(bytes(name)), keccak256("1"), block.chainid, address(this)));
    }
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        if (block.timestamp > deadline) revert PermitExpired(deadline);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))));
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != owner) revert BadPermitSignature();
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }
    function _transfer(address from, address to, uint256 value) private {
        uint256 available = balanceOf[from];
        if (available < value) revert InsufficientBalance(available, value);
        unchecked { balanceOf[from] = available - value; balanceOf[to] += value; }
        emit Transfer(from, to, value);
    }
}
