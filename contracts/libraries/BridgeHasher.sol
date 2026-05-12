// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BridgeTypes} from "../types/BridgeTypes.sol";

library BridgeHasher {
    bytes32 internal constant AUTHORIZATION_CONTEXT_HASH = keccak256("BitcoinBride.Authorization.V1");

    function depositId(
        bytes32 bridgeDomain,
        BridgeTypes.DepositIntent memory intent
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(bridgeDomain, intent));
    }

    function utxoKey(bytes32 btcTxId, uint32 vout) internal pure returns (bytes32) {
        return keccak256(abi.encode(btcTxId, vout));
    }

    function mintAuthorizationStructHash(
        BridgeTypes.MintAuthorization memory authorization
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(authorization));
    }

    function redeemRequestHash(
        bytes32 bridgeDomain,
        BridgeTypes.RedeemRequest memory request
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(bridgeDomain, request));
    }

    function redeemId(
        bytes32 bridgeDomain,
        bytes32 burnTxHash,
        uint32 burnLogIndex,
        bytes32 redeemRequestHashValue
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(bridgeDomain, burnTxHash, burnLogIndex, redeemRequestHashValue));
    }

    function releaseAuthorizationStructHash(
        BridgeTypes.ReleaseAuthorization memory authorization
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(authorization));
    }

    function authorizationDigest(bytes32 bridgeDomain, bytes32 structHash, bytes32 signerSetDigest) internal pure returns (bytes32) {
        return keccak256(abi.encode(AUTHORIZATION_CONTEXT_HASH, bridgeDomain, structHash, signerSetDigest));
    }
}
