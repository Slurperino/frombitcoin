# Production Launch Plan

Status: working plan
Date: 2026-04-27

This project is not ready for mainnet funds until every `Required before mainnet` item below is complete.

## Current Baseline

- Solidity contracts compile with the local `solc` pipeline.
- Integration tests cover mint authorization, deposit replay protection, burn requests, attestation quorum, signer rotation, owner-only controls, pause gates, and fixed-window mint/redeem limits.
- Deployment now requires explicit EVM chain id, deployment environment, BTC network id, and bridge label before deriving `bridgeDomain`.
- Mint and redeem gateways include owner-configurable fixed-window limits. A limit is disabled only when both amount and window are zero.
- Redeem completion on EVM requires a DON `ReleaseAuthorization`; owner-controlled state changes cannot mark a redeem consumed.
- Authorization artifact validation is available for DON nodes, relayers, and signers through schema checks and ABI-compatible commitment hashing.
- A first EVM redeem watcher can scan `RedeemRequested`, persist events in SQLite, wait for finality, and build unsigned `ReleaseAuthorizationV1` candidates.
- A local/test attestation provider can consume authorized rows, validate and sign `ReleaseAuthorizationV1`, and persist the DON-style attestation envelope.
- Externally produced `ReleaseAttestationV1` artifacts can be schema-checked, quorum-verified, and ingested without exposing DON keys to the relayer.
- The redeem relayer consumes only attested rows, submits `completeRedeemWithAuthorization`, reconciles submitted receipts, and checks onchain `redeemId` consumption before retrying.
- A redeem service runner can operate watcher, local/test attester, and relayer roles from versioned JSON config with persisted cursors, JSON logs, `/healthz`, and `/metrics`.
- A DON-node release preflight verifies the observed burn event, optional independent secondary event observation, recomputed `redeemRequestHash`, derived `redeemId`, spend-plan/PSBT commitments, local bridge guards, authorization window, signer-set digest, and message digest before any release signature is produced.
- A DON release preflight HTTP adapter exposes that same check with node-local policy configuration, secondary-source enforcement, and Chainlink-style request/response envelopes.
- The Sepolia + signet Chainlink Functions stack has completed a live round trip: real Functions mint approval, onchain mint, burn, real Functions release approval, onchain redeem consumption, and signet BTC broadcast.
- Example deployment artifacts now exist for a stable HTTPS release adapter behind Caddy, separate from throwaway tunnel-based smoke tests.
- A public testnet API and worker now provide the first user-facing Sepolia + signet flow: deposit-intent creation, unique signet deposit addresses, persisted deposit/redeem state, Chainlink Functions mint/release requests, onchain settlement, BTC broadcast, `/healthz`, `/status`, and `/metrics`.
- Public testnet startup now fails closed in `chainlink-don` mode unless EVM lockdown invariants hold: token minter locked to `MintGateway`, registry consumer locked to `MintGateway`, verifier/gateway owners renounced, configured verifier wired into both gateways, and relayer authorized on the Chainlink verifier.
- The public worker has a DON custody preparation interface. In `chainlink-don` mode it does not wallet-fund PSBTs, locally sign, or locally finalize; it requires a DON-provided spend plan and finalized Bitcoin transaction and verifies the transaction against the spend plan before broadcast.
- Public testnet reconciliation is available as `npm run reconcile:public-testnet`, a systemd timer, private metrics, and `/status` accounting fields. It checks release authorization/spend-plan consistency, outstanding redeem liabilities, stale non-final redeems, and missing DON-finalized transactions.
- The public testnet stack is deployed on Hetzner behind Cloudflare Tunnel at `api.frombitcoin.link` and `adapter.frombitcoin.link`; the deployment runbook is `docs/hetzner-public-testnet-runbook.md`.
- A redeem event source CLI can fetch canonical `RedeemRequested` JSON from independent EVM RPC providers for primary/secondary DON preflight comparison.
- Testnet deployment templates exist for `.env`, systemd units, Docker Compose, and the redeem operations runbook.
- A local regtest/testnet BTC PSBT signer gate can derive a normalized spend plan from a PSBT, verify DON authorization and attestation, reserve `redeemId`, and sign/finalize only exact-match PSBTs.
- A single-command Bitcoin regtest release harness can fund a local signer UTXO, create local/test DON release authorization and attestation artifacts, verify exact PSBT commitments, sign, broadcast, and mine confirmation when Bitcoin Core is available.

## Phase 1: Testnet-Ready Contracts

Required before testnet:

