// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IBridgeToken} from "./interfaces/IBridgeToken.sol";
import {Ownable} from "./utils/Ownable.sol";

contract WrappedBitcoin is IBridgeToken, Ownable {
    error InvalidAddress(address account);
    error InsufficientBalance(address account, uint256 balance, uint256 requested);
    error InsufficientAllowance(address spender, uint256 allowance, uint256 requested);
    error NotMinter(address account);
    error MinterConfigurationLocked(address lockedMinter);

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MinterUpdated(address indexed minter, bool allowed);
    event MinterLocked(address indexed minter);

    string public name;
    string public symbol;
    uint8 public immutable override decimals;

    uint256 public override totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isMinter;

    bool public minterLocked;
    address public lockedMinter;

    constructor(
        address initialOwner,
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) Ownable(initialOwner) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function setMinter(address minter, bool allowed) external onlyOwner {
        if (minterLocked) {
            revert MinterConfigurationLocked(lockedMinter);
        }
        if (minter == address(0)) {
            revert InvalidAddress(address(0));
        }

        isMinter[minter] = allowed;
        emit MinterUpdated(minter, allowed);
    }

    function lockMinter(address minter) external onlyOwner {
        if (minterLocked) {
            revert MinterConfigurationLocked(lockedMinter);
        }
        if (minter == address(0)) {
            revert InvalidAddress(address(0));
        }

        lockedMinter = minter;
        minterLocked = true;
        isMinter[minter] = true;

        emit MinterUpdated(minter, true);
        emit MinterLocked(minter);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 currentAllowance = allowance[from][msg.sender];
        if (currentAllowance < amount) {
            revert InsufficientAllowance(msg.sender, currentAllowance, amount);
        }

        if (currentAllowance != type(uint256).max) {
            allowance[from][msg.sender] = currentAllowance - amount;
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }

        _transfer(from, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external {
        if (minterLocked) {
            if (msg.sender != lockedMinter) {
                revert NotMinter(msg.sender);
            }
        } else if (!isMinter[msg.sender]) {
            revert NotMinter(msg.sender);
        }

        if (to == address(0)) {
            revert InvalidAddress(address(0));
        }

        totalSupply += amount;
        balanceOf[to] += amount;

        emit Transfer(address(0), to, amount);
    }

    function burnFrom(address from, uint256 amount) external {
        uint256 currentAllowance = allowance[from][msg.sender];
        if (currentAllowance < amount) {
            revert InsufficientAllowance(msg.sender, currentAllowance, amount);
        }

        if (currentAllowance != type(uint256).max) {
            allowance[from][msg.sender] = currentAllowance - amount;
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }

        _burn(from, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) {
            revert InvalidAddress(address(0));
        }

        uint256 balance = balanceOf[from];
        if (balance < amount) {
            revert InsufficientBalance(from, balance, amount);
        }

        unchecked {
            balanceOf[from] = balance - amount;
        }
        balanceOf[to] += amount;

        emit Transfer(from, to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        uint256 balance = balanceOf[from];
        if (balance < amount) {
            revert InsufficientBalance(from, balance, amount);
        }

        unchecked {
            balanceOf[from] = balance - amount;
            totalSupply -= amount;
        }

        emit Transfer(from, address(0), amount);
    }
}
