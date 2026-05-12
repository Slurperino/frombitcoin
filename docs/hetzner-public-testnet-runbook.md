# Hetzner Public Testnet Runbook

This runbook records the live Sepolia + signet public testnet deployment on Hetzner.

Deployment snapshot: 2026-04-27.

P0 hardening update on 2026-05-08:

- New public `BurnGateway`: `0x6eFA4C217171B8B0eb856F48403928D9ad27ac96`
- Previous `BurnGateway` `0x019937553781Fa7140189ABbf5582ED55CEfb580` was paused after redeploy.
- The new gateway enforces P2WPKH/P2WSH/P2TR destination scripts onchain and a `5000` sats / `86400` seconds redeem window.

## Live Infrastructure

- Hetzner project: `frombitcoin-testnet`
- Server: `frombitcoin-testnet-1`
- Server type: `CAX11`, ARM64, 40 GB disk
- Public IPv4: `188.34.176.115`
- OS: Ubuntu `24.04.3 LTS`
- Service user: `bitcoinbride`
- SSH key name: `frombitcoin-hetzner-testnet`
- Local SSH private key path: `~/.ssh/frombitcoin_hetzner_ed25519`

Public endpoints:

- Web UI and API: `https://api.frombitcoin.link`
- Chainlink release preflight adapter: `https://adapter.frombitcoin.link`

Cloudflare Tunnel:

- Tunnel name: `frombitcoin-public-testnet`
- Tunnel id: `b7d961c3-78d9-4d5e-a268-c4edaf741e38`
- Checked-in adapter default: `8790`; this host may use a public-testnet override only when `/etc/bitcoinbride/don-release-adapter.json` or `BITCOINBRIDE_ADAPTER_PORT` explicitly sets it.
- DNS routes:
  - `api.frombitcoin.link` -> `http://127.0.0.1:8880`
  - `adapter.frombitcoin.link` -> `http://127.0.0.1:8791` (public-testnet override; default examples and Caddy use `8790`)

## Deployed Runtime

- Node.js: `22.22.2`
- npm: `10.9.7`
- Bitcoin Core: `31.0.0`
- cloudflared: `2026.3.0`
- Firewall: `ufw` active, only OpenSSH is open inbound
- Swap: 1 GB `/swapfile`

Bitcoin Core runs on signet with pruning enabled and `dbcache=1024`.

The remote signet node was bootstrapped by copying only the local `blocks` and `chainstate` directories from a fully synced local signet node. No Bitcoin wallet files were copied.

## Public Testnet Stack

Systemd services:

```sh
bitcoind-signet.service
bitcoinbride-don-release-adapter.service
bitcoinbride-public-testnet-api.service
bitcoinbride-public-testnet-worker.service
bitcoinbride-public-testnet-healthcheck.timer
bitcoinbride-public-testnet-backup.timer
frombitcoin-cloudflared.service
```

Main paths:

```text
/opt/bitcoinbride
/etc/bitcoinbride/public-testnet.json
/etc/bitcoinbride/don-release-adapter.json
/etc/bitcoinbride/redeem-service.env
/etc/cloudflared/frombitcoin-public-testnet.yml
/etc/cloudflared/frombitcoin-public-testnet.json
/var/lib/bitcoinbride/public-testnet.sqlite
/var/backups/bitcoinbride
/var/lib/bitcoinbride/bitcoin
```

Remote Bitcoin wallet:

- Wallet name: `treasury`
- Treasury/change address: `tb1q487aurfjjc9qsqvdeuaqzude8mnh90qmglnyd8`
- Funding transaction: `67709895ca7c4e0ae67a295f4c72779c6aa8a38b6ba05e3b52a7b33185116c82`
- Funding amount: `9000` signet sats
- Current operational requirement: wait for at least one confirmation before using this treasury for bbBTC -> BTC redemption smoke tests. This funding amount is below the configured public redeem cap; either add treasury liquidity above the redeem cap plus fee budget, or lower the public redeem caps before broader user testing.

EVM relayer:

- Address: `0x1D7Ba1b8AE35Cca70C62ff13d5815516568B9922`
- Purpose: deposit intent creation, Chainlink Functions requests, mint settlement, redeem completion.

## Last Verified Snapshot

Checked on 2026-05-08:

