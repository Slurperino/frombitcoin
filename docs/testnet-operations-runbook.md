# Testnet Operations Runbook

Status: draft
Date: 2026-04-24

This runbook is for operating the redeem-side bridge services on testnet or staging. It is not a mainnet approval checklist.

## Runtime Requirements

- Node.js `>=22.5.0` because the durable store uses `node:sqlite`.
- A dedicated OS user such as `bitcoinbride`.
- Separate secret scope per process:
  - watcher: no private keys,
  - local/test attester: `DON_PRIVATE_KEYS`,
  - relayer: `RELAYER_PRIVATE_KEY`,
  - local PSBT signer: `BTC_SIGNER_WIF`,
  - production relayer: no DON keys.
- A durable data directory, normally `/var/lib/bitcoinbride`.
- Config files in `/etc/bitcoinbride`, owned by root and readable by the `bitcoinbride` group.

## Install From Source

```bash
sudo useradd --system --home /var/lib/bitcoinbride --shell /usr/sbin/nologin bitcoinbride
sudo install -d -o bitcoinbride -g bitcoinbride /var/lib/bitcoinbride
sudo install -d -o root -g bitcoinbride -m 0750 /etc/bitcoinbride
sudo install -d -o root -g root /opt/bitcoinbride
```

Copy the project to `/opt/bitcoinbride`, then install and build:

```bash
cd /opt/bitcoinbride
npm ci
npm run build
npm prune --omit=dev
```

## Configure Services

Copy and edit these files:

```bash
sudo cp config/redeem-watcher.testnet.example.json /etc/bitcoinbride/redeem-watcher.json
sudo cp config/redeem-attester-local.testnet.example.json /etc/bitcoinbride/redeem-attester-local.json
sudo cp config/redeem-relayer.testnet.example.json /etc/bitcoinbride/redeem-relayer.json
sudo cp ops/env/redeem-service.env.example /etc/bitcoinbride/redeem-service.env
sudo chmod 0600 /etc/bitcoinbride/redeem-service.env
```

Edit the configs before starting:

- Set every `rpcUrl`.
- Set every `burnGateway`.
- Set `fromBlock` to the deployment block or later verified start block.
- Set `finalityBlocks` according to the target EVM chain.
- Put the normalized spend plan at `/etc/bitcoinbride/release-spend-plan.json`.
- Set `changePolicyHash`.
- Set `RELAYER_PRIVATE_KEY` only for the relayer.
- Set `DON_PRIVATE_KEYS` only for the local/test attester.
- Set `BTC_SIGNER_WIF` only where the local PSBT signer is allowed to run.

Production-style Chainlink integration should leave the local attester disabled and ingest externally produced `ReleaseAttestationV1` artifacts with `npm run ingest:attestation`.

## Bitcoin Core Regtest PSBT

This machine must have `bitcoind` / `bitcoin-cli` installed to run the real regtest flow. The repository provides RPC clients and CLIs, but does not vendor Bitcoin Core.

Example local regtest bootstrap:

```bash
bitcoind -regtest -daemon \
  -fallbackfee=0.00001 \
  -server=1 \
  -rpcuser=bitcoinbride \
  -rpcpassword=bitcoinbride

bitcoin-cli -regtest -rpcuser=bitcoinbride -rpcpassword=bitcoinbride createwallet treasury
TREASURY_ADDRESS=$(bitcoin-cli -regtest -rpcuser=bitcoinbride -rpcpassword=bitcoinbride -rpcwallet=treasury getnewaddress "" bech32)
bitcoin-cli -regtest -rpcuser=bitcoinbride -rpcpassword=bitcoinbride generatetoaddress 101 "$TREASURY_ADDRESS"
DESTINATION_ADDRESS=$(bitcoin-cli -regtest -rpcuser=bitcoinbride -rpcpassword=bitcoinbride -rpcwallet=treasury getnewaddress "" bech32)
```

Single-command local release check:

```bash
DON_PRIVATE_KEYS=<comma-separated-local-test-don-private-keys> \
npm run regtest:bitcoin-release -- \
  --rpc-url http://127.0.0.1:18443 \
  --rpc-user bitcoinbride \
  --rpc-password bitcoinbride \
  --wallet treasury \
  --threshold <don-threshold> \
  --broadcast \
  --mine-confirmation
```

