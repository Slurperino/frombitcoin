# Public Testnet Runbook

This runbook describes the public Sepolia + signet testnet service.

The public service has two processes:

- `public-testnet-api`: creates deposit intents, allocates unique signet deposit addresses, and exposes user-facing status endpoints.
- `public-testnet-worker`: observes signet deposits, requests Chainlink Functions authorizations, mints bbBTC, watches burns, prepares release spend plans through the configured custody path, completes redeems on Sepolia, and broadcasts signet releases.

Redeem recovery is two-phase in the public worker. After `completeRedeemWithAuthorization` is submitted, the worker persists `redeem_submitted` with the EVM transaction hash and reconciles that receipt on later cycles before moving to the internal `redeem_completed` state. Public API responses map that state to `evm_completion_confirmed`; it is not final Bitcoin settlement. Bitcoin broadcast remains eligible only after confirmed EVM completion. If Bitcoin broadcast fails after a transaction hex has been finalized, retries reuse the same internal `bitcoin_tx_hex`, but that transaction hex is not exposed by the public API.

The live Hetzner + Cloudflare deployment is recorded in:

- [Hetzner Public Testnet Runbook](./hetzner-public-testnet-runbook.md)

## Current Testnet Contracts

The default example config targets the Chainlink Functions staging deployment:

- `ChainlinkFunctionsVerifier`: `0x9aE15CfE2D73c284BD3428EdB875D34aA5bb61FA`
- `WrappedBitcoin`: `0xBAb9A08FB7c20BE72338849301A3363bd6E2cFbD`
- `DepositRegistry`: `0x914308aa15cC3907532db70aD2079c179c456e86`
- `MintGateway`: `0x6a35f458E97093BC4458c84FfC04Cff67d5C4FE3`
- `BurnGateway`: `0x6eFA4C217171B8B0eb856F48403928D9ad27ac96`
- `bridgeDomain`: `0xb84b49c26567950191efc570d62716815979df41894b791965fae07dd06ce09a`

If `bitcoin.custodyController` is set to `chainlink-don`, replace these addresses with a deployment created with `--chainlink-only-risk` or keep the config in `local-wallet` mode for staging. The strict runtime guard rejects `chainlink-don` configs whose contracts are not locked and owner-renounced.

## Required Secrets

Do not put private keys in JSON config files.

Set these environment variables on the host or in `/etc/bitcoinbride/redeem-service.env`:

```sh
RELAYER_PRIVATE_KEY=...
BITCOIN_RPC_USER=...
BITCOIN_RPC_PASSWORD=...
```

The relayer must be authorized in `ChainlinkFunctionsVerifier` and needs enough Sepolia ETH to:

- create deposit intents,
- request Chainlink Functions mint/release authorizations,
- call `mintWithAuthorization`,
- call `completeRedeemWithAuthorization`.

For `bitcoin.custodyController = "local-wallet"`, the Bitcoin Core wallet configured as `treasury` must:

- run on signet,
- be unlocked if encrypted,
- own the configured treasury/change address,
- hold enough signet BTC to fund redeem releases.

For `bitcoin.custodyController = "chainlink-don"`, release custody is controlled by the Chainlink DON. Configure `bitcoin.donCustodyAdapterUrl` to the DON custody preparation endpoint. The public worker will not build wallet-funded PSBTs and will not call `walletprocesspsbt` or `finalizepsbt`; it verifies the DON-finalized Bitcoin transaction against the exact normalized spend plan and only broadcasts that transaction after EVM redeem completion.

## Configure

Start from:

```sh
cp config/public-testnet.sepolia-signet-chainlink.example.json /etc/bitcoinbride/public-testnet.json
```

Edit at least:

- `evm.rpcUrl`
- `evm.primaryRpcUrl`
- `evm.secondaryRpcUrl`
- `chainlink.adapterUrl`
- `bitcoin.donCustodyAdapterUrl` when `bitcoin.custodyController` is `chainlink-don`
- `bitcoin.rpcUrl`
- `bitcoin.rpcUserEnv` / `bitcoin.rpcPasswordEnv` or `bitcoin.rpcCookie`
- public limits under `deposits` and `redeems`

If running through Docker and Bitcoin Core runs on the host, set `bitcoin.rpcUrl` to a host-reachable address such as `http://host.docker.internal:38332`.

The public API and worker fail closed unless the runtime is Sepolia + signet:

- config `evm.chainId` must be `11155111`,
- Bitcoin Core `getblockchaininfo.chain` must be `signet`,
- config `bitcoin.bitcoinNetwork` must be `signet`,
- config `bitcoin.btcNetwork` must be `3`,
- configured contract addresses must contain bytecode,
- gateway `btcNetwork` and `bridgeDomain` must match config.
- in `chainlink-don` mode, token minter and registry consumer must be locked to `MintGateway`, gateway/verifier ownership must be renounced, and the relayer must be authorized on `ChainlinkFunctionsVerifier`.

The Docker Compose example uses:

```text
config/public-testnet.sepolia-signet-chainlink.docker.example.json
```

That variant binds the API to `0.0.0.0` inside the container and points Bitcoin RPC at `host.docker.internal`.

## DON Custody Adapter

The formal interface is [DON Custody Interface V1](./don-custody-interface-v1.md).

When `bitcoin.custodyController` is `chainlink-don`, `bitcoin.donCustodyAdapterUrl` must accept a `DonReleasePreparationRequestV1` JSON payload. The request includes:

- `bridgeDomain`, `btcNetwork`, `sourceEvmChainId`, and `bitcoinNetwork`
- `treasuryAddress` and `changePolicyHash`
- the canonical `redeemEvent`
- the destination address derived locally from `destinationScriptPubKey`

