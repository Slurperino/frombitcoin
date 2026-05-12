// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BridgeTypes} from "../types/BridgeTypes.sol";

interface IDepositRegistry {
    error DepositIntentAlreadyExists(bytes32 depositId);
    error DepositIntentNotFound(bytes32 depositId);
    error DepositAlreadyConsumed(bytes32 depositId);
    error UtxoAlreadyConsumed(bytes32 utxoKey);

    event DepositIntentCreated(
        bytes32 indexed depositId,
        address indexed recipient0x,
        bytes32 indexed depositAddressHash,
        BridgeTypes.AmountMode amountMode,
        uint64 expectedSats,
        uint64 minSats,
        uint64 maxSats,
        bytes32 nonce,
        uint64 expiry
    );

    event DepositConsumed(
        bytes32 indexed depositId,
        bytes32 indexed utxoKey,
        bytes32 btcTxId,
        uint32 vout,
        uint64 sats
    );

    function createDepositIntent(BridgeTypes.DepositIntent calldata intent) external returns (bytes32 depositId);

    function consumeDeposit(
        bytes32 depositId,
        bytes32 btcTxId,
        uint32 vout,
        uint64 sats
    ) external returns (bytes32 utxoKey);

    function computeDepositId(BridgeTypes.DepositIntent calldata intent) external view returns (bytes32 depositId);

    function computeUtxoKey(bytes32 btcTxId, uint32 vout) external pure returns (bytes32 utxoKey);

    function getDepositIntent(bytes32 depositId) external view returns (BridgeTypes.DepositIntent memory intent);

    function isDepositConsumed(bytes32 depositId) external view returns (bool);

    function isUtxoConsumed(bytes32 utxoKey) external view returns (bool);

    function bridgeDomain() external view returns (bytes32);
}
