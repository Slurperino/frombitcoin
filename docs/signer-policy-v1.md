# Signer Policy v1

Status: draft
Date: 2026-04-20

## Goal

The BTC signer must sign a PSBT if and only if it can verify an exact match between:

- the candidate spend plan,
- the active DON release authorization,
- and local signer configuration for the current bridge domain.

No raw-sign capability is allowed. In the Chainlink-only-risk deployment model, the BTC treasury signer is controlled by the Chainlink DON, not by the app operator.

## Inputs

The signer consumes:

1. `ReleaseAuthorizationV1`
2. a DON attestation over that authorization
3. a candidate PSBT
4. local bridge configuration

Local bridge configuration must include:

- expected `bridgeDomain`
- expected `btcNetwork`
- allowed signer set / verifier configuration
- replay database location
- change policy configuration
- fee policy configuration

## Attestation Envelope

The current onchain verifier expects the DON attestation to be encoded as:

```text
abi.encode(
  signerSetDigest: bytes32,
  signatures: bytes[]
)
```

Where:

- `signerSetDigest = keccak256(abi.encode(sortedSignerAddresses, threshold))`
- every signature is a standard 65-byte ECDSA signature
- the signed message is `toEthSignedMessageHash(authorizationDigest)`

The verifier currently assumes:

- signer addresses are configured onchain,
- signer order in configuration is strictly increasing,
- and attestation validity is based on a quorum threshold over that configured signer set.

## Canonical Hashing Rules

All bridge hashes and identifiers use `keccak256`.

Offchain services must use Solidity ABI-compatible encoding for the hashed fields below. If a non-EVM service computes them with a different serializer, the signer must reject the artifact.

The contracts currently compute struct hashes with `keccak256(abi.encode(structValue))` or `keccak256(abi.encode(domain, structValue))`, which is ABI-equivalent to hashing the tuple fields in order.

### Deposit Hashes

```text
depositId = keccak256(abi.encode(
  bridgeDomain,
  recipient0x,
  depositAddressHash,
  amountMode,
  expectedSats,
  minSats,
  maxSats,
  nonce,
  expiry
))

utxoKey = keccak256(abi.encode(btcTxId, vout))
```

### Redeem Hashes

```text
destinationScriptHash = keccak256(destinationScriptPubKey)

redeemRequestHash = keccak256(abi.encode(
  bridgeDomain,
  requester,
  destinationScriptHash,
  amountSats,
  maxMinerFeeSats,
  deadline,
  requestNonce
))

redeemId = keccak256(abi.encode(
  bridgeDomain,
  burnTxHash,
  burnLogIndex,
  redeemRequestHash
))
```

### Spend Commitments

Input leaves:

```text
inputLeaf = keccak256(abi.encode(
  btcTxId,
  vout,
  valueSats,
  scriptTemplateId
))
```

Output leaves:

```text
outputLeaf = keccak256(abi.encode(
  scriptPubKey,
  valueSats
))
```

Aggregate commitments:

```text
inputsCommitment  = keccak256(abi.encode(inputLeaf[]))
outputsCommitment = keccak256(abi.encode(outputLeaf[]))
psbtPolicyHash    = keccak256(abi.encode(
  feeSats,
  nVersion,
  nLockTime,
  sighashType,
  changePolicyHash
))

authorizationDigest = keccak256(abi.encode(
  keccak256("BitcoinBride.Authorization.V1"),
  bridgeDomain,
  structHash,
  signerSetDigest
))
```

## Canonical Data Rules

The signer must enforce these canonical encodings:

- `btcTxId`: 32-byte displayed txid order encoded as `bytes32`
- `destinationScriptPubKey`: raw script bytes exactly as serialized in the candidate output
- `depositAddressHash`: hash of the canonical deposit address representation chosen by the bridge
- `destinationScriptHash`: hash of the raw destination script bytes
- `valueSats`, `feeSats`, `deadline`: unsigned integers with no unit conversion

The signer must not normalize by trying to be helpful. If the encoding differs from policy, reject it.

## Verification Procedure

The signer signs only if all checks pass:

1. Verify the DON attestation over `ReleaseAuthorizationV1`.
2. Verify `bridgeDomain` equals local signer configuration.
3. Verify `btcNetwork` equals local signer configuration.
4. Verify current time is `<= deadline`.
5. Verify `redeemId` has not already been consumed.
6. Parse the candidate PSBT into a normalized spend plan.
7. Verify the destination output script hashes to `destinationScriptHash`.
8. Verify the destination amount equals `amountSats`.
9. Verify the computed `inputsCommitment` matches the authorization.
10. Verify the computed `outputsCommitment` matches the authorization.
11. Verify the computed `psbtPolicyHash` matches the authorization.
12. Verify `feeSats <= maxMinerFeeSats`.
13. Verify every change output conforms to the approved change policy.
14. Reserve `redeemId` atomically before returning a signature.

