# FromBitcoin

FromBitcoin is a BTC <-> EVM bridge design centered on one rule:

> Chainlink does not advise. Chainlink authorizes.

## Live Public Testnet

- Web app: [https://api.frombitcoin.link](https://api.frombitcoin.link)
- Public API: [https://api.frombitcoin.link/status](https://api.frombitcoin.link/status)
- Chainlink release preflight adapter: [https://adapter.frombitcoin.link/healthz](https://adapter.frombitcoin.link/healthz)
- GitHub repository: [https://github.com/faustogq/frombitcoin](https://github.com/faustogq/frombitcoin)

For product or Chainlink review, start with the web app. No local setup or command-line usage is required to inspect the public testnet flow.

The web app exposes the Signet BTC -> Sepolia bbBTC deposit flow, the Sepolia bbBTC -> Signet BTC redeem flow, public activity, testnet status, and a visible testnet-only warning.

## Trust Model

Every sensitive state transition must require a valid DON authorization:

- no mint on EVM without DON authorization,
- no BTC release without DON authorization,
- no replay of `depositId` or `redeemId`,
- no BTC signature unless the signer can verify an exact match between the candidate PSBT and the DON authorization.

<details>
<summary>Technical reference for developers and operators</summary>

The main architecture and product spec lives here:

- [docs/bridge-v1-spec.md](docs/bridge-v1-spec.md)
- [docs/signer-policy-v1.md](docs/signer-policy-v1.md)
- [docs/flows-v1.md](docs/flows-v1.md)
- [docs/testnet-operations-runbook.md](docs/testnet-operations-runbook.md)
- [docs/sepolia-signet-staging-runbook.md](docs/sepolia-signet-staging-runbook.md)
- [docs/public-testnet-runbook.md](docs/public-testnet-runbook.md)
- [docs/hetzner-public-testnet-runbook.md](docs/hetzner-public-testnet-runbook.md)
- [docs/public-testnet-launch-checklist.md](docs/public-testnet-launch-checklist.md)

Current status:

- v1 product and security spec drafted
- concrete Solidity contracts added under [contracts](contracts)
- authorization schemas added under [schemas](schemas)
- verifier now expects quorum attestations encoded as `abi.encode(bytes32 signerSetDigest, bytes[] signatures)`
- mint and redeem gateways include owner-configurable fixed-window volume limits
- managed contracts use two-step ownership transfer with pending-owner acceptance
- deployments can enter irreversible EVM lockdown after configuration by pinning the token minter, pinning the deposit consumer, and renouncing contract ownership
- redeem completion on EVM requires a valid DON `ReleaseAuthorization`
- the redeem offchain path is split into watcher, local/test DON attestation provider, and EVM relayer stages
- the public testnet API returns redacted user-safe views and fails closed unless runtime checks confirm Sepolia + signet
- public redeems accept only P2WPKH, P2WSH, or P2TR signet destination scripts and revalidate release PSBTs before Bitcoin signing/finalization
- public Sepolia + signet testnet is deployed on Hetzner behind Cloudflare Tunnel at `api.frombitcoin.link` and `adapter.frombitcoin.link`
- public launch readiness includes a visible testnet-only UI warning, a redaction healthcheck, and scheduled SQLite backups

## Commands

Install dependencies:

```bash
npm install
```

Compile artifacts into [build](build):

```bash
npm run build
```

Run the integration tests:

```bash
npm test
```

Audit production dependencies:

```bash
npm run audit:prod
```

Run the public testnet healthcheck:

```bash
npm run health:public-testnet -- \
  --base-url https://api.frombitcoin.link \
  --adapter-url https://adapter.frombitcoin.link \
  --expected-burn-gateway 0x6eFA4C217171B8B0eb856F48403928D9ad27ac96
```

Back up the public testnet SQLite database:

```bash
npm run backup:public-testnet -- \
  --db /var/lib/bitcoinbride/public-testnet.sqlite \
  --out-dir /var/backups/bitcoinbride
```

Run public testnet reconciliation:

```bash
npm run reconcile:public-testnet -- \
  --config /etc/bitcoinbride/public-testnet.json \
  --stale-seconds 3600 \
  --fail-on-warning
```

Validate DON authorization artifacts:

```bash
npm run validate:authorization -- --help
```

Scan finalized redeem events:

```bash
npm run watch:redeems -- --help
```

Create DON attestations for authorized redeems:

```bash
npm run attest:redeems -- --help
```

Ingest externally produced DON attestations:

```bash
npm run ingest:attestation -- --help
```

Verify a DON release authorization request before signing:

```bash
npm run verify:don-release -- --help
```

Fetch a canonical `RedeemRequested` event JSON from an EVM RPC source:

```bash
npm run fetch:redeem-event -- --help
```

Run the DON release preflight HTTP adapter:

```bash
npm run service:don-release-adapter -- --help
```

Relay attested redeems:

```bash
npm run relay:redeems -- --help
```

Build a Bitcoin Core wallet-funded PSBT:

```bash
npm run build:bitcoin-psbt -- --help
```

Run the single-command regtest BTC release harness:

```bash
npm run regtest:bitcoin-release -- --help
```

Sign an exact-match BTC PSBT after DON verification:

```bash
npm run sign:release-psbt -- --help
```

Broadcast a signed Bitcoin transaction:

```bash
npm run broadcast:bitcoin-tx -- --help
```

Run supervised redeem services:

```bash
npm run service:redeems -- --help
```

Show deployment CLI options:

```bash
npm run deploy -- --help
```

## Deploy Flow

The deployment script:

- loads existing artifacts from [build](build), or compiles first when `--compile` is passed,
- deploys `WrappedBitcoin`,
- deploys `AttestationVerifier`,
- deploys `DepositRegistry`,
- deploys `MintGateway`,
- deploys `BurnGateway` wired to `AttestationVerifier`,
- prints a JSON summary with addresses and required post-deploy actions.

After deployment, the owner still needs to authorize the mint path:

- `WrappedBitcoin.setMinter(MintGateway, true)`
- `DepositRegistry.setAuthorizedConsumer(MintGateway, true)`

Those calls can be left explicit, or run automatically with:

```bash
npm run build
npm run deploy -- \
  --rpc-url <rpc-url> \
  --private-key <deployer-key> \
  --expected-chain-id <evm-chain-id> \
  --deployment-environment <local|testnet|staging|mainnet> \
  --owner <owner-address> \
  --signers <comma-separated-don-signers> \
  --btc-network <btc-network-id> \
  --bridge-label <deployment-label> \
  --mint-limit-sats <sats-per-window> \
  --mint-limit-window-seconds <seconds> \
  --redeem-limit-sats <sats-per-window> \
  --redeem-limit-window-seconds <seconds> \
  --configure
```

Use `--dry-run` with the same arguments to validate the RPC chain id, deployment domain, signer set, owner, limits, and artifact availability without sending transactions.

If the deployer is not the owner, also pass:

```bash
--owner-private-key <owner-key>
```

Limits are disabled only when both the limit and window are `0`. Mainnet deployments require non-zero mint and redeem limits, the DON threshold must be a strict majority of the configured signer set, and the owner must be a deployed contract such as a multisig or timelock.

The deployment script derives `bridgeDomain` from a deployment-specific preimage containing the project namespace, deployment environment, EVM chain id, BTC network id, and bridge label. The dry run prints both `bridgeDomain` and `bridgeDomainPreimage`; copy those exact values into the service configuration.

It also refuses to deploy if the connected RPC chain id does not match `--expected-chain-id`. For `mainnet`, the owner must not be the deployer hot key.

## Chainlink-Only-Risk Lockdown

For a deployment where EVM integrity depends only on a dishonest Chainlink DON signer quorum, use the ECDSA verifier with signer addresses controlled by the Chainlink DON nodes and add:

```bash
--attestation-mode ecdsa \
--configure \
--btc-custody-controller chainlink-don \
--chainlink-only-risk
```

That mode requires at least three DON signer addresses, a strict majority threshold, and `--btc-custody-controller chainlink-don`. After post-deploy wiring, it locks `WrappedBitcoin` so only `MintGateway` can mint, locks `DepositRegistry` so only `MintGateway` can consume deposits, and renounces ownership on the token, verifier, registry, mint gateway, and burn gateway.

After that, the app owner cannot add minters, add registry consumers, pause flows, change limits, rotate signer sets, or manually change redeem state. Any mint or redeem completion still needs a valid DON authorization.

Do not use this claim for the Chainlink Functions request path as-is: Functions requests carry requester-supplied source and args. Use the lockdown mode with DON signer attestations, or move Functions execution to source and policy that are pinned by the DON rather than by the app relayer.

In this risk model, BTC treasury custody is controlled by the Chainlink DON. When `bitcoin.custodyController` is `chainlink-don`, the public worker does not build wallet-funded PSBTs, call `walletprocesspsbt`, or call `finalizepsbt`. It asks `bitcoin.donCustodyAdapterUrl` for the DON-controlled spend plan and finalized Bitcoin transaction, verifies that transaction against the exact spend plan, and only broadcasts after the EVM redeem is consumed.

The handoff contract for Chainlink is documented in [docs/don-custody-interface-v1.md](docs/don-custody-interface-v1.md).

Ownership transfers are two-step:

1. The current owner calls `transferOwnership(newOwner)`.
2. `newOwner` calls `acceptOwnership()`.

The current owner can cancel a pending transfer with `cancelOwnershipTransfer()`.

## Test Notes

The test harness uses:

- `solc` for compilation,
- `ganache` for an in-memory EVM,
- `ethers` for deployment and signing,
- Node's built-in test runner.

On Node 25, `ganache` falls back to a pure JS networking path because its optional native `uWS` binary is unavailable for this runtime. The tests still pass, but they run slower.

`npm run audit:prod` intentionally checks only production dependencies. Dev tooling still includes `ganache` and `solc`, which can report transitive advisories that do not ship with deployment-only installs.

## DON Artifact Validation

Offchain DON nodes, relayers, and signers should validate artifacts before signing, relaying, or consuming them:

- `npm run validate:authorization -- mint <mint-authorization.json>`
- `npm run validate:authorization -- release <release-authorization.json>`
- `npm run validate:authorization -- spend-plan <normalized-spend-plan.json> --change-policy-hash <bytes32>`
- `npm run validate:authorization -- bitcoin-psbt <bitcoin-psbt.json> --bitcoin-network <mainnet|testnet|testnet4|signet|regtest>`
- `npm run validate:authorization -- release-spend-plan <release-authorization.json> <normalized-spend-plan.json>`
- `npm run validate:authorization -- release-attestation <release-authorization.json> <release-attestation.json> --signers <comma-separated-don-signers> --threshold <don-threshold>`

The validator enforces the JSON schemas, strips non-contract metadata before hashing, and computes Solidity ABI-compatible struct hashes and spend commitments.

## EVM Redeem Watcher

The EVM redeem watcher is the first offchain bridge service:

- scans `BurnGateway.RedeemRequested` events,
- persists observed redeems in SQLite,
- waits for configurable EVM finality,
- verifies a normalized spend plan against the event and policy commitments,
- produces unsigned `ReleaseAuthorizationV1` candidates for DON attestation.

Example:

```bash
npm run watch:redeems -- \
  --rpc-url <rpc-url> \
  --burn-gateway <burn-gateway-address> \
  --db ./redeems.sqlite \
  --from-block <block> \
  --finality-blocks 12 \
  --spend-plan <normalized-spend-plan.json> \
  --change-policy-hash <bytes32>
```

The attestation step consumes authorized rows from the same SQLite DB, builds the DON attestation envelope, and records the signer set digest, message digest, and encoded attestation:

```bash
npm run attest:redeems -- \
  --db ./redeems.sqlite \
  --don-private-keys <comma-separated-don-keys> \
  --threshold <don-threshold>
```

`--don-private-keys` is only for local/test deployments. Production should replace this local provider with the actual Chainlink DON attestation path and keep raw DON key material out of the relayer process.

For production-style integration, ingest a `ReleaseAttestationV1` artifact produced outside the relayer:

```bash
npm run ingest:attestation -- \
  --db ./redeems.sqlite \
  --attestation <release-attestation.json> \
  --signers <comma-separated-don-signers> \
  --threshold <don-threshold>
```

The ingest step verifies the attestation schema, recomputes the release authorization digest from the stored authorization, checks signer set digest, verifies quorum signatures, and only then marks the redeem as `attested`.

The relay step consumes only attested rows, submits `completeRedeemWithAuthorization`, records the relay transaction, and checks `redeemId` consumption before retrying:

```bash
npm run relay:redeems -- \
  --rpc-url <rpc-url> \
  --burn-gateway <burn-gateway-address> \
  --db ./redeems.sqlite \
  --private-key <relayer-key>
```

The persisted redeem states are:

- `observed`: burn event seen but not final.
- `authorized`: finality and spend-plan checks passed; ready for DON attestation.
- `attestation_requested`: local/test attestation provider has started work; retryable.
- `attested`: encoded DON attestation is stored; ready for relay.
- `relayed`: transaction submitted; receipt will be reconciled before resubmission.
- `consumed`: onchain `redeemId` has been consumed.
- `failed`: terminal operator-marked failure state.

## Redeem Service Runner

For testnet/staging operations, use the service runner instead of manually invoking each one-shot CLI. The runner uses [config/redeem-service.example.json](config/redeem-service.example.json), persists the watcher cursor in SQLite, emits structured JSON logs, and exposes:

- `/healthz`: process state, last success/error, and persisted cursors.
- `/metrics`: Prometheus-style service and redeem status gauges.

Run one role once:

```bash
npm run service:redeems -- \
  --config ./config/redeem-service.example.json \
  --role watcher \
  --once
```

Run enabled roles continuously:

```bash
RELAYER_PRIVATE_KEY=<relayer-key> \
DON_PRIVATE_KEYS=<comma-separated-local-test-don-keys> \
npm run service:redeems -- --config ./config/redeem-service.example.json
```

Use `attester.enabled = false` in production when the real Chainlink DON produces `ReleaseAttestationV1` artifacts externally, then ingest those artifacts with `npm run ingest:attestation` and keep the relayer role isolated from DON key material.

Testnet deployment templates are included under [ops](ops):

- [ops/env/redeem-service.env.example](ops/env/redeem-service.env.example)
- [ops/systemd](ops/systemd)
- [ops/docker/compose.testnet.example.yml](ops/docker/compose.testnet.example.yml)

## BTC PSBT Signer

The local BTC signer path is policy-gated:

- parses `BitcoinPsbtV1`,
- derives `NormalizedSpendPlanV1` from the PSBT itself,
- verifies the `ReleaseAuthorizationV1` spend commitments,
- verifies the `ReleaseAttestationV1` DON quorum,
- checks local `bridgeDomain` and `btcNetwork` guards when provided,
- reserves `redeemId` in a durable SQLite replay store,
- signs/finalizes the PSBT only after all checks pass.

Example:

Run the whole local regtest BTC release path with synthetic DON attestations:

```bash
DON_PRIVATE_KEYS=<comma-separated-local-test-don-private-keys> \
npm run regtest:bitcoin-release -- \
  --rpc-url http://127.0.0.1:18443 \
  --rpc-user <rpc-user> \
  --rpc-password <rpc-password> \
  --threshold <don-threshold> \
  --broadcast \
  --mine-confirmation
```

That harness funds a local signer UTXO, builds the candidate PSBT, creates a test `ReleaseAuthorizationV1` plus `ReleaseAttestationV1`, verifies the same exact-match policy as the signer, signs, and optionally broadcasts/mines a confirmation.

Verify the release artifact the way a Chainlink DON node should before it signs:

First fetch the same burn event from two independent EVM RPC sources:

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
  --redeem-event <redeem-event.json> \
  --secondary-redeem-event <redeem-event-secondary.json> \
  --spend-plan <normalized-spend-plan.json> \
  --expected-bridge-domain <bytes32> \
  --expected-btc-network <btc-network-id> \
  --expected-source-evm-chain-id <chain-id> \
  --signers <comma-separated-don-signers> \
  --threshold <don-threshold> \
  --require-secondary-redeem-event \
  --max-authorization-ttl-seconds 1200
```

The verifier recomputes the redeem event hash, `redeemId`, spend-plan commitments, signer-set digest, and message digest. When `--require-secondary-redeem-event` is set, it also requires an independent event observation to match the primary source exactly. A DON node should only sign the reported `messageDigest` after this preflight passes.

Expose the same check as a small HTTP adapter for Chainlink/node-side integration:

```bash
npm run service:don-release-adapter -- \
  --config config/don-release-adapter.example.json
```

The adapter accepts `POST /release/preflight` with either the direct JSON payload or `{ "id": "...", "data": { ... } }`. The node-local config supplies bridge domain, BTC network, source chain, signer set, threshold, TTL, secondary-source policy, and deadline policy; the request supplies only artifacts such as `authorization`, `redeemEvent`, `secondaryRedeemEvent`, `spendPlan` or `psbt`.

Build a candidate PSBT from Bitcoin Core regtest/testnet:

```bash
npm run build:bitcoin-psbt -- \
  --rpc-url http://127.0.0.1:18443 \
  --rpc-user <rpc-user> \
  --rpc-password <rpc-password> \
  --wallet treasury \
  --btc-network <btc-network-id> \
  --bitcoin-network regtest \
  --destination-address <btc-address> \
  --amount-sats <sats>
```

The builder prints both `BitcoinPsbtV1` and the derived `NormalizedSpendPlanV1`. Use that spend plan for DON authorization.

Sign after DON authorization and attestation:

```bash
BTC_SIGNER_WIF=<regtest-or-testnet-wif> \
npm run sign:release-psbt -- \
  --db ./btc-signer.sqlite \
  --authorization <release-authorization.json> \
  --attestation <release-attestation.json> \
  --psbt <bitcoin-psbt.json> \
  --bitcoin-network regtest \
  --signers <comma-separated-don-signers> \
  --threshold <don-threshold> \
  --expected-bridge-domain <bytes32> \
  --expected-btc-network <btc-network-id> \
  --wif-env BTC_SIGNER_WIF
```

Broadcast the finalized tx hex:

```bash
npm run broadcast:bitcoin-tx -- \
  --rpc-url http://127.0.0.1:18443 \
  --rpc-user <rpc-user> \
  --rpc-password <rpc-password> \
  --tx-hex <signed-transaction-hex>
```

This is suitable for regtest/testnet validation. Mainnet signing for the Chainlink-only-risk model must be performed by the DON-controlled BTC custody path, with no local wallet signer or raw-sign endpoint.

</details>
