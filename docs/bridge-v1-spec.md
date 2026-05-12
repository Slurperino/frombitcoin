# BitcoinBride Bridge v1

Status: draft
Date: 2026-04-20

## Objective

Define a BTC <-> EVM bridge where Chainlink acts as the authorization layer for every sensitive state transition:

- No mint on EVM without a valid DON attestation.
- No BTC release without a valid DON attestation.
- No replay of deposit or redeem identities.
- No BTC signature if the signer cannot verify an exact match between the signed PSBT and the DON authorization.

This document treats Chainlink as an authorization boundary, not as advisory metadata.

## Product Thesis

The clean product framing is:

> Chainlink does not advise. Chainlink authorizes.
> Every sensitive state transition must require that authorization.

That framing is correct for product and security, with one caveat:

- This is still an externally verified bridge with BTC custody and operational trust assumptions.
- It should not be marketed as fully trustless or natively verified on Bitcoin.

## Recommended Chainlink Positioning

For a product-grade implementation, the Chainlink-facing component should be described as a workflow or DON that:

- observes Bitcoin deposits and EVM burns,
- reaches consensus on the relevant facts,
- produces an authorization artifact,
- and gates the next state transition.

Implementation detail:

- Prefer a Chainlink CRE workflow / DON as the main mental model.
- Chainlink Functions and external adapters may still exist as implementation details, but they should not be the center of the architecture narrative.

## System Boundaries

### On EVM

- `BridgeToken`: wrapped BTC representation on the EVM chain.
- `DepositRegistry`: records deposit intents and prevents replay.
- `MintGateway`: verifies DON authorization and mints tokens.
- `BurnGateway`: burns tokens, creates redeem requests, and emits canonical events.
- `AttestationVerifier`: validates DON report / signatures and domain separation.
- `RiskControls`: pause, limits, emergency controls, manual review hooks if needed.

### Offchain

- `BTC Watcher DON`: observes Bitcoin deposits and confirmations.
- `EVM Watcher DON`: observes burn events and EVM finality.
- `Authorization Relayer`: submits valid DON authorizations to EVM or signer services.
- `BTC Treasury`: controlled UTXO set holding backing BTC.
- `PSBT Builder`: constructs candidate BTC transactions from approved redeem requests.
- `BTC Signer`: MPC / HSM / quorum signer that signs only if authorization matches exactly.
- `Broadcaster`: sends signed BTC transactions to the Bitcoin network.
- `Ops + Monitoring`: health checks, solvency, rate limits, alerting, manual interventions.

## Trust Model

This bridge falls into the "external verification" category:

- Bitcoin is not being verified natively by the EVM contract.
- The EVM side trusts a DON authorization layer to attest that a BTC-side fact is true.
- The BTC release path additionally trusts the BTC signer policy and custody stack.

Therefore:

- security depends on DON integrity,
- security depends on signer isolation and policy enforcement,
- security depends on treasury solvency and operational discipline.

### Chainlink-Only-Risk Target

The target "only dishonest Chainlink nodes can break integrity" is valid only under all of these conditions:

- the onchain verifier accepts authorization only from a fixed Chainlink DON signer quorum,
- the verifier signer set is not owner-rotatable after launch,
- token minter and deposit consumer permissions are pinned to the mint gateway,
- contract ownership cannot change authorization, minting, consuming, pause, limit, or redeem-state policy,
- the BTC treasury signer is controlled by the same Chainlink DON quorum and cannot sign outside the exact DON-authorized spend policy,
- app infrastructure cannot locally fund PSBTs, locally sign, locally finalize, or substitute a Bitcoin transaction in the `chainlink-don` custody mode.

In the current contracts this is the purpose of `--chainlink-only-risk`: it locks EVM minter/consumer permissions and renounces ownership after configuration. That mode also requires `--btc-custody-controller chainlink-don`. The public worker now fails closed unless the DON custody adapter provides a spend plan and a finalized Bitcoin transaction that matches it, but the production DON custody service itself still has to be supplied by the Chainlink/DON-controlled signing path before the full bridge can honestly claim this risk model.

## Non-Negotiable Invariants

1. No mint without DON attestation.
2. No BTC release without DON attestation.
3. No replay of `depositId`.
4. No replay of `redeemId`.
5. No replay of a consumed BTC UTXO.
6. No signer action unless the signer can verify that the authorization binds exactly to the transaction it is about to sign.
7. No cross-environment replay between testnet/mainnet or between different EVM chains.
8. No acceptance of stale authorizations after deadline / expiry.
9. No mint or release after a global pause or asset-specific circuit breaker.

