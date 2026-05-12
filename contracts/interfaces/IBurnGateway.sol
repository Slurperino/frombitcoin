// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BridgeTypes} from "../types/BridgeTypes.sol";

interface IBurnGateway {
    error BurnPaused();
    error RedeemDeadlineExpired(uint64 deadline, uint256 currentTimestamp);
    error InvalidRedeemAmount(uint64 amountSats);
    error InvalidDestinationScript();
    error InvalidRedeemLimit(uint64 limitSats, uint64 windowSeconds);
    error RedeemLimitExceeded(uint64 limitSats, uint64 usedSats, uint64 requestedSats);
    error InvalidReleaseBtcNetwork(uint32 expectedNetwork, uint32 actualNetwork);
    error InvalidReleaseSourceChain(uint64 expectedChainId, uint64 actualChainId);
    error ReleaseAuthorizationMismatch(bytes32 redeemRequestHash);
    error RedeemIdAlreadyConsumed(bytes32 redeemId);

    event RedeemLimitUpdated(uint64 limitSats, uint64 windowSeconds);
    event RedeemConsumed(
        bytes32 indexed redeemRequestHash,
        bytes32 indexed redeemId,
        bytes32 indexed burnTxHash,
        uint32 burnLogIndex
    );

    event RedeemRequested(
        bytes32 indexed redeemRequestHash,
        address indexed requester,
        bytes32 indexed destinationScriptHash,
        uint64 requestNonce,
        uint64 amountSats,
        uint64 maxMinerFeeSats,
        uint64 deadline,
        bytes destinationScriptPubKey
    );

    function burn(
        bytes calldata destinationScriptPubKey,
        uint64 amountSats,
        uint64 maxMinerFeeSats,
        uint64 deadline
    ) external returns (bytes32 redeemRequestHash, uint64 requestNonce);

    function completeRedeemWithAuthorization(
        BridgeTypes.ReleaseAuthorization calldata authorization,
        bytes calldata attestation
    ) external returns (bytes32 redeemRequestHash, bytes32 redeemId);

    function computeRedeemRequestHash(
        BridgeTypes.RedeemRequest calldata request
    ) external view returns (bytes32 redeemRequestHash);

    function getRedeemRequest(
        bytes32 redeemRequestHash
    ) external view returns (BridgeTypes.RedeemRequest memory request, BridgeTypes.RedeemState state);

    function nextRedeemNonce(address requester) external view returns (uint64);

    function isRedeemIdConsumed(bytes32 redeemId) external view returns (bool);
}