- Replace deploy defaults with explicit environment configuration. Done.
- Keep direction-specific pause controls. Done.
- Add fixed-window mint and redeem limits. Done.
- Separate deployment tooling from compile-only dependencies. Done.
- Add CI that runs `npm ci`, `npm run build`, `npm test`, and production dependency audit. Done.
- Use two-step ownership transfer with pending-owner acceptance. Done.
- Require a deployed contract owner for mainnet deployments. Done.
- Add irreversible EVM lockdown for Chainlink-DON-only integrity: locked token minter, locked registry consumer, and ownership renounce after deployment configuration. Done.
- Require DON authorization before onchain redeem consumption. Done.
- Add strict authorization artifact validation for DON nodes, relayers, and signers. Done.
- Add first EVM redeem watcher with durable local persistence and finality gating. Done.
- Split local/test DON attestation from the EVM relayer so relayer processes do not hold DON private keys. Done.
- Add external release attestation ingestion with signer quorum verification. Done.
- Add first redeem relayer with durable transaction state and onchain replay checks. Done.
- Put owner behind a multisig or timelocked admin for non-local deployments. Mainnet is enforced by deploy script; staging/testnet remains operational policy.
- Decide whether custom `WrappedBitcoin` / `Ownable` remain, or replace them with audited OpenZeppelin implementations.
- Add event and state indexing scripts for operational dashboards.

## Phase 2: Offchain Bridge Services

Required before testnet:

- BTC watcher using at least one self-operated Bitcoin node path.
- Independent secondary BTC data source and explicit disagreement policy.
- EVM watcher that waits for configured finality before release authorization. Initial local implementation is done; production operation still needs service packaging and monitoring.
- Real Chainlink DON attestation integration. Sepolia + signet is done with Chainlink Functions for mint and release; production still needs pinned infrastructure and eventual CRE/workflow packaging.
- DON node preflight for release authorization candidates. Done for local CLI/library and exercised through Chainlink Functions against Sepolia RPC sources plus an HTTPS adapter; production still needs pinned hosting and access policy.
- Independent EVM redeem event source extraction. Done for RPC-backed primary/secondary event JSON; production still needs provider diversity and node-level allowlisting.
- Chainlink/node-facing release preflight adapter. Done as HTTP adapter with stable HTTPS public testnet hosting; production still needs monitoring, allowlisted network access, and a hardened non-testnet hosting policy.
- Authorization relayer with retry, idempotency, and durable authorization logs. Initial redeem relayer and supervised service runner are done; production still needs retry policy hardening and deployment supervision.
- Durable stores for deposit observations, redeem observations, Chainlink request IDs, mint/release transactions, BTC broadcasts, and replay keys. Initial public testnet SQLite store, online backups, and reconciliation checks are done; production still needs a Postgres/HA store and restore drills.
- Strict JSON schema validation for every offchain authorization and attestation artifact. Base validator, redeem service runner, and public testnet deposit-side packaging are done; production still needs schema/version compatibility policy.

## Phase 3: BTC Custody And Signer

Required before staging:

- Use Chainlink DON-controlled BTC custody for the Chainlink-only-risk deployment model. The public worker interface is in place; the production DON custody service remains.
- Implement a DON-controlled signer that has no raw-sign endpoint.
- Enforce exact spend-plan-to-final-transaction matching before broadcast. Local regtest/testnet gate and public worker verification are done; production custody adapter remains.
- Keep the regtest release harness green against Bitcoin Core for every signer or PSBT policy change. Harness is added; CI execution still needs an environment with `bitcoind`.
- Persist consumed `redeemId`, authorization digest, unsigned transaction digest, signed txid, reservation timestamp, and final disposition. Initial local signer replay store is done; production custody integration remains.
- Ensure key rotation cannot reset replay protection.
- Broadcast only the exact signed transaction. If rebuild is needed, require a fresh authorization.

## Phase 4: Treasury And Solvency

Required before staging:

- Track available BTC, reserved BTC for pending redeems, fee buffer, pending deposits, pending mints, and wrapped supply. Initial public testnet accounting/reconciliation is done; production reserve accounting remains.
- Block new mints when wrapped supply would exceed available backing minus pending liabilities.
- Block redeems that cannot be funded under current treasury policy.
- Monitor the Hetzner signet treasury funding confirmation and maintain a redeem fee buffer before public redeem testing. Current public testnet treasury details are documented in `docs/hetzner-public-testnet-runbook.md`.
- Alert on accounting divergence, stale data, excessive pending liabilities, and reserve shortfall.
- Decide whether proof-of-reserves is public, internal-only, or auditor-facing.

## Phase 5: Mainnet Readiness

Required before mainnet:

- External smart contract audit.
- Offchain service security review.
- Custody and signer security review.
- Incident runbooks tested on staging.
- Independent replay/reorg drills for BTC and EVM sides.
- Production monitoring and paging.
- Mainnet launch caps set very low at first.
- Written process for increasing limits after clean operating windows.

## Suggested Launch Sequence

1. Local Ganache end-to-end contract tests.
2. Bitcoin regtest plus local EVM with real watcher/signer flow.
3. Sepolia plus Bitcoin signet with small artificial caps.
4. Staging with production-like keys, separate from mainnet keys.
5. External audit and remediation.
6. Mainnet canary with low mint/redeem limits.
7. Gradual limit increases after measured clean operation.
