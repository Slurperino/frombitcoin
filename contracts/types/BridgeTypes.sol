// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library BridgeTypes {
    enum AmountMode {
        EXACT,
        ANY
    }

    enum RedeemState {
        NONE,
        BURNED,
        CONSUMED,
        CANCELLED,
        MANUALLY_RESOLVED
    }

    // Address hashes commit to a canonical BTC representation defined in docs/signer-policy-v1.md.
    struct DepositIntent {
        address recipient0x;
        bytes32 depositAddressHash;
        AmountMode amountMode;
        uint64 expectedSats;
        uint64 minSats;
        uint64 maxSats;
        bytes32 nonce;
        uint64 expiry;
    }

    // btcTxId is the displayed txid bytes in canonical order, not little-endian internal serialization.
    struct MintAuthorization {
        bytes32 bridgeDomain;
        bytes32 depositId;
        address recipient0x;
        uint32 btcNetwork;
        bytes32 depositAddressHash;
        bytes32 btcTxId;
        uint32 vout;
        uint64 sats;
        uint32 confirmations;
        uint64 observedBlockHeight;
        uint64 attestationTimestamp;
        uint64 deadline;
    }

    // destinationScriptHash = keccak256(destinationScriptPubKey).
    struct RedeemRequest {
        address requester;
        bytes32 destinationScriptHash;
        uint64 amountSats;
        uint64 maxMinerFeeSats;
        uint64 deadline;
        uint64 requestNonce;
    }

    struct ReleaseAuthorization {
        bytes32 bridgeDomain;
        bytes32 redeemRequestHash;
        bytes32 redeemId;
        uint32 btcNetwork;
        uint64 sourceEvmChainId;
        bytes32 burnTxHash;
        uint32 burnLogIndex;
        address requester;
        bytes32 destinationScriptHash;
        uint64 amountSats;
        uint64 maxMinerFeeSats;
        bytes32 changePolicyHash;
        bytes32 inputsCommitment;
        bytes32 outputsCommitment;
        bytes32 psbtPolicyHash;
        uint64 attestationTimestamp;
        uint64 deadline;
    }
}