The response must return a `NormalizedSpendPlanV1` and `bitcoinTxHex`, either at the top level or under `data`. The worker parses the finalized transaction and verifies version, locktime, inputs, outputs, scripts, and values against the spend plan before it persists the row. The adapter must not expose a raw-sign endpoint; it should only return transactions that satisfy the DON custody policy for the exact redeem event.

## Run Locally

```sh
npm run service:public-testnet-api -- --config /etc/bitcoinbride/public-testnet.json
npm run service:public-testnet-worker -- --config /etc/bitcoinbride/public-testnet.json
```

For a one-cycle worker dry operational check:

```sh
npm run service:public-testnet-worker -- --config /etc/bitcoinbride/public-testnet.json --once
```

## Public API

Health:

```sh
curl http://127.0.0.1:8880/healthz
```

Publication readiness healthcheck:

```sh
npm run health:public-testnet -- \
  --base-url https://api.frombitcoin.link \
  --adapter-url https://adapter.frombitcoin.link \
  --expected-burn-gateway 0x6eFA4C217171B8B0eb856F48403928D9ad27ac96
```

Frontend:

```sh
open http://127.0.0.1:8880/
```

Public status:

```sh
curl http://127.0.0.1:8880/status
```

Create a deposit intent:

```sh
curl -X POST http://127.0.0.1:8880/deposits \
  -H 'content-type: application/json' \
  -d '{"recipient0x":"0x0000000000000000000000000000000000000001","expectedSats":"10000"}'
```

The response includes:

- `depositId`
- `depositAddress`
- `expectedSats`
- `expiry`
- `createIntentTxHash`

The user sends exactly `expectedSats` signet sats to `depositAddress`. The worker waits for the configured confirmations, requests Chainlink Functions approval, and mints bbBTC to `recipient0x`.

Read deposit state:

```sh
curl http://127.0.0.1:8880/deposits/0x...
curl http://127.0.0.1:8880/deposits
```

Read redeem state:

```sh
curl http://127.0.0.1:8880/redeems/0x...
curl http://127.0.0.1:8880/redeems
```

Public deposit and redeem endpoints return redacted user-safe views. They do not expose internal intents, nonces, PSBTs, spend plans, authorization payloads, raw Bitcoin transaction hex, raw errors, destination scripts, or service cursors.

Prometheus-style metrics are disabled by default in public config. To expose local-only metrics, set `http.metricsEnabled` to `true` and keep `/metrics` behind private infrastructure:

```sh
curl http://127.0.0.1:8880/metrics
```

Run reconciliation manually after deploys, config changes, or stuck redeem alerts:

```sh
npm run reconcile:public-testnet -- \
  --config /etc/bitcoinbride/public-testnet.json \
  --stale-seconds 3600 \
  --fail-on-warning
```

The reconciliation report checks stored release authorizations against spend plans, counts outstanding redeem liabilities, flags stale non-final redeems, and fails closed when a `chainlink-don` release row lacks a finalized Bitcoin transaction.

## Public HTTPS

The example Caddy config exposes:

- `BITCOINBRIDE_ADAPTER_DOMAIN` for Chainlink release preflight.
- `BITCOINBRIDE_PUBLIC_API_DOMAIN` for `/`, `/healthz`, `/status`, `/deposits`, and `/redeems`.

Set DNS first, then run the chainlink compose example or equivalent systemd units.

The checked-in adapter default is `8790`. The current public testnet uses Cloudflare Tunnel instead of Caddy and may use a host-specific override only when the runtime adapter config or environment explicitly sets that port:

- `https://api.frombitcoin.link` -> `127.0.0.1:8880`
- `https://adapter.frombitcoin.link` -> `127.0.0.1:8791` (public-testnet override; default examples and Caddy use `8790`)

## Safety Limits

The public config enforces:

- exact deposit amounts,
- min/max deposit sats,
- max redeem sats,
- max redeem miner fee budget,
- fixed per-IP, global, and per-recipient API POST limits,
- minimum relayer ETH balance for public deposit creation,
- P2WPKH/P2WSH/P2TR destination script policy for redeem releases,
- PSBT spend plan revalidation before local signing in `local-wallet` mode,
- no local wallet PSBT funding, local Bitcoin wallet signing, or local finalization in `chainlink-don` custody mode,
- locked treasury UTXOs after wallet-funded release PSBT creation,
- Sepolia finality before redeem authorization,
- Chainlink Functions checks against primary and secondary EVM/Bitcoin data sources.

Start with small public limits until the service has enough monitoring and treasury funding history.
The current checked-in public testnet examples keep redeems capped at `5000` sats with a `1000` sat miner fee budget so the live signet treasury can cover the current wrapped supply.

## Backups and Monitoring

The public testnet deployment includes three systemd timers:

- `bitcoinbride-public-testnet-healthcheck.timer`: runs the public redaction and endpoint healthcheck every two minutes.
- `bitcoinbride-public-testnet-reconcile.timer`: runs the DB/onchain release reconciliation every five minutes.
- `bitcoinbride-public-testnet-backup.timer`: creates a daily online SQLite backup using `VACUUM INTO`.

Manual backup:

```sh
npm run backup:public-testnet -- \
  --db /var/lib/bitcoinbride/public-testnet.sqlite \
  --out-dir /var/backups/bitcoinbride \
  --retention-days 14
```

Manual healthcheck:

```sh
npm run health:public-testnet -- \
  --base-url https://api.frombitcoin.link \
  --adapter-url https://adapter.frombitcoin.link \
  --expected-burn-gateway 0x6eFA4C217171B8B0eb856F48403928D9ad27ac96
```
