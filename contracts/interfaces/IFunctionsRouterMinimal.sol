// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFunctionsRouterMinimal {
    function sendRequest(
        uint64 subscriptionId,
        bytes calldata data,
        uint16 dataVersion,
        uint32 callbackGasLimit,
        bytes32 donId
    ) external returns (bytes32 requestId);
}
