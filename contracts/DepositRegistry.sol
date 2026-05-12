// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IDepositRegistry} from "./interfaces/IDepositRegistry.sol";
import {BridgeTypes} from "./types/BridgeTypes.sol";
import {BridgeHasher} from "./libraries/BridgeHasher.sol";
import {Ownable} from "./utils/Ownable.sol";

contract DepositRegistry is IDepositRegistry, Ownable {
    event ConsumerUpdated(address indexed consumer, bool allowed);
    event ConsumerLocked(address indexed consumer);

    error InvalidDepositIntent();
    error InvalidConsumer(address consumer);
    error ConsumerConfigurationLocked(address lockedConsumer);

    bytes32 public immutable override bridgeDomain;

    mapping(bytes32 => BridgeTypes.DepositIntent) private _depositIntents;
    mapping(bytes32 => bool) private _depositExists;
    mapping(bytes32 => bool) private _depositConsumed;
    mapping(bytes32 => bool) private _utxoConsumed;
    mapping(address => bool) public authorizedConsumers;
    bool public consumerLocked;
    address public lockedConsumer;

    modifier onlyAuthorizedConsumer() {
        if (consumerLocked) {
            if (msg.sender != lockedConsumer) {
                revert Unauthorized(msg.sender);
            }
        } else if (!authorizedConsumers[msg.sender]) {
            revert Unauthorized(msg.sender);
        }
        _;
    }

    constructor(bytes32 initialBridgeDomain, address initialOwner) Ownable(initialOwner) {
        bridgeDomain = initialBridgeDomain;
    }

    function setAuthorizedConsumer(address consumer, bool allowed) external onlyOwner {
        if (consumerLocked) {
            revert ConsumerConfigurationLocked(lockedConsumer);
        }
        authorizedConsumers[consumer] = allowed;
        emit ConsumerUpdated(consumer, allowed);
    }

    function lockAuthorizedConsumer(address consumer) external onlyOwner {
        if (consumerLocked) {
            revert ConsumerConfigurationLocked(lockedConsumer);
        }
        if (consumer == address(0)) {
            revert InvalidConsumer(address(0));
        }

        lockedConsumer = consumer;
        consumerLocked = true;
        authorizedConsumers[consumer] = true;

        emit ConsumerUpdated(consumer, true);
        emit ConsumerLocked(consumer);
    }

    function createDepositIntent(BridgeTypes.DepositIntent calldata intent) external returns (bytes32 depositId_) {
        _validateIntent(intent);

        depositId_ = computeDepositId(intent);
        if (_depositExists[depositId_]) {
            revert DepositIntentAlreadyExists(depositId_);
        }

        _depositExists[depositId_] = true;
        _depositIntents[depositId_] = intent;

        emit DepositIntentCreated(
            depositId_,
            intent.recipient0x,
            intent.depositAddressHash,
            intent.amountMode,
            intent.expectedSats,
            intent.minSats,
            intent.maxSats,
            intent.nonce,
            intent.expiry
        );
    }

    function consumeDeposit(
        bytes32 depositId_,
        bytes32 btcTxId,
        uint32 vout,
        uint64 sats
    ) external onlyAuthorizedConsumer returns (bytes32 utxoKey_) {
        if (!_depositExists[depositId_]) {
            revert DepositIntentNotFound(depositId_);
        }

        if (_depositConsumed[depositId_]) {
            revert DepositAlreadyConsumed(depositId_);
        }

        utxoKey_ = computeUtxoKey(btcTxId, vout);
        if (_utxoConsumed[utxoKey_]) {
            revert UtxoAlreadyConsumed(utxoKey_);
        }

        _depositConsumed[depositId_] = true;
        _utxoConsumed[utxoKey_] = true;

        emit DepositConsumed(depositId_, utxoKey_, btcTxId, vout, sats);
    }

    function computeDepositId(BridgeTypes.DepositIntent calldata intent) public view returns (bytes32 depositId_) {
        BridgeTypes.DepositIntent memory intentCopy = intent;
        return BridgeHasher.depositId(bridgeDomain, intentCopy);
    }

    function computeUtxoKey(bytes32 btcTxId, uint32 vout) public pure returns (bytes32 utxoKey_) {
        return BridgeHasher.utxoKey(btcTxId, vout);
    }

    function getDepositIntent(bytes32 depositId_) external view returns (BridgeTypes.DepositIntent memory intent) {
        if (!_depositExists[depositId_]) {
            revert DepositIntentNotFound(depositId_);
        }

        return _depositIntents[depositId_];
    }

    function isDepositConsumed(bytes32 depositId_) external view returns (bool) {
        return _depositConsumed[depositId_];
    }

    function isUtxoConsumed(bytes32 utxoKey_) external view returns (bool) {
        return _utxoConsumed[utxoKey_];
    }

    function _validateIntent(BridgeTypes.DepositIntent calldata intent) internal view {
        if (intent.recipient0x == address(0) || intent.depositAddressHash == bytes32(0)) {
            revert InvalidDepositIntent();
        }

        if (block.timestamp > intent.expiry) {
            revert InvalidDepositIntent();
        }

        if (intent.amountMode == BridgeTypes.AmountMode.EXACT) {
            if (
                intent.expectedSats == 0 ||
                intent.minSats != intent.expectedSats ||
                intent.maxSats != intent.expectedSats
            ) {
                revert InvalidDepositIntent();
            }
            return;
        }

        if (intent.minSats == 0 || intent.maxSats == 0 || intent.maxSats < intent.minSats) {
            revert InvalidDepositIntent();
        }
    }
}