The harness funds a regtest P2WPKH signer UTXO, derives a candidate `BitcoinPsbtV1`, creates a test `ReleaseAuthorizationV1` plus `ReleaseAttestationV1`, verifies exact PSBT commitments through the local policy signer, signs, broadcasts, and mines one confirmation. It prints a generated regtest WIF when `--btc-signer-wif` is omitted; keep that mode for local regtest only.

DON-node preflight for a release authorization:

Fetch the canonical redeem event JSON from two independent EVM RPC sources:

```bash
npm run fetch:redeem-event -- \
  --rpc-url <primary-evm-rpc> \
  --burn-gateway <burn-gateway-address> \
  --tx-hash <burn-tx-hash> \
  --log-index <redeem-requested-log-index> \
  > /tmp/redeem-event.primary.json

npm run fetch:redeem-event -- \
  --rpc-url <secondary-evm-rpc> \
  --burn-gateway <burn-gateway-address> \
  --tx-hash <burn-tx-hash> \
  --log-index <redeem-requested-log-index> \
  --expected-block-hash <primary-block-hash> \
  --expected-redeem-request-hash <primary-redeem-request-hash> \
  > /tmp/redeem-event.secondary.json
```

```bash
npm run verify:don-release -- \
  --authorization /path/to/release-authorization.json \
  --redeem-event /tmp/redeem-event.primary.json \
  --secondary-redeem-event /tmp/redeem-event.secondary.json \
  --spend-plan /path/to/normalized-spend-plan.json \
  --expected-bridge-domain <bytes32> \
  --expected-btc-network 2 \
  --expected-source-evm-chain-id <chain-id> \
  --signers <comma-separated-don-signers> \
  --threshold <don-threshold> \
  --require-secondary-redeem-event \
  --max-authorization-ttl-seconds 1200
```

Use `--psbt /path/to/bitcoin-psbt.json --bitcoin-network regtest` instead of `--spend-plan` when the node should derive commitments directly from the candidate PSBT. Do not sign the DON message digest unless this check passes against the node's own observed event and local bridge configuration.

To expose the same policy as an HTTP adapter:

```bash
npm run service:don-release-adapter -- \
  --config /etc/bitcoinbride/don-release-adapter.json
```

The adapter exposes `GET /healthz` and `POST /release/preflight`. It accepts Chainlink-style `{ "id": "...", "data": { ... } }` payloads and returns `result` as the verified DON `messageDigest`. Configure the expected bridge domain, BTC network, source chain id, signer set, threshold, TTL, secondary-source requirement, and minimum deadline window in `/etc/bitcoinbride/don-release-adapter.json`; do not accept those values from request payloads.

Build a wallet-funded PSBT and derive the spend plan from the PSBT itself:

```bash
npm run build:bitcoin-psbt -- \
  --rpc-url http://127.0.0.1:18443 \
  --rpc-user bitcoinbride \
  --rpc-password bitcoinbride \
  --wallet treasury \
  --btc-network 2 \
  --bitcoin-network regtest \
  --destination-address "$DESTINATION_ADDRESS" \
  --amount-sats 80000
```

The output includes:

- `psbt`: a `BitcoinPsbtV1` artifact,
- `spendPlan`: the derived `NormalizedSpendPlanV1`,
- `destinationScriptPubKey`,
- `spendPlanDigest`,
- `unsignedPsbtDigest`.

Use that `spendPlan` as the candidate plan for DON release authorization. After the DON attestation exists, sign through the local policy gate below.

## Local PSBT Signing Check

For regtest/testnet, the local signer gate signs only after deriving the spend plan from the PSBT and verifying the DON authorization:

```bash
BTC_SIGNER_WIF=<regtest-or-testnet-wif> \
npm run sign:release-psbt -- \
  --db /var/lib/bitcoinbride/btc-signer.sqlite \
  --authorization /path/to/release-authorization.json \
  --attestation /path/to/release-attestation.json \
  --psbt /path/to/bitcoin-psbt.json \
  --bitcoin-network regtest \
  --signers <comma-separated-don-signers> \
  --threshold <don-threshold> \
  --expected-bridge-domain <bytes32> \
  --expected-btc-network <btc-network-id> \
  --wif-env BTC_SIGNER_WIF
```

Use `--dry-run` first to verify policy and reserve the `redeemId` without signing. Do not use this local WIF path for mainnet custody; mainnet needs an HSM/MPC/custody adapter that preserves the same exact-match checks and replay store semantics.

