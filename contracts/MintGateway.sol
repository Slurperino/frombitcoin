// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IMintGateway} from "./interfaces/IMintGateway.sol";
import {IDepositRegistry} from "./interfaces/IDepositRegistry.sol";
import {IAttestationVerifier} from "./interfaces/IAttestationVerifier.sol";
import {IBridgeToken} from "./interfaces/IBridgeToken.sol";
import {BridgeTypes} from "./types/BridgeTypes.sol";
import {Ownable} from "./utils/Ownable.sol";

contract MintGateway is IMintGateway, Ownable {
    error InvalidBtcNetwork(uint32 expectedNetwork, uint32 actualNetwork);
    error InsufficientConfirmations(uint32 actualConfirmations, uint32 minimumConfirmations);
    error DepositIntentExpired(uint64 expiry, uint256 currentTimestamp);
    error DepositIdMismatch(bytes32 expectedDepositId, bytes32 actualDepositId);

    event MintPauseUpdated(bool paused);
    event MinimumConfirmationsUpdated(uint32 minimumConfirmations);

    address public immutable override attestationVerifier;
    address public immutable override bridgeToken;
    address public immutable override depositRegistry;

    uint32 public immutable btcNetwork;
    uint32 public minimumConfirmations;
    bool public mintPaused;
    uint64 public mintLimitSats;
    uint64 public mintLimitWindowSeconds;
    uint64 public mintLimitWindowStartedAt;
    uint64 public mintedInCurrentWindow;

    constructor(
        address initialOwner,
        address depositRegistry_,
        address attestationVerifier_,
        address bridgeToken_,
        uint32 btcNetwork_,
        uint32 minimumConfirmations_,
        uint64 initialMintLimitSats,
        uint64 initialMintLimitWindowSeconds
    ) Ownable(initialOwner) {
        depositRegistry = depositRegistry_;
        attestationVerifier = attestationVerifier_;
        bridgeToken = bridgeToken_;
        btcNetwork = btcNetwork_;
        if (minimumConfirmations_ == 0) {
            revert InvalidMinimumConfirmations(minimumConfirmations_);
        }
        minimumConfirmations = minimumConfirmations_;
        _setMintLimit(initialMintLimitSats, initialMintLimitWindowSeconds);
    }

    function setMintPaused(bool paused) external onlyOwner {
        mintPaused = paused;
        emit MintPauseUpdated(paused);
    }

    function setMinimumConfirmations(uint32 newMinimumConfirmations) external onlyOwner {
        if (newMinimumConfirmations == 0) {
            revert InvalidMinimumConfirmations(newMinimumConfirmations);
        }
        minimumConfirmations = newMinimumConfirmations;
        emit MinimumConfirmationsUpdated(newMinimumConfirmations);
    }

    function setMintLimit(uint64 newLimitSats, uint64 newWindowSeconds) external onlyOwner {
        _setMintLimit(newLimitSats, newWindowSeconds);
    }

    function mintWithAuthorization(
        BridgeTypes.DepositIntent calldata intent,
        BridgeTypes.MintAuthorization calldata authorization,
        bytes calldata attestation
    ) external returns (uint256 mintedAmount) {
        if (mintPaused) {
            revert MintPaused();
        }

        if (block.timestamp > intent.expiry) {
            revert DepositIntentExpired(intent.expiry, block.timestamp);
        }

        if (authorization.btcNetwork != btcNetwork) {
            revert InvalidBtcNetwork(btcNetwork, authorization.btcNetwork);
        }

        if (authorization.confirmations < minimumConfirmations) {
            revert InsufficientConfirmations(authorization.confirmations, minimumConfirmations);
        }

        bytes32 expectedDepositId = IDepositRegistry(depositRegistry).computeDepositId(intent);
        if (authorization.depositId != expectedDepositId) {
            revert DepositIdMismatch(expectedDepositId, authorization.depositId);
        }

        if (authorization.recipient0x != intent.recipient0x) {
            revert MintRecipientMismatch(intent.recipient0x, authorization.recipient0x);
        }

        if (authorization.depositAddressHash != intent.depositAddressHash) {
            revert DepositAddressMismatch(intent.depositAddressHash, authorization.depositAddressHash);
        }

        _enforceAmountPolicy(intent, authorization.sats);

        IAttestationVerifier(attestationVerifier).verifyMintAuthorization(authorization, attestation);

        _consumeMintLimit(authorization.sats);

        bytes32 utxoKey = IDepositRegistry(depositRegistry).consumeDeposit(
            authorization.depositId,
            authorization.btcTxId,
            authorization.vout,
            authorization.sats
        );

        mintedAmount = uint256(authorization.sats);
        IBridgeToken(bridgeToken).mint(authorization.recipient0x, mintedAmount);

        emit MintExecuted(
            authorization.depositId,
            utxoKey,
            authorization.recipient0x,
            authorization.sats,
            authorization.btcTxId,
            authorization.vout
        );
    }

    function _enforceAmountPolicy(BridgeTypes.DepositIntent calldata intent, uint64 actualSats) internal pure {
        uint64 minSats = intent.minSats;
        uint64 maxSats = intent.maxSats;

        if (intent.amountMode == BridgeTypes.AmountMode.EXACT) {
            uint64 exactSats = intent.expectedSats;
            if (exactSats == 0 || actualSats != exactSats) {
                revert MintAmountOutOfRange(actualSats, exactSats, exactSats);
            }
            return;
        }

        if (minSats == 0 || maxSats == 0 || maxSats < minSats || actualSats < minSats || actualSats > maxSats) {
            revert MintAmountOutOfRange(actualSats, minSats, maxSats);
        }
    }

    function _setMintLimit(uint64 newLimitSats, uint64 newWindowSeconds) internal {
        if ((newLimitSats == 0 && newWindowSeconds != 0) || (newLimitSats != 0 && newWindowSeconds == 0)) {
            revert InvalidMintLimit(newLimitSats, newWindowSeconds);
        }

        mintLimitSats = newLimitSats;
        mintLimitWindowSeconds = newWindowSeconds;
        mintLimitWindowStartedAt = uint64(block.timestamp);
        mintedInCurrentWindow = 0;

        emit MintLimitUpdated(newLimitSats, newWindowSeconds);
    }

    function _consumeMintLimit(uint64 sats) internal {
        uint64 limitSats = mintLimitSats;
        if (limitSats == 0) {
            return;
        }

        uint64 currentTimestamp = uint64(block.timestamp);
        uint64 windowStartedAt = mintLimitWindowStartedAt;
        if (currentTimestamp >= windowStartedAt && currentTimestamp - windowStartedAt >= mintLimitWindowSeconds) {
            mintLimitWindowStartedAt = currentTimestamp;
            mintedInCurrentWindow = 0;
        }

        uint64 usedSats = mintedInCurrentWindow;
        uint64 nextUsedSats = usedSats + sats;
        if (nextUsedSats > limitSats) {
            revert MintLimitExceeded(limitSats, usedSats, sats);
        }

        mintedInCurrentWindow = nextUsedSats;
    }
}
