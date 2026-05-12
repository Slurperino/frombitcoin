// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IBridgeToken {
    function mint(address to, uint256 amount) external;

    function burnFrom(address from, uint256 amount) external;

    function decimals() external view returns (uint8);

    function totalSupply() external view returns (uint256);
}