- `systemctl --failed` reports `0 loaded units listed`.
- `bitcoind-signet`, `bitcoinbride-don-release-adapter`, `bitcoinbride-public-testnet-api`, `bitcoinbride-public-testnet-worker`, and `frombitcoin-cloudflared` are active.
- `bitcoinbride-public-testnet-healthcheck.timer` and `bitcoinbride-public-testnet-backup.timer` are installed for launch operations. New deployments should also install `bitcoinbride-public-testnet-reconcile.timer`.
- `https://api.frombitcoin.link/status` returns `ok: true` for Sepolia chain id `11155111` and Bitcoin `signet`; it is a redacted public status view and does not expose cursors, raw errors, relayer address, or exact relayer ETH.
- `https://adapter.frombitcoin.link/healthz` returns `ok: true`.
- Public frontend includes a visible `TESTNET ONLY` warning.
- Public `/metrics` returns `404`.

## Secrets Policy

Copied to the VPS:

- `RELAYER_PRIVATE_KEY`
- Sepolia RPC URLs/API-backed RPC config inside `/etc/bitcoinbride/public-testnet.json`
- Bitcoin RPC user/password generated for the VPS
- Cloudflare Tunnel credential for `frombitcoin-public-testnet`

Not copied to the VPS:

- `DEPLOYER_PRIVATE_KEY`
- `OWNER_PRIVATE_KEY`
- `DON_PRIVATE_KEYS`
- local Bitcoin Core wallet files

Do not commit files from `/etc/bitcoinbride`, `/etc/cloudflared`, or any local `.env` containing private keys.

## Health Checks

Public checks:

```sh
curl -fsS https://api.frombitcoin.link/healthz | jq
curl -fsS https://api.frombitcoin.link/status | jq
curl -fsS https://adapter.frombitcoin.link/healthz | jq
```

`/metrics` is disabled by default on the public API. Enable it only behind private monitoring infrastructure with `http.metricsEnabled: true`.

Frontend:

```sh
open https://api.frombitcoin.link/
```

SSH checks:

```sh
ssh -i ~/.ssh/frombitcoin_hetzner_ed25519 root@188.34.176.115
systemctl --failed --no-pager
systemctl is-active bitcoind-signet \
  bitcoinbride-don-release-adapter \
  bitcoinbride-public-testnet-api \
  bitcoinbride-public-testnet-worker \
  bitcoinbride-public-testnet-healthcheck.timer \
  bitcoinbride-public-testnet-backup.timer \
  frombitcoin-cloudflared
```

Public launch healthcheck:

```sh
cd /opt/bitcoinbride
sudo -u bitcoinbride npm run health:public-testnet -- \
  --base-url https://api.frombitcoin.link \
  --adapter-url https://adapter.frombitcoin.link \
  --expected-burn-gateway 0x6eFA4C217171B8B0eb856F48403928D9ad27ac96
```

Bitcoin sync:

```sh
sudo -u bitcoinbride bitcoin-cli \
  -datadir=/var/lib/bitcoinbride/bitcoin \
  -signet getblockchaininfo | jq '{blocks,headers,verificationprogress,initialblockdownload}'
```

Treasury balance:

```sh
sudo -u bitcoinbride bitcoin-cli \
  -datadir=/var/lib/bitcoinbride/bitcoin \
  -signet \
  -rpcwallet=treasury getbalances | jq
```

Treasury funding transaction:

```sh
sudo -u bitcoinbride bitcoin-cli \
  -datadir=/var/lib/bitcoinbride/bitcoin \
  -signet \
  -rpcwallet=treasury gettransaction \
  67709895ca7c4e0ae67a295f4c72779c6aa8a38b6ba05e3b52a7b33185116c82 | jq
```

Worker logs:

```sh
journalctl -u bitcoinbride-public-testnet-worker.service --no-pager -n 100
```

Healthcheck logs:

```sh
journalctl -u bitcoinbride-public-testnet-healthcheck.service --no-pager -n 100
```

Backup logs:

```sh
journalctl -u bitcoinbride-public-testnet-backup.service --no-pager -n 100
```

API logs:

```sh
journalctl -u bitcoinbride-public-testnet-api.service --no-pager -n 100
```

Adapter logs:

```sh
journalctl -u bitcoinbride-don-release-adapter.service --no-pager -n 100
```

Tunnel logs:

```sh
journalctl -u frombitcoin-cloudflared.service --no-pager -n 100
```

## Operations

Restart the whole public stack:

