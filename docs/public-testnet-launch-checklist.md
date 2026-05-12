# Public Testnet Launch Checklist

This checklist is for publishing the Sepolia + signet FromBitcoin public testnet. It is not a mainnet launch checklist.

## Public User Boundary

- The public UI must visibly state `TESTNET ONLY`.
- User copy must say to use Signet BTC and Sepolia ETH only.
- The public API must keep `/metrics` disabled unless it is behind private monitoring infrastructure.
- Public deposit and redeem views must not expose internal intents, nonces, PSBTs, spend plans, raw authorization payloads, raw Bitcoin transaction hex, raw errors, destination scripts, or service cursors.

## Live Endpoints

- Web UI and public API: `https://api.frombitcoin.link`
- Chainlink release preflight adapter: `https://adapter.frombitcoin.link`

Run:

```sh
npm run health:public-testnet -- \
  --base-url https://api.frombitcoin.link \
  --adapter-url https://adapter.frombitcoin.link \
  --expected-burn-gateway 0x6eFA4C217171B8B0eb856F48403928D9ad27ac96
```

Expected result:

- `/healthz` returns `ok: true`.
- `/status` returns `mode: public_testnet`, Sepolia chain id `11155111`, and Bitcoin `signet`.
- `/deposits` and `/redeems` pass the public redaction scan.
- `/metrics` returns `404`.
- `/` contains the visible `TESTNET ONLY` warning.
- adapter `/healthz` returns `ok: true`.

## Operational Guards

- `bitcoinbride-public-testnet-api.service` active.
- `bitcoinbride-public-testnet-worker.service` active.
- `bitcoinbride-don-release-adapter.service` active.
- `frombitcoin-cloudflared.service` active.
- `bitcoinbride-public-testnet-healthcheck.timer` active.
- `bitcoinbride-public-testnet-reconcile.timer` active.
- `bitcoinbride-public-testnet-backup.timer` active.
- `/var/backups/bitcoinbride` exists and is writable only by `bitcoinbride`/root.
- A manual reconciliation succeeds before announcement.
- A manual backup succeeds before announcement.

## Current Public Caps

- Minimum deposit: `1000` sats.
- Maximum deposit: `100000` sats.
- Maximum redeem: `5000` sats.
- Maximum redeem miner fee budget: `1000` sats.
- Chainlink minimum confirmations: `6`.
- EVM redeem finality: `64` Sepolia blocks.

Do not raise public caps until treasury funding and monitoring history justify it.

## Announcement Wording

Use wording that makes the asset boundary explicit:

```text
FromBitcoin public testnet is live on Sepolia + Bitcoin Signet.
Use only Signet BTC and Sepolia ETH. Do not send real BTC or mainnet assets.
```
