// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BridgeTypes} from "../types/BridgeTypes.sol";

interface IMintGateway {
    error MintPaused();
    error MintRecipientMismatch(address expectedRecipient, address actualRecipient);
    error DepositAddressMismatch(bytes32 expectedDepositAddressHash, bytes32 actualDepositAddressHash);
    error MintAmountOutOfRange(uint64 actualSats, uint64 minSats, uint64 maxSats);
    error InvalidMinimumConfirmations(uint32 minimumConfirmations);
    error InvalidMintLimit(uint64 limitSats, uint64 windowSeconds);
    error MintLimitExceeded(uint64 limitSats, uint64 usedSats, uint64 requestedSats);

    event MintLimitUpdated(uint64 limitSats, uint64 windowSeconds);

    event MintExecuted(
        bytes32 indexed depositId,
        bytes32 indexed utxoKey,
        address indexed recipient0x,
        uint64 sats,
        bytes32 btcTxId,
        uint32 vout
    );

    function mintWithAuthorization(
        BridgeTypes.DepositIntent calldata intent,
        BridgeTypes.MintAuthorization calldata authorization,
        bytes calldata attestation
    ) external returns (uint256 mintedAmount);

    function attestationVerifier() external view returns (address);

    function bridgeToken() external view returns (address);

    function depositRegistry() external view returns (address);
}
