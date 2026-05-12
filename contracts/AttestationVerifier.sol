// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAttestationVerifier} from "./interfaces/IAttestationVerifier.sol";
import {BridgeTypes} from "./types/BridgeTypes.sol";
import {BridgeHasher} from "./libraries/BridgeHasher.sol";
import {ECDSA} from "./libraries/ECDSA.sol";
import {Ownable} from "./utils/Ownable.sol";

contract AttestationVerifier is IAttestationVerifier, Ownable {
    event SignerSetUpdated(bytes32 indexed signerSetDigest, uint256 threshold, address[] signers);

    bytes32 public immutable override bridgeDomain;

    uint256 public threshold;
    bytes32 public signerSetDigest;

    mapping(address => bool) public authorizedSigner;
    address[] private _signers;

    constructor(
        bytes32 initialBridgeDomain,
        address initialOwner,
        address[] memory initialSigners,
        uint256 initialThreshold
    ) Ownable(initialOwner) {
        bridgeDomain = initialBridgeDomain;
        _setSignerSet(initialSigners, initialThreshold);
    }

    function setSignerSet(address[] calldata signers, uint256 newThreshold) external onlyOwner {
        _setSignerSet(signers, newThreshold);
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
        bytes32 structHash = BridgeHasher.mintAuthorizationStructHash(authCopy);
        _verifyAttestation(structHash, attestation);
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
        bytes32 structHash = BridgeHasher.releaseAuthorizationStructHash(authCopy);
        _verifyAttestation(structHash, attestation);
    }

    function authorizationDigest(bytes32 structHash, bytes calldata attestation) external view returns (bytes32) {
        (bytes32 attestedSignerSetDigest,) = _decodeAttestation(attestation);
        return BridgeHasher.authorizationDigest(bridgeDomain, structHash, attestedSignerSetDigest);
    }

    function _setSignerSet(address[] memory signers, uint256 newThreshold) internal {
        uint256 signerCount = signers.length;
        if (newThreshold == 0 || newThreshold > signerCount) {
            revert InvalidAttestation();
        }

        uint256 previousSignerCount = _signers.length;
        for (uint256 i = 0; i < previousSignerCount; ++i) {
            authorizedSigner[_signers[i]] = false;
        }
        delete _signers;

        for (uint256 i = 0; i < signerCount; ++i) {
            if (i > 0 && signers[i - 1] >= signers[i]) {
                revert InvalidAttestation();
            }
            if (signers[i] == address(0)) {
                revert InvalidAttestation();
            }
            authorizedSigner[signers[i]] = true;
            _signers.push(signers[i]);
        }

        threshold = newThreshold;
        signerSetDigest = keccak256(abi.encode(signers, newThreshold));

        emit SignerSetUpdated(signerSetDigest, newThreshold, signers);
    }

    function _verifyAttestation(bytes32 structHash, bytes calldata attestation) internal view {
        (bytes32 attestedSignerSetDigest, bytes[] memory signatures) = _decodeAttestation(attestation);
        if (attestedSignerSetDigest != signerSetDigest) {
            revert UnauthorizedSignerSet(attestedSignerSetDigest);
        }

        uint256 signatureCount = signatures.length;
        if (signatureCount < threshold) {
            revert InvalidAttestation();
        }

        bytes32 digest = BridgeHasher.authorizationDigest(bridgeDomain, structHash, attestedSignerSetDigest);
        bytes32 signedDigest = ECDSA.toEthSignedMessageHash(digest);

        address[] memory recovered = new address[](signatureCount);
        uint256 validSignatures;

        for (uint256 i = 0; i < signatureCount; ++i) {
            address signer = ECDSA.recover(signedDigest, signatures[i]);
            if (!authorizedSigner[signer]) {
                revert InvalidAttestation();
            }

            for (uint256 j = 0; j < validSignatures; ++j) {
                if (recovered[j] == signer) {
                    revert InvalidAttestation();
                }
            }

            recovered[validSignatures] = signer;
            ++validSignatures;
        }

        if (validSignatures < threshold) {
            revert InvalidAttestation();
        }
    }

    function _decodeAttestation(bytes calldata attestation) internal pure returns (bytes32, bytes[] memory) {
        if (attestation.length == 0) {
            revert InvalidAttestation();
        }

        return abi.decode(attestation, (bytes32, bytes[]));
    }

    function decodeAttestation(bytes calldata attestation) external pure returns (bytes32, bytes[] memory) {
        return abi.decode(attestation, (bytes32, bytes[]));
    }
}