## Canonical Domains

Every identity and every authorization must be bound to:

- `bridgeVersion`
- `bridgeDeploymentId`
- `evmChainId`
- `btcNetwork`
- `tokenAddress` or asset identifier
- `environment` (`mainnet`, `testnet`, `staging`, etc.)

Recommended domain separator:

```text
bridgeDomain = keccak256(
  "BitcoinBride",
  bridgeVersion,
  bridgeDeploymentId,
  evmChainId,
  btcNetwork,
  tokenAddress,
  environment
)
```

Nothing should be authorized outside this domain.

## BTC -> EVM

### Recommended UX Model

Use one unique Bitcoin deposit address per deposit intent.

Do not reuse BTC deposit addresses across users or across intents.

Reason:

- address reuse weakens reconciliation,
- makes replay analysis harder,
- complicates refunds and support,
- creates ambiguity around partial and excess deposits.

### Deposit Intent

The user creates a deposit intent:

```text
DepositIntent {
  recipient0x: address
  depositAddress: string
  amountMode: enum { EXACT, ANY }
  expectedSats: uint64
  minSats: uint64
  maxSats: uint64
  nonce: bytes32
  expiry: uint64
}
```

For product UX the deposit address may be displayed as a Bitcoin string, but onchain contracts should store and compare only its canonical hash representation.

Recommended identity:

```text
depositId = keccak256(
  bridgeDomain,
  recipient0x,
  depositAddress,
  amountMode,
  expectedSats,
  minSats,
  maxSats,
  nonce,
  expiry
)
```

### Amount Policy

Do not keep `amount/any` ambiguous.

Choose one of these two product policies:

1. `EXACT`
   - User must send exactly `expectedSats`.
   - Cleanest contract logic.
   - More support burden when users mis-send.

2. `ANY`
   - User sends any amount to a unique address.
   - Mint exactly the observed confirmed amount after policy-defined adjustments.
   - Better UX, more edge cases, must define partial/excess treatment clearly.

For v1, the cleaner product choice is:

- unique deposit address,
- `ANY` mode allowed,
- mint exactly the confirmed sats observed for the qualifying UTXO set,
- but only once per `depositId`.

### What the DON Must Attest

The DON authorization for minting must bind to concrete Bitcoin settlement facts:

```text
MintAuthorization {
  bridgeDomain: bytes32
  depositId: bytes32
  recipient0x: address
  btcNetwork: uint32
  depositAddress: string
  btcTxid: bytes32
  vout: uint32
  sats: uint64
  confirmations: uint32
  observedBlockHeight: uint64
  attestationTimestamp: uint64
  deadline: uint64
}
```

Important:

- `btcTxid` and `vout` are mandatory.
- A deposit must be tied to a specific UTXO or an explicitly normalized set of UTXOs.
- The contract should also track `consumedUtxoKey = keccak256(btcTxid, vout)` to prevent duplicate minting.

### Mint Flow

1. User obtains or creates a `DepositIntent`.
2. User sends BTC to the unique `depositAddress`.
3. The BTC Watcher DON observes the deposit through redundant Bitcoin data sources.
4. The DON waits until the configured confirmation threshold is met.
5. The DON produces `MintAuthorization`.
6. A relayer calls `mintWithAuthorization(...)`.
7. The EVM contract verifies:
   - correct DON report / signatures,
   - correct `bridgeDomain`,
   - `depositId` exists and is unused,
   - `expiry` has not passed,
   - authorization `deadline` has not passed,
   - `recipient0x` matches the intent,
   - `depositAddress` matches the intent,
   - amount policy is satisfied,
   - `consumedUtxoKey` is unused.
8. Contract mints wrapped BTC and marks the intent and UTXO as consumed.

### Mint Pseudocode