If any check fails, do not sign.

The repository includes a validation CLI for these pre-signing checks:

```bash
npm run validate:authorization -- release-spend-plan <release-authorization.json> <normalized-spend-plan.json>
```

This validates the JSON schemas, computes ABI-compatible commitments, and rejects drift between the `ReleaseAuthorizationV1` and normalized spend plan.

DON nodes should also run the release preflight before producing a release attestation:

```bash
npm run fetch:redeem-event -- \
  --rpc-url <primary-evm-rpc> \
  --burn-gateway <burn-gateway-address> \
  --tx-hash <burn-tx-hash> \
  --log-index <redeem-requested-log-index> \
  > redeem-event.primary.json

npm run fetch:redeem-event -- \
  --rpc-url <secondary-evm-rpc> \
  --burn-gateway <burn-gateway-address> \
  --tx-hash <burn-tx-hash> \
  --log-index <redeem-requested-log-index> \
  > redeem-event.secondary.json
```

```bash
npm run verify:don-release -- \
  --authorization <release-authorization.json> \
  --redeem-event redeem-event.primary.json \
  --secondary-redeem-event redeem-event.secondary.json \
  --spend-plan <normalized-spend-plan.json> \
  --expected-bridge-domain <bytes32> \
  --expected-btc-network <btc-network-id> \
  --expected-source-evm-chain-id <chain-id> \
  --signers <comma-separated-don-signers> \
  --threshold <don-threshold> \
  --require-secondary-redeem-event
```

That preflight recomputes the event-bound `redeemRequestHash`, `redeemId`, spend commitments, signer-set digest, and DON `messageDigest`. When secondary observation is required, the independent event source must agree exactly on event identity and redeem fields. The node should sign only after this check passes under its own local configuration and observation paths.

The same preflight can be exposed to node workflows as an HTTP adapter:

```bash
npm run service:don-release-adapter -- --config <don-release-adapter.json>
```

The adapter reads local policy from config and accepts only artifacts in request payloads.

The repository also includes a local regtest/testnet PSBT signer gate:

```bash
npm run sign:release-psbt -- \
  --db <btc-signer.sqlite> \
  --authorization <release-authorization.json> \
  --attestation <release-attestation.json> \
  --psbt <bitcoin-psbt.json> \
  --bitcoin-network <mainnet|testnet|testnet4|signet|regtest> \
  --signers <comma-separated-don-signers> \
  --threshold <don-threshold> \
  --wif-env BTC_SIGNER_WIF
```

That CLI derives the normalized spend plan from the PSBT, verifies the DON attestation and authorization commitments, reserves `redeemId` in SQLite, and only then signs/finalizes the PSBT. It is a local/test adapter only. In `chainlink-don` custody mode the public worker does not call this signer or any Bitcoin Core wallet signing path; it accepts only a DON custody adapter response containing the normalized spend plan and finalized Bitcoin transaction. Mainnet signing for the Chainlink-only-risk model must be done by the DON-controlled BTC custody path.

## Replay Rules

The replay store must track at least:

- consumed `redeemId`
- consumed authorization digest
- signed PSBT txid or unsigned transaction digest
- reservation timestamp
- final disposition (`signed`, `broadcast`, `confirmed`, `aborted`)

The replay store must be durable across process restarts.

## Broadcast Rules

If a signed transaction fails to broadcast:

- do not sign a materially different PSBT under the same authorization
- only retry broadcast of the same transaction
- if a rebuild is required, request a fresh DON authorization

This prevents fee or change drift under stale approvals.

## Reorg Rules

If the burn event loses finality before signing:

- invalidate the authorization
- clear any unsigned reservation
- require a fresh authorization after finality is restored

If the signed BTC transaction conflicts with treasury state:

- stop automated retries
- move the redeem to manual review

## Operational Requirements

- No interactive approvals inside the signer path.
- No hidden fallback to a hot wallet.
- No signer endpoint that accepts arbitrary PSBTs without policy verification.
- Key rotation must not reset replay protection state.
- Metrics must expose rejection reasons by category.

## Minimum Logs

Each decision should log:

- `redeemId`
- attestation digest
- computed `inputsCommitment`
- computed `outputsCommitment`
- computed `psbtPolicyHash`
- fee in sats
- result (`accepted` or `rejected`)
- rejection reason
