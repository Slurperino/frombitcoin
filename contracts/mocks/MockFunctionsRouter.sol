// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IFunctionsClientMinimal} from "../interfaces/IFunctionsClientMinimal.sol";

contract MockFunctionsRouter {
    event RequestSent(
        bytes32 indexed requestId,
        address indexed client,
        uint64 subscriptionId,
        uint16 dataVersion,
        uint32 callbackGasLimit,
        bytes32 donId,
        bytes data
    );

    uint256 public nextNonce = 1;
    mapping(bytes32 => address) public requestClient;

    function sendRequest(
        uint64 subscriptionId,
        bytes calldata data,
        uint16 dataVersion,
        uint32 callbackGasLimit,
        bytes32 donId
    ) external returns (bytes32 requestId) {
        requestId = keccak256(abi.encode(block.chainid, msg.sender, nextNonce));
        ++nextNonce;
        requestClient[requestId] = msg.sender;

        emit RequestSent(requestId, msg.sender, subscriptionId, dataVersion, callbackGasLimit, donId, data);
    }

    function fulfill(bytes32 requestId, bytes calldata response, bytes calldata err) external {
        address client = requestClient[requestId];
        require(client != address(0), "unknown request");
        IFunctionsClientMinimal(client).handleOracleFulfillment(requestId, response, err);
    }
}