```solidity
function mintWithAuthorization(
  DepositIntent calldata intent,
  MintAuthorization calldata auth,
  bytes calldata donProof
) external {
  verifyDonAuthorization(auth, donProof);
  require(auth.bridgeDomain == bridgeDomain, "BAD_DOMAIN");
  require(block.timestamp <= intent.expiry, "INTENT_EXPIRED");
  require(block.timestamp <= auth.deadline, "AUTH_EXPIRED");
  require(computeDepositId(intent) == auth.depositId, "BAD_DEPOSIT_ID");
  require(!usedDepositId[auth.depositId], "DEPOSIT_REPLAY");
  require(!usedUtxo[keccak256(auth.btcTxid, auth.vout)], "UTXO_REPLAY");
  require(intent.recipient0x == auth.recipient0x, "BAD_RECIPIENT");
  require(compareBtcAddress(intent.depositAddress, auth.depositAddress), "BAD_ADDRESS");
  require(amountPolicySatisfied(intent, auth.sats), "BAD_AMOUNT");

  usedDepositId[auth.depositId] = true;
  usedUtxo[keccak256(auth.btcTxid, auth.vout)] = true;
  bridgeToken.mint(auth.recipient0x, auth.sats);
}
```

## EVM -> BTC

### Redeem Request

The user burns wrapped BTC and specifies a Bitcoin destination and execution constraints.

```text
RedeemRequest {
  requester: address
  btcDestination: string
  amountSats: uint64
  maxMinerFeeSats: uint64
  deadline: uint64
  requestNonce: uint64
}
```

For contract-level verification, the raw BTC destination should be converted offchain into a canonical `scriptPubKey`, and onchain logic should bind to `destinationScriptHash = keccak256(scriptPubKey)` rather than a free-form string.

Because a contract cannot know its own `txHash` or `logIndex` during execution, split the redeem identity into two layers:

1. An onchain `redeemRequestHash`, created by the burn contract.
2. An offchain `redeemId`, created by the DON after it observes the finalized burn event.

Recommended onchain request identity:

```text
redeemRequestHash = keccak256(
  bridgeDomain,
  requester,
  btcDestination,
  amountSats,
  maxMinerFeeSats,
  deadline,
  requestNonce
)
```

Recommended offchain canonical redeem identity:

```text
redeemId = keccak256(
  bridgeDomain,
  burnTxHash,
  burnLogIndex,
  redeemRequestHash
)
```

The burn contract emits `redeemRequestHash`, and the DON derives `redeemId` only after observing the canonical burn event. Binding to `burnTxHash + burnLogIndex` still gives clean replay analysis and indexing, without requiring the contract to know the future transaction hash.

### Burn Flow

1. User calls `burn(amountSats, btcDestination, maxMinerFeeSats, deadline)`.
2. Contract burns wrapped BTC.
3. Contract emits `RedeemRequested(redeemRequestHash, ...)`.
4. The EVM Watcher DON observes the event and waits for EVM finality.
5. The DON derives `redeemId` from the finalized burn event identity and authorizes a BTC release.
6. The PSBT builder prepares a candidate BTC transaction.
7. The BTC signer validates that the candidate PSBT matches the authorization exactly.
8. Only then does the signer sign.
9. The broadcaster submits the signed BTC transaction.
10. The BTC watcher confirms broadcast and then Bitcoin confirmation state.

## Why "amount + destination" Is Not Enough

The signer must not accept a DON authorization that only says:

- `redeemId`
- `amount`
- `btcDestination`

That is too weak.

The authorization must also constrain:

- Bitcoin network
- burn origin and EVM chain
- max fee policy
- change policy
- authorization deadline
- optionally the selected input set or a canonical spend commitment

Without that, the signer can still leak value through fee abuse, wrong change outputs, or malformed PSBT construction.

## Release Authorization

The recommended pattern is to authorize a normalized spend commitment, not just business fields.

```text
ReleaseAuthorization {
  bridgeDomain: bytes32
  redeemRequestHash: bytes32
  redeemId: bytes32
  btcNetwork: uint32
  sourceEvmChainId: uint64
  burnTxHash: bytes32
  burnLogIndex: uint32
  requester: address
  btcDestination: string
  amountSats: uint64
  maxMinerFeeSats: uint64
  changePolicyHash: bytes32
  inputsCommitment: bytes32
  outputsCommitment: bytes32
  psbtPolicyHash: bytes32
  attestationTimestamp: uint64
  deadline: uint64
}
```

Where:

- `inputsCommitment` commits to the chosen UTXOs or an approved input-selection envelope.
- `outputsCommitment` commits to exact outputs.
- `changePolicyHash` commits to where change may go.
- `psbtPolicyHash` commits to normalized transaction rules such as `nVersion`, `nLockTime`, `sighash`, dust rules, and fee rules.

### Minimal Signer Rule

The signer signs a PSBT if and only if:

