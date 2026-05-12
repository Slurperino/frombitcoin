// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAttestationVerifier} from "./interfaces/IAttestationVerifier.sol";
import {IFunctionsRouterMinimal} from "./interfaces/IFunctionsRouterMinimal.sol";
import {BridgeTypes} from "./types/BridgeTypes.sol";
import {BridgeHasher} from "./libraries/BridgeHasher.sol";
import {Ownable} from "./utils/Ownable.sol";

contract ChainlinkFunctionsVerifier is IAttestationVerifier, Ownable {
    uint8 public constant KIND_MINT = 1;
    uint8 public constant KIND_RELEASE = 2;
    uint16 public constant FUNCTIONS_REQUEST_DATA_VERSION = 1;
    bytes32 public constant CHAINLINK_AUTHORIZATION_CONTEXT =
        keccak256("BitcoinBride.ChainlinkFunctionsAuthorization.V1");

    error OnlyRouterCanFulfill();
    error UnauthorizedRequester(address requester);
    error UnknownRequest(bytes32 requestId);
    error ChainlinkRequestFailed(bytes32 requestId);
    error ChainlinkAuthorizationNotApproved(bytes32 requestId, bytes32 structHash);
    error ChainlinkResponseMismatch(bytes32 requestId, uint8 kind, bytes32 structHash);
    error InvalidFunctionsConfig();

    event FunctionsConfigUpdated(uint64 subscriptionId, bytes32 donId, uint32 callbackGasLimit);
    event AuthorizedRequesterUpdated(address indexed requester, bool allowed);
    event ChainlinkAuthorizationRequested(
        bytes32 indexed requestId,
        uint8 indexed kind,
        bytes32 indexed structHash,
        address requester,
        uint64 deadline
    );
    event ChainlinkAuthorizationApproved(bytes32 indexed requestId, uint8 indexed kind, bytes32 indexed structHash);
    event ChainlinkAuthorizationRejected(
        bytes32 indexed requestId,
        uint8 indexed kind,
        bytes32 indexed structHash,
        bytes err
    );

    struct PendingRequest {
        uint8 kind;
        bytes32 structHash;
        address requester;
        uint64 deadline;
        bool exists;
        bool fulfilled;
        bool approved;
    }

    bytes32 public immutable override bridgeDomain;
    address public immutable functionsRouter;

    uint64 public subscriptionId;
    bytes32 public donId;
    uint32 public callbackGasLimit;

    mapping(address => bool) public authorizedRequester;
    mapping(bytes32 => PendingRequest) public pendingRequests;
    mapping(bytes32 => bool) public approvedAuthorization;

    constructor(
        bytes32 initialBridgeDomain,
        address initialOwner,
        address router,
        uint64 initialSubscriptionId,
        bytes32 initialDonId,
        uint32 initialCallbackGasLimit,
        address[] memory initialRequesters
    ) Ownable(initialOwner) {
        if (router == address(0)) {
            revert InvalidFunctionsConfig();
        }

        bridgeDomain = initialBridgeDomain;
        functionsRouter = router;
        _setFunctionsConfig(initialSubscriptionId, initialDonId, initialCallbackGasLimit);

        for (uint256 i = 0; i < initialRequesters.length; ++i) {
            _setAuthorizedRequester(initialRequesters[i], true);
        }
    }

    function setFunctionsConfig(
        uint64 newSubscriptionId,
        bytes32 newDonId,
        uint32 newCallbackGasLimit
    ) external onlyOwner {
        _setFunctionsConfig(newSubscriptionId, newDonId, newCallbackGasLimit);
    }

    function setAuthorizedRequester(address requester, bool allowed) external onlyOwner {
        _setAuthorizedRequester(requester, allowed);
    }

    function requestMintAuthorization(
        bytes calldata requestData,
        BridgeTypes.MintAuthorization calldata authorization
    ) external returns (bytes32 requestId) {
        if (authorization.bridgeDomain != bridgeDomain) {
            revert InvalidBridgeDomain(bridgeDomain, authorization.bridgeDomain);
        }

        if (block.timestamp > authorization.deadline) {
            revert AuthorizationExpired(authorization.deadline, block.timestamp);
        }

        BridgeTypes.MintAuthorization memory authCopy = authorization;
        requestId = _requestAuthorization(
            KIND_MINT,
            BridgeHasher.mintAuthorizationStructHash(authCopy),
            authorization.deadline,
            requestData
        );
    }

    function requestReleaseAuthorization(
        bytes calldata requestData,
        BridgeTypes.ReleaseAuthorization calldata authorization
    ) external returns (bytes32 requestId) {
        if (authorization.bridgeDomain != bridgeDomain) {
            revert InvalidBridgeDomain(bridgeDomain, authorization.bridgeDomain);
        }

        if (block.timestamp > authorization.deadline) {
            revert AuthorizationExpired(authorization.deadline, block.timestamp);
        }

        BridgeTypes.ReleaseAuthorization memory authCopy = authorization;
        requestId = _requestAuthorization(
            KIND_RELEASE,
            BridgeHasher.releaseAuthorizationStructHash(authCopy),
            authorization.deadline,
            requestData
        );
    }

    function handleOracleFulfillment(bytes32 requestId, bytes calldata response, bytes calldata err) external {
        if (msg.sender != functionsRouter) {
            revert OnlyRouterCanFulfill();
        }

        PendingRequest storage pending = pendingRequests[requestId];
        if (!pending.exists) {
            revert UnknownRequest(requestId);
        }

        pending.fulfilled = true;

        if (err.length != 0 || response.length != 64 || block.timestamp > pending.deadline) {
            emit ChainlinkAuthorizationRejected(requestId, pending.kind, pending.structHash, err);
            return;
        }

        (uint8 responseKind, bytes32 responseStructHash) = abi.decode(response, (uint8, bytes32));
        if (responseKind != pending.kind || responseStructHash != pending.structHash) {
            emit ChainlinkAuthorizationRejected(requestId, pending.kind, pending.structHash, response);
            return;
        }

        bytes32 approvalKey = _approvalKey(requestId, pending.kind, pending.structHash);
        approvedAuthorization[approvalKey] = true;
        pending.approved = true;

        emit ChainlinkAuthorizationApproved(requestId, pending.kind, pending.structHash);
    }

    function verifyMintAuthorization(
        BridgeTypes.MintAuthorization calldata authorization,
        bytes calldata attestation
    ) external view {
        if (authorization.bridgeDomain != bridgeDomain) {
            revert InvalidBridgeDomain(bridgeDomain, authorization.bridgeDomain);
        }

        if (block.timestamp > authorization.deadline) {
            revert AuthorizationExpired(authorization.deadline, block.timestamp);
        }

        BridgeTypes.MintAuthorization memory authCopy = authorization;
        _verifyApproved(KIND_MINT, BridgeHasher.mintAuthorizationStructHash(authCopy), attestation);
    }

    function verifyReleaseAuthorization(
        BridgeTypes.ReleaseAuthorization calldata authorization,
        bytes calldata attestation
    ) external view {
        if (authorization.bridgeDomain != bridgeDomain) {
            revert InvalidBridgeDomain(bridgeDomain, authorization.bridgeDomain);
        }

        if (block.timestamp > authorization.deadline) {
            revert AuthorizationExpired(authorization.deadline, block.timestamp);
        }

        BridgeTypes.ReleaseAuthorization memory authCopy = authorization;
        _verifyApproved(KIND_RELEASE, BridgeHasher.releaseAuthorizationStructHash(authCopy), attestation);
    }

    function authorizationDigest(bytes32 structHash, bytes calldata attestation) external view returns (bytes32) {
        bytes32 requestId = _decodeChainlinkAttestation(attestation);
        return keccak256(abi.encode(CHAINLINK_AUTHORIZATION_CONTEXT, bridgeDomain, requestId, structHash));
    }

    function chainlinkAttestation(bytes32 requestId) external pure returns (bytes memory) {
        return abi.encode(requestId);
    }

    function _requestAuthorization(
        uint8 kind,
        bytes32 structHash,
        uint64 deadline,
        bytes calldata requestData
    ) internal returns (bytes32 requestId) {
        if (!authorizedRequester[msg.sender] && msg.sender != owner) {
            revert UnauthorizedRequester(msg.sender);
        }

        requestId = IFunctionsRouterMinimal(functionsRouter).sendRequest(
            subscriptionId,
            requestData,
            FUNCTIONS_REQUEST_DATA_VERSION,
            callbackGasLimit,
            donId
        );

        pendingRequests[requestId] = PendingRequest({
            kind: kind,
            structHash: structHash,
            requester: msg.sender,
            deadline: deadline,
            exists: true,
            fulfilled: false,
            approved: false
        });

        emit ChainlinkAuthorizationRequested(requestId, kind, structHash, msg.sender, deadline);
    }

    function _verifyApproved(uint8 kind, bytes32 structHash, bytes calldata attestation) internal view {
        bytes32 requestId = _decodeChainlinkAttestation(attestation);
        PendingRequest memory pending = pendingRequests[requestId];
        if (!pending.exists) {
            revert UnknownRequest(requestId);
        }

        if (!pending.fulfilled || !pending.approved) {
            revert ChainlinkRequestFailed(requestId);
        }

        if (pending.kind != kind || pending.structHash != structHash) {
            revert ChainlinkResponseMismatch(requestId, pending.kind, pending.structHash);
        }

        if (!approvedAuthorization[_approvalKey(requestId, kind, structHash)]) {
            revert ChainlinkAuthorizationNotApproved(requestId, structHash);
        }
    }

    function _setFunctionsConfig(uint64 newSubscriptionId, bytes32 newDonId, uint32 newCallbackGasLimit) internal {
        if (newSubscriptionId == 0 || newDonId == bytes32(0) || newCallbackGasLimit == 0) {
            revert InvalidFunctionsConfig();
        }

        subscriptionId = newSubscriptionId;
        donId = newDonId;
        callbackGasLimit = newCallbackGasLimit;

        emit FunctionsConfigUpdated(newSubscriptionId, newDonId, newCallbackGasLimit);
    }

    function _setAuthorizedRequester(address requester, bool allowed) internal {
        if (requester == address(0)) {
            revert InvalidFunctionsConfig();
        }

        authorizedRequester[requester] = allowed;
        emit AuthorizedRequesterUpdated(requester, allowed);
    }

    function _decodeChainlinkAttestation(bytes calldata attestation) internal pure returns (bytes32 requestId) {
        if (attestation.length == 0) {
            revert InvalidAttestation();
        }

        return abi.decode(attestation, (bytes32));
    }

    function _approvalKey(bytes32 requestId, uint8 kind, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(requestId, kind, structHash));
    }
}
