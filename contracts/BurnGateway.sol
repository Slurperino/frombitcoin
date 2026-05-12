// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IBurnGateway} from "./interfaces/IBurnGateway.sol";
import {IBridgeToken} from "./interfaces/IBridgeToken.sol";
import {IAttestationVerifier} from "./interfaces/IAttestationVerifier.sol";
import {BridgeTypes} from "./types/BridgeTypes.sol";
import {BridgeHasher} from "./libraries/BridgeHasher.sol";
import {Ownable} from "./utils/Ownable.sol";

contract BurnGateway is IBurnGateway, Ownable {
    error RedeemRequestAlreadyExists(bytes32 redeemRequestHash);
    error RedeemRequestNotFound(bytes32 redeemRequestHash);
    error RedeemStateTransitionNotAllowed(BridgeTypes.RedeemState currentState, BridgeTypes.RedeemState nextState);
    error InvalidRedeemFeeBudget(uint64 maxMinerFeeSats, uint64 amountSats);

    event BurnPauseUpdated(bool paused);
    event RedeemStateUpdated(bytes32 indexed redeemRequestHash, BridgeTypes.RedeemState state);

    struct RedeemRecord {
        BridgeTypes.RedeemRequest request;
        BridgeTypes.RedeemState state;
    }

    address public immutable attestationVerifier;
    address public immutable bridgeToken;
    bytes32 public immutable bridgeDomain;
    uint32 public immutable btcNetwork;
    uint64 public immutable sourceEvmChainId;

    bool public burnPaused;
    uint64 public redeemLimitSats;
    uint64 public redeemLimitWindowSeconds;
    uint64 public redeemLimitWindowStartedAt;
    uint64 public redeemedInCurrentWindow;

    mapping(bytes32 => RedeemRecord) private _redeemRecords;
    mapping(address => uint64) private _nextRedeemNonce;
    mapping(bytes32 => bool) private _redeemIdConsumed;

    constructor(
        address initialOwner,
        address bridgeToken_,
        address attestationVerifier_,
        bytes32 initialBridgeDomain,
        uint32 btcNetwork_,
        uint64 sourceEvmChainId_,
        uint64 initialRedeemLimitSats,
        uint64 initialRedeemLimitWindowSeconds
    ) Ownable(initialOwner) {
        bridgeToken = bridgeToken_;
        attestationVerifier = attestationVerifier_;
        bridgeDomain = initialBridgeDomain;
        btcNetwork = btcNetwork_;
        sourceEvmChainId = sourceEvmChainId_;
        _setRedeemLimit(initialRedeemLimitSats, initialRedeemLimitWindowSeconds);
    }

    function setBurnPaused(bool paused) external onlyOwner {
        burnPaused = paused;
        emit BurnPauseUpdated(paused);
    }

    function setRedeemLimit(uint64 newLimitSats, uint64 newWindowSeconds) external onlyOwner {
        _setRedeemLimit(newLimitSats, newWindowSeconds);
    }

    function burn(
        bytes calldata destinationScriptPubKey,
        uint64 amountSats,
        uint64 maxMinerFeeSats,
        uint64 deadline
    ) external returns (bytes32 redeemRequestHash, uint64 requestNonce) {
        if (burnPaused) {
            revert BurnPaused();
        }

        if (!_isAllowedDestinationScript(destinationScriptPubKey)) {
            revert InvalidDestinationScript();
        }

        if (amountSats == 0) {
            revert InvalidRedeemAmount(amountSats);
        }

        if (maxMinerFeeSats >= amountSats) {
            revert InvalidRedeemFeeBudget(maxMinerFeeSats, amountSats);
        }

        if (block.timestamp > deadline) {
            revert RedeemDeadlineExpired(deadline, block.timestamp);
        }

        requestNonce = _nextRedeemNonce[msg.sender];
        _nextRedeemNonce[msg.sender] = requestNonce + 1;

        BridgeTypes.RedeemRequest memory request = BridgeTypes.RedeemRequest({
            requester: msg.sender,
            destinationScriptHash: keccak256(destinationScriptPubKey),
            amountSats: amountSats,
            maxMinerFeeSats: maxMinerFeeSats,
            deadline: deadline,
            requestNonce: requestNonce
        });

        redeemRequestHash = BridgeHasher.redeemRequestHash(bridgeDomain, request);
        if (_redeemRecords[redeemRequestHash].state != BridgeTypes.RedeemState.NONE) {
            revert RedeemRequestAlreadyExists(redeemRequestHash);
        }

        _consumeRedeemLimit(amountSats);

        IBridgeToken(bridgeToken).burnFrom(msg.sender, uint256(amountSats));

        _redeemRecords[redeemRequestHash] = RedeemRecord({request: request, state: BridgeTypes.RedeemState.BURNED});

        emit RedeemRequested(
            redeemRequestHash,
            msg.sender,
            request.destinationScriptHash,
            requestNonce,
            amountSats,
            maxMinerFeeSats,
            deadline,
            destinationScriptPubKey
        );
        emit RedeemStateUpdated(redeemRequestHash, BridgeTypes.RedeemState.BURNED);
    }

    function completeRedeemWithAuthorization(
        BridgeTypes.ReleaseAuthorization calldata authorization,
        bytes calldata attestation
    ) external returns (bytes32 redeemRequestHash, bytes32 redeemId) {
        if (burnPaused) {
            revert BurnPaused();
        }

        if (authorization.btcNetwork != btcNetwork) {
            revert InvalidReleaseBtcNetwork(btcNetwork, authorization.btcNetwork);
        }

        if (authorization.sourceEvmChainId != sourceEvmChainId) {
            revert InvalidReleaseSourceChain(sourceEvmChainId, authorization.sourceEvmChainId);
        }

        redeemRequestHash = authorization.redeemRequestHash;
        RedeemRecord storage record = _redeemRecords[redeemRequestHash];
        BridgeTypes.RedeemState currentState = record.state;
        if (currentState == BridgeTypes.RedeemState.NONE) {
            revert RedeemRequestNotFound(redeemRequestHash);
        }

        if (currentState != BridgeTypes.RedeemState.BURNED) {
            revert RedeemStateTransitionNotAllowed(currentState, BridgeTypes.RedeemState.CONSUMED);
        }

        BridgeTypes.RedeemRequest memory request = record.request;
        if (
            authorization.requester != request.requester ||
            authorization.destinationScriptHash != request.destinationScriptHash ||
            authorization.amountSats != request.amountSats ||
            authorization.maxMinerFeeSats != request.maxMinerFeeSats
        ) {
            revert ReleaseAuthorizationMismatch(redeemRequestHash);
        }

        redeemId = BridgeHasher.redeemId(
            bridgeDomain,
            authorization.burnTxHash,
            authorization.burnLogIndex,
            redeemRequestHash
        );
        if (authorization.redeemId != redeemId) {
            revert ReleaseAuthorizationMismatch(redeemRequestHash);
        }
        if (_redeemIdConsumed[redeemId]) {
            revert RedeemIdAlreadyConsumed(redeemId);
        }

        IAttestationVerifier(attestationVerifier).verifyReleaseAuthorization(authorization, attestation);

        _redeemIdConsumed[redeemId] = true;
        record.state = BridgeTypes.RedeemState.CONSUMED;

        emit RedeemConsumed(redeemRequestHash, redeemId, authorization.burnTxHash, authorization.burnLogIndex);
        emit RedeemStateUpdated(redeemRequestHash, BridgeTypes.RedeemState.CONSUMED);
    }

    function setRedeemState(bytes32 redeemRequestHash, BridgeTypes.RedeemState newState) external onlyOwner {
        RedeemRecord storage record = _redeemRecords[redeemRequestHash];
        BridgeTypes.RedeemState currentState = record.state;
        if (currentState == BridgeTypes.RedeemState.NONE) {
            revert RedeemRequestNotFound(redeemRequestHash);
        }

        if (!_isAllowedStateTransition(currentState, newState)) {
            revert RedeemStateTransitionNotAllowed(currentState, newState);
        }

        record.state = newState;
        emit RedeemStateUpdated(redeemRequestHash, newState);
    }

    function computeRedeemRequestHash(
        BridgeTypes.RedeemRequest calldata request
    ) external view returns (bytes32 redeemRequestHash) {
        BridgeTypes.RedeemRequest memory requestCopy = request;
        return BridgeHasher.redeemRequestHash(bridgeDomain, requestCopy);
    }

    function getRedeemRequest(
        bytes32 redeemRequestHash
    ) external view returns (BridgeTypes.RedeemRequest memory request, BridgeTypes.RedeemState state) {
        RedeemRecord memory record = _redeemRecords[redeemRequestHash];
        if (record.state == BridgeTypes.RedeemState.NONE) {
            revert RedeemRequestNotFound(redeemRequestHash);
        }

        return (record.request, record.state);
    }

    function nextRedeemNonce(address requester) external view returns (uint64) {
        return _nextRedeemNonce[requester];
    }

    function isRedeemIdConsumed(bytes32 redeemId) external view returns (bool) {
        return _redeemIdConsumed[redeemId];
    }

    function _isAllowedStateTransition(
        BridgeTypes.RedeemState currentState,
        BridgeTypes.RedeemState nextState
    ) internal pure returns (bool) {
        if (currentState == BridgeTypes.RedeemState.BURNED) {
            return
                nextState == BridgeTypes.RedeemState.CANCELLED ||
                nextState == BridgeTypes.RedeemState.MANUALLY_RESOLVED;
        }

        if (currentState == BridgeTypes.RedeemState.CANCELLED) {
            return nextState == BridgeTypes.RedeemState.MANUALLY_RESOLVED;
        }

        return false;
    }

    function _setRedeemLimit(uint64 newLimitSats, uint64 newWindowSeconds) internal {
        if ((newLimitSats == 0 && newWindowSeconds != 0) || (newLimitSats != 0 && newWindowSeconds == 0)) {
            revert InvalidRedeemLimit(newLimitSats, newWindowSeconds);
        }

        redeemLimitSats = newLimitSats;
        redeemLimitWindowSeconds = newWindowSeconds;
        redeemLimitWindowStartedAt = uint64(block.timestamp);
        redeemedInCurrentWindow = 0;

        emit RedeemLimitUpdated(newLimitSats, newWindowSeconds);
    }

    function _consumeRedeemLimit(uint64 sats) internal {
        uint64 limitSats = redeemLimitSats;
        if (limitSats == 0) {
            return;
        }

        uint64 currentTimestamp = uint64(block.timestamp);
        uint64 windowStartedAt = redeemLimitWindowStartedAt;
        if (currentTimestamp >= windowStartedAt && currentTimestamp - windowStartedAt >= redeemLimitWindowSeconds) {
            redeemLimitWindowStartedAt = currentTimestamp;
            redeemedInCurrentWindow = 0;
        }

        uint64 usedSats = redeemedInCurrentWindow;
        uint64 nextUsedSats = usedSats + sats;
        if (nextUsedSats > limitSats) {
            revert RedeemLimitExceeded(limitSats, usedSats, sats);
        }

        redeemedInCurrentWindow = nextUsedSats;
    }

    function _isAllowedDestinationScript(bytes calldata script) internal pure returns (bool) {
        if (script.length == 22) {
            return script[0] == 0x00 && script[1] == 0x14;
        }
        if (script.length == 34) {
            return (script[0] == 0x00 && script[1] == 0x20) || (script[0] == 0x51 && script[1] == 0x20);
        }
        return false;
    }
}