1. DON authorization is valid.
2. `bridgeDomain` matches local signer configuration.
3. `redeemId` is unused.
4. Authorization `deadline` has not passed.
5. The normalized candidate PSBT hashes to the same commitments contained in the authorization.
6. The resulting fee is `<= maxMinerFeeSats`.
7. Change outputs satisfy the approved change policy.

If any field differs, the signer must refuse.

## PSBT Normalization

Before comparing against the DON authorization, the signer should normalize the candidate PSBT into a deterministic policy view:

```text
NormalizedSpendPlan {
  btcNetwork
  inputs[] = [{txid, vout, value, scriptTemplateId}]
  outputs[] = [{scriptPubKey, value}]
  feeSats
  nVersion
  nLockTime
  sighashType
}
```

Then compute:

```text
inputsCommitment  = hash(normalized inputs)
outputsCommitment = hash(normalized outputs)
psbtPolicyHash    = hash(feeSats, nVersion, nLockTime, sighashType, change policy)
```

This is the object the signer should verify against the DON authorization.

## Redeem State Machine

Recommended states:

- `Burned`
- `Authorized`
- `Signing`
- `Broadcast`
- `Confirmed`
- `Failed`
- `ManualReview`

Recommended onchain minimum:

- `Burned`
- `Consumed` only after a valid DON `ReleaseAuthorization`
- `Cancelled` or `ManuallyResolved` if governance chooses to support exception handling

Avoid putting the full BTC execution workflow onchain if it creates fragile coupling.

Current offchain redeem service states:

- `observed`: burn event persisted but not finalized.
- `authorized`: finality and spend-plan checks passed; ready for Chainlink DON attestation.
- `attestation_requested`: attestation provider has started work; retryable.
- `attested`: DON attestation is persisted; ready for EVM relay and signer checks.
- `relayed`: EVM transaction submitted; receipt must be reconciled before resubmission.
- `consumed`: onchain `redeemId` is consumed.
- `failed`: terminal operator-marked failure state.

## Finality Policy

The bridge must define explicit finality policy on both sides.

### Bitcoin Side

Confirmations should be policy-driven, potentially tiered by amount:

- smaller amounts: lower threshold
- larger amounts: higher threshold

### EVM Side

Burns should not be authorized until the configured EVM finality threshold is reached.

This policy must live in configuration, not in ad hoc operator judgment.

## Data Source Policy

Do not let every DON node depend on the same Bitcoin explorer API.

Minimum recommendation:

- multiple independent Bitcoin data sources,
- ideally at least one self-operated full node path,
- explicit handling for source disagreement,
- alerting when source divergence exceeds policy thresholds.

Decentralized execution on top of one centralized data source is not enough.

## Operational Controls

v1 should include:

- global pause
- per-asset pause
- mint rate limits
- redeem rate limits
- treasury solvency checks
- signer key rotation process
- DON authorization key rotation process
- dead-letter queue / manual review path
- replay protection persistence across restarts and redeployments

Current Solidity status:

- direction-specific mint and burn pause controls exist,
- fixed-window mint and redeem volume limits exist,
- managed contracts use two-step ownership transfer,
- mainnet deployment requires a deployed contract owner,
- onchain redeem consumption requires a DON `ReleaseAuthorization`,
- treasury solvency checks, dead-letter queues, manual review records, and durable offchain replay stores remain offchain production deliverables.

## Treasury Model

The bridge must be explicit about custody:

- BTC backing lives in a managed treasury UTXO set.
- Wrapped supply on EVM must never exceed available BTC backing minus pending liabilities and fees.

Recommended accounting buckets:

- available BTC
- reserved for pending redeems
- operational fee buffer
- pending deposits not yet minted
- wrapped supply outstanding

If solvency cannot be measured continuously, the product is not ready.

## Threat Model

### 1. Replay of Deposit Authorization

Risk:

- same `depositId` or same BTC UTXO is used twice.

Controls:

- store `usedDepositId`,
- store `usedUtxo`,
- domain-separate authorizations.

### 2. Replay of Redeem Authorization

Risk:

- same `redeemId` is re-signed or re-broadcast.

Controls:

- signer-side `usedRedeemId`,
- treasury reservation tracking,
- deadline checks.

### 3. Bitcoin Reorg

Risk:

- DON authorizes a mint before sufficient Bitcoin finality.

Controls:

- explicit confirmation policy,
- tiered confirmation policy by amount,
- reorg monitoring,
- emergency pause.

### 4. EVM Reorg

