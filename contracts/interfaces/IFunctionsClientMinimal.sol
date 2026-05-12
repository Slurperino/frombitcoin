// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFunctionsClientMinimal {
    function handleOracleFulfillment(bytes32 requestId, bytes calldata response, bytes calldata err) external;
}