Broadcast the finalized transaction:

```bash
npm run broadcast:bitcoin-tx -- \
  --rpc-url http://127.0.0.1:18443 \
  --rpc-user bitcoinbride \
  --rpc-password bitcoinbride \
  --tx-hex <signed-transaction-hex>
```

Then mine a confirmation in regtest:

```bash
MINER_ADDRESS=$(bitcoin-cli -regtest -rpcuser=bitcoinbride -rpcpassword=bitcoinbride getnewaddress "" bech32)
bitcoin-cli -regtest -rpcuser=bitcoinbride -rpcpassword=bitcoinbride generatetoaddress 1 "$MINER_ADDRESS"
```

This gives the end-to-end BTC side check: wallet-funded PSBT -> DON-authorized commitments -> signer exact-match verification -> signed raw tx -> broadcast -> confirmation.

If `walletcreatefundedpsbt` produces a PSBT without UTXO data, the signer will reject it because it cannot derive input values and script templates. Fix the Bitcoin Core wallet/options instead of bypassing the signer.

## Systemd Deployment

Install the units:

```bash
sudo cp ops/systemd/bitcoinbride-redeem-*.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Start watcher first:

```bash
sudo systemctl enable --now bitcoinbride-redeem-watcher
curl -fsS http://127.0.0.1:8787/healthz
```

For local/test DON signing, start the local attester:

```bash
sudo systemctl enable --now bitcoinbride-redeem-attester-local
curl -fsS http://127.0.0.1:8788/healthz
```

Start the relayer last:

```bash
sudo systemctl enable --now bitcoinbride-redeem-relayer
curl -fsS http://127.0.0.1:8789/healthz
```

Logs:

```bash
journalctl -u bitcoinbride-redeem-watcher -f
journalctl -u bitcoinbride-redeem-attester-local -f
journalctl -u bitcoinbride-redeem-relayer -f
```

Metrics:

```bash
curl -fsS http://127.0.0.1:8787/metrics
curl -fsS http://127.0.0.1:8788/metrics
curl -fsS http://127.0.0.1:8789/metrics
```

## Docker Compose Deployment

Copy the example compose file and env template before editing:

```bash
cp ops/docker/compose.testnet.example.yml ops/docker/compose.testnet.yml
cp ops/env/redeem-service.env.example ops/env/redeem-service.env
```

Then edit:

- `ops/env/redeem-service.env`
- `config/redeem-watcher.testnet.example.json`
- `config/redeem-attester-local.testnet.example.json`
- `config/redeem-relayer.testnet.example.json`
- `release-spend-plan.json`

Start:

```bash
docker compose -f ops/docker/compose.testnet.yml up --build -d
```

Check health:

```bash
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8788/healthz
curl -fsS http://127.0.0.1:8789/healthz
```

## Normal Operating Checks

- Watcher logs should show `watcher_cycle_completed`.
- Attester logs should show `attester_cycle_completed` only on local/test setups.
- Relayer logs should show `relayer_cycle_completed`.
- `bitcoinbride_service_up` should be `1` on all enabled processes.
- `bitcoinbride_redeem_events{status="relayed"}` should not grow without receipts becoming `consumed`.
- `bitcoinbride_redeem_events{status="failed"}` should page an operator.

## Incident Stops

Stop the relayer first if there is any uncertainty about DON attestations, spend plans, RPC integrity, or treasury funding:

```bash
sudo systemctl stop bitcoinbride-redeem-relayer
```

Stop the local/test attester next if authorization production is suspect:

```bash
sudo systemctl stop bitcoinbride-redeem-attester-local
```

Keep the watcher running if the event feed is healthy; it preserves observability. Stop it only when the RPC source or chain identity is suspect:

```bash
sudo systemctl stop bitcoinbride-redeem-watcher
```

Never delete `/var/lib/bitcoinbride/redeems.sqlite` during incident response. Back it up before any manual repair.

## Cursor Recovery

The watcher cursor is persisted in SQLite under `evm_redeem_watcher.last_scanned_block`.

Only move the cursor backward after confirming the scan range will not create false positives. `RedeemRequested` rows are unique by request hash and `(tx_hash, log_index)`, so rescanning a known-safe range is acceptable.

Do not move the cursor forward to skip an unexplained error. Fix the error or quarantine the affected range first.