Risk:

- DON authorizes a BTC release from a burn event that later disappears.

Controls:

- explicit EVM finality threshold,
- bind authorization to canonical burn event identity.

### 5. Single Source Data Failure

Risk:

- all DON nodes consume the same manipulated API output.

Controls:

- heterogeneous Bitcoin data sources,
- self-operated nodes where possible,
- disagreement policy and alerting.

### 6. Signer Bypass

Risk:

- signer can sign arbitrary PSBTs outside DON policy.

Controls:

- HSM / MPC policy engine,
- no raw-sign endpoint,
- only sign normalized spend plans that match an active authorization.

### 7. Fee Theft or Change Theft

Risk:

- builder sends correct destination amount but steals through fee inflation or wrong change.

Controls:

- commit to outputs, fee ceiling, and change policy,
- signer verifies exact match.

### 8. Treasury Insolvency

Risk:

- wrapped supply exceeds available backing.

Controls:

- solvency accounting,
- mint / redeem caps,
- proof-of-reserves or internal reserve attestations if product requires transparency.

### 9. Relayer Censorship

Risk:

- authorization exists but is not delivered.

Controls:

- multiple relayers,
- retry logic,
- manual execution path.

### 10. Environment Replay

Risk:

- testnet or staging authorization is replayed on mainnet.

Controls:

- `bridgeDomain`,
- network-specific keys and configuration,
- strict signer allowlists.

## Product Rules That Should Be Written Down Early

v1 needs explicit decisions on:

1. Exact amount vs any amount deposits.
2. Deposit expiry behavior.
3. Treatment of late BTC deposits after expiry.
4. Treatment of partial deposits.
5. Treatment of excess deposits.
6. Who pays BTC miner fees on redeem.
7. Maximum redeem size per transaction.
8. Whether batched redeems are allowed in v1.
9. Whether there is a public solvency signal.
10. What manual recovery path exists when the automated flow fails.

## Recommended v1 Scope

To keep v1 shippable:

- one BTC network,
- one EVM chain,
- one wrapped BTC token,
- unique deposit address per intent,
- one UTXO or normalized UTXO set per mint authorization,
- no batched redeems in the first release,
- signer verifies exact spend-plan commitment,
- strong pause and limit controls.

Avoid for v1:

- multi-chain EVM support from day one,
- address reuse,
- free-form PSBT signing,
- opaque treasury accounting,
- cross-environment shared keys.

## Open Design Decisions

### A. Authorization Format

Need to choose between:

- native Chainlink report verification onchain,
- app-specific verifier contract,
- or a dedicated authorization relay contract with DON-managed keys.

The core requirement remains the same: the consumer must verify a valid DON-origin authorization artifact.

### B. Deposit Qualification Unit

Need to choose whether a deposit is defined by:

- one qualifying UTXO,
- or a normalized set of UTXOs aggregated into one mint.

For v1, one qualifying UTXO is cleaner.

### C. Custody Architecture

Need to choose whether BTC custody is:

- single institution with HSM policy,
- MPC quorum,
- or another multi-party setup.

The bridge architecture should assume the signer is constrained, not trusted blindly.

### D. Transparency Level

Need to decide whether users can independently inspect:

- outstanding wrapped supply,
- backing BTC addresses,
- pending redeem liabilities,
- operational pause state.

## Suggested Next Deliverables

The next implementation step should be:

1. Solidity interface draft for:
   - `DepositRegistry`
   - `MintGateway`
   - `BurnGateway`
   - `IAttestationVerifier`
2. JSON schema or ABI schema for:
   - `MintAuthorization`
   - `ReleaseAuthorization`
   - `ReleaseAttestation`
3. Signer policy spec:
   - normalized PSBT rules
   - exact-match verification
   - replay protection
4. End-to-end state diagrams and failure runbooks.

## References

- Chainlink Functions overview: https://docs.chain.link/chainlink-functions
- Chainlink Runtime Environment overview: https://docs.chain.link/cre
- Chainlink Offchain Reporting overview: https://docs.chain.link/architecture-overview/off-chain-reporting?parent=chainlinkFunctions
- Chainlink bridge risk taxonomy: https://docs.chain.link/resources/bridge-risks?parent=chainlinkFunctions
- Chainlink CCIP best practices: https://docs.chain.link/ccip/concepts/best-practices/evm
- Chainlink core repository note on external adapters: https://github.com/smartcontractkit/chainlink
