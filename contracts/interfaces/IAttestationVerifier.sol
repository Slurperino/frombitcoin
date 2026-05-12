// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BridgeTypes} from "../types/BridgeTypes.sol";

interface IAttestationVerifier {
    error InvalidAttestation();
    error InvalidBridgeDomain(bytes32 expectedDomain, bytes32 actualDomain);
    error AuthorizationExpired(uint64 deadline, uint256 currentTimestamp);
    error UnauthorizedSignerSet(bytes32 signerSetDigest);

    function verifyMintAuthorization(
        BridgeTypes.MintAuthorization calldata authorization,
        bytes calldata attestation
    ) external view;

    function verifyReleaseAuthorization(
        BridgeTypes.ReleaseAuthorization calldata authorization,
        bytes calldata attestation
    ) external view;

    function authorizationDigest(bytes32 structHash, bytes calldata attestation) external view returns (bytes32);

    function bridgeDomain() external view returns (bytes32);
}