```sh
systemctl restart \
  bitcoind-signet.service \
  bitcoinbride-don-release-adapter.service \
  bitcoinbride-public-testnet-api.service \
  bitcoinbride-public-testnet-worker.service \
  frombitcoin-cloudflared.service
```

Restart only app services:

```sh
systemctl restart \
  bitcoinbride-don-release-adapter.service \
  bitcoinbride-public-testnet-api.service \
  bitcoinbride-public-testnet-worker.service
```

Run one worker cycle manually:

```sh
sudo -u bitcoinbride bash -lc '
  set -a
  . /etc/bitcoinbride/redeem-service.env
  set +a
  cd /opt/bitcoinbride
  npm run service:public-testnet-worker -- \
    --config /etc/bitcoinbride/public-testnet.json \
    --once
'
```

Deploy code updates:

```sh
rsync -az --delete \
  --exclude node_modules \
  --exclude ops/runs \
  --exclude 'config/*.local.json' \
  --exclude 'ops/env/*.local.env' \
  --exclude .DS_Store \
  --exclude .git \
  -e 'ssh -i ~/.ssh/frombitcoin_hetzner_ed25519' \
  ./ root@188.34.176.115:/opt/bitcoinbride/

ssh -i ~/.ssh/frombitcoin_hetzner_ed25519 root@188.34.176.115
chown -R bitcoinbride:bitcoinbride /opt/bitcoinbride
cd /opt/bitcoinbride
sudo -u bitcoinbride npm ci
sudo -u bitcoinbride npm run build
sudo -u bitcoinbride npm prune --omit=dev
sudo -u bitcoinbride npm audit --omit=dev
systemctl restart bitcoinbride-don-release-adapter bitcoinbride-public-testnet-api bitcoinbride-public-testnet-worker
```

Install/update launch timers:

```sh
cp /opt/bitcoinbride/ops/systemd/bitcoinbride-public-testnet-healthcheck.* /etc/systemd/system/
cp /opt/bitcoinbride/ops/systemd/bitcoinbride-public-testnet-reconcile.* /etc/systemd/system/
cp /opt/bitcoinbride/ops/systemd/bitcoinbride-public-testnet-backup.* /etc/systemd/system/
install -d -o bitcoinbride -g bitcoinbride -m 0750 /var/backups/bitcoinbride
systemctl daemon-reload
systemctl enable --now \
  bitcoinbride-public-testnet-healthcheck.timer \
  bitcoinbride-public-testnet-reconcile.timer \
  bitcoinbride-public-testnet-backup.timer
```

Run reconciliation manually after changing contracts, config, or custody endpoints:

```sh
sudo -u bitcoinbride npm run reconcile:public-testnet -- \
  --config /etc/bitcoinbride/public-testnet.json \
  --stale-seconds 3600 \
  --fail-on-warning
```

Run a manual backup:

```sh
cd /opt/bitcoinbride
sudo -u bitcoinbride npm run backup:public-testnet -- \
  --db /var/lib/bitcoinbride/public-testnet.sqlite \
  --out-dir /var/backups/bitcoinbride \
  --retention-days 14
```

## Current Public Testnet Limits

- Minimum deposit: `1000` sats
- Maximum deposit: `100000` sats
- Maximum redeem: `5000` sats
- Maximum redeem miner fee budget: `1000` sats
- Deposit POST rate limit: `12/min`
- Chainlink min confirmations: `6`
- EVM redeem finality: `64` Sepolia blocks

## Known Operational Notes

- BTC -> bbBTC can be tested once users send signet sats to API-generated deposit addresses.
- bbBTC -> BTC requires confirmed signet sats in the remote treasury address. The service config currently requires `minConf: 1`; the current `9000` confirmed sats are smoke-test liquidity. Keep redeem caps at or below funded treasury capacity plus fee budget, or add more signet liquidity before raising caps.
- Public testnet services now fail closed unless runtime checks confirm Sepolia + signet and deployed gateway `btcNetwork`/`bridgeDomain` match config.
- Public redeem responses report `evm_completion_confirmed` before Bitcoin broadcast. Final Bitcoin release is indicated by `bitcoin_broadcast`.
- The API and worker database starts fresh on the VPS at `/var/lib/bitcoinbride/public-testnet.sqlite`.
- The previous local Mac `screen` sessions were stopped after the Cloudflare Tunnel moved to the VPS.
- The local Mac signet node can still be run for development, but it is not part of the public tunnel path.
