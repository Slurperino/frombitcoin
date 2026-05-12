# Chainlink Functions Testnet Runbook

Status: staging deployed
Target: Ethereum Sepolia + Bitcoin signet

## Goal

Move from local ECDSA DON simulation to a Chainlink Functions-backed authorization path on Sepolia.

The current Sepolia deployment remains valid for local signer testing. Chainlink Functions requires a new deployment because `MintGateway` and `BurnGateway` store their verifier address immutably.

## Chainlink Sepolia Constants

- Functions router: `0xb83E47C2bC239B3bf370bc41e1459A34b41238D0`
- DON ID: `fun-ethereum-sepolia-1`
- DON ID bytes32: `0x66756e2d657468657265756d2d7365706f6c69612d3100000000000000000000`
- LINK token: `0x779877A7B0D9E8603169DdbD7836e478b4624789`
- Testnet ETH/LINK faucet: `https://faucets.chain.link/sepolia`
- Functions subscriptions UI: `https://functions.chain.link`

## Current Sepolia Functions Deployment

This stack uses the real Sepolia Functions router. It is separate from the active ECDSA staging deployment.

- Bridge label: `sepolia-signet-v1-chainlink`
- Bridge domain: `0xb84b49c26567950191efc570d62716815979df41894b791965fae07dd06ce09a`
- ChainlinkFunctionsVerifier: `0x9aE15CfE2D73c284BD3428EdB875D34aA5bb61FA`
- WrappedBitcoin: `0xBAb9A08FB7c20BE72338849301A3363bd6E2cFbD`
- DepositRegistry: `0x914308aa15cC3907532db70aD2079c179c456e86`
- MintGateway: `0x6a35f458E97093BC4458c84FfC04Cff67d5C4FE3`
- BurnGateway: `0x019937553781Fa7140189ABbf5582ED55CEfb580`
- Authorized requester: relayer from `ops/env/sepolia-signet.local.env`
- Configured subscription ID: `6509`
- Subscription funding: `10 LINK` initially funded on Sepolia. Recheck current balance before running smoke tests.

## What The Functions DON Checks

The mint source at `chainlink/functions/mint-authorization.js`:

1. Reads the Bitcoin transaction from a primary Esplora-compatible API.
2. Reads the same transaction from a secondary Esplora-compatible API.
3. Checks the requested `txid`, `vout`, output value, deposit address, block height, and block hash.
4. Checks both Bitcoin sources agree.
5. Checks the authorization confirmation count is consistent with the observed block height.
6. Checks the current observed chain tip satisfies the configured confirmation policy.
7. Returns `abi.encode(uint8(1), mintStructHash)` only if all checks pass.

The release source at `chainlink/functions/release-authorization.js`:

1. Reads the burn transaction receipt from a primary Sepolia RPC.
2. Reads the same receipt from a secondary Sepolia RPC.
3. Decodes `RedeemRequested`.
4. Checks the event fields against `ReleaseAuthorizationV1`.
5. Checks the primary and secondary sources agree.
6. Checks the configured finality block depth.
7. Calls the DON release adapter preflight with the authorization, both events, and the spend plan.
8. Returns `abi.encode(uint8(2), releaseStructHash)` only if all checks pass.

The onchain `ChainlinkFunctionsVerifier` only approves the exact struct hash returned through the real Functions router callback.

## Validated Smoke Test

The current deployment completed one Sepolia + signet round trip with real Chainlink Functions callbacks.

- Mint request: `0xe15a42c504c2e36fb7f6ed480c49aa0d60f8c77f15b48fe952c8ebf3345e4a4f`
- Mint transaction: `0x8dcf5df7c42e6c3e0444deb5ce6d1f5681244188a284d7ab83ebc1519d76aad9`
- Burn transaction: `0x2de0f643dc4d4215c27bf8fdad215b06cd5a0d570905bfa4afbcd60517cdbe96`
- Release request: `0x7203cf8e5d80e777c9ad31be9d27be945bfdab26e7df7b05aed81d376487f75c`
- Redeem completion transaction: `0x9a7cc5c5b38965968376469516982b512308a6f4eef2c8b5f04cc58f286de168`
- Bitcoin signet transaction: `fd95f1db5a021e43b934f120f8c00cde69f75f56ed4303a0e99fa2ea16b6524c`

The local artifacts for that run are under `ops/runs/sepolia-signet-chainlink/`.

## Deploy Chainlink Functions Stack

If redeploying from scratch, create and fund a Functions subscription first, then add the deployed verifier as a consumer after deployment.

```bash
set -a
source ops/env/sepolia-signet.local.env
set +a

export CHAINLINK_FUNCTIONS_ROUTER=0xb83E47C2bC239B3bf370bc41e1459A34b41238D0
export CHAINLINK_FUNCTIONS_DON_ID=fun-ethereum-sepolia-1
export CHAINLINK_FUNCTIONS_SUBSCRIPTION_ID=<subscription-id>

npm run deploy -- \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --expected-chain-id 11155111 \
  --deployment-environment staging \
  --attestation-mode chainlink-functions \
  --functions-router "$CHAINLINK_FUNCTIONS_ROUTER" \
  --functions-subscription-id "$CHAINLINK_FUNCTIONS_SUBSCRIPTION_ID" \
  --functions-don-id "$CHAINLINK_FUNCTIONS_DON_ID" \
  --functions-callback-gas-limit 300000 \
  --authorized-requesters "$RELAYER_ADDRESS" \
  --owner "$OWNER_ADDRESS" \
  --btc-network "$BTC_NETWORK" \
  --bridge-label "$BRIDGE_LABEL-chainlink" \
  --min-confirmations 6 \
  --mint-limit-sats 100000 \
  --mint-limit-window-seconds 86400 \
  --redeem-limit-sats 100000 \
  --redeem-limit-window-seconds 86400 \
  --configure \
  --owner-private-key "$OWNER_PRIVATE_KEY"
```

After deployment, add `ChainlinkFunctionsVerifier` as a consumer in the Functions subscription.

For the current deployment, update the placeholder subscription ID once the real funded subscription exists:

```bash
set -a
source ops/env/sepolia-signet.local.env
set +a

npm run configure:chainlink-functions -- \
  --authorize-requesters "$RELAYER_ADDRESS"
```

## Adapter Exposure

For Chainlink nodes, the DON release adapter must be reachable over public HTTPS. `127.0.0.1` will not work from Chainlink nodes.

Current public testnet adapter URL:

```text
https://adapter.frombitcoin.link/release/preflight
```

The live Hetzner and Cloudflare Tunnel deployment details are tracked in
`docs/hetzner-public-testnet-runbook.md`.

For throwaway smoke tests, a temporary HTTPS tunnel is acceptable. For a separate self-hosted Caddy deployment, deploy the adapter behind a stable HTTPS hostname:

```bash
cp config/don-release-adapter.sepolia-signet-chainlink.example.json /etc/bitcoinbride/don-release-adapter.json
cp ops/env/redeem-service.env.example /etc/bitcoinbride/redeem-service.env
```

Set values like these in `/etc/bitcoinbride/redeem-service.env`:

```bash
BITCOINBRIDE_ADAPTER_DOMAIN=<adapter-domain>
ACME_EMAIL=<ops-email>
BITCOINBRIDE_ADAPTER_HOST=0.0.0.0
BITCOINBRIDE_ADAPTER_PORT=8790
```

Point DNS for `BITCOINBRIDE_ADAPTER_DOMAIN` at the host, then run:

```bash
docker compose \
  -f ops/docker/compose.sepolia-signet-chainlink.example.yml \
  up -d --build
```

The Caddy example at `ops/caddy/Caddyfile.chainlink-adapter.example` exposes only:

- `GET /healthz`
- `POST /release/preflight`

Use `https://$BITCOINBRIDE_ADAPTER_DOMAIN/release/preflight` as `--adapter-url` in the request command. Keep quick tunnels for manual smoke tests only.

## Request A Mint Authorization

Create the deposit intent and `MintAuthorizationV1` artifact first, then request Chainlink authorization:

```bash
npm run request:chainlink-mint -- \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --private-key "$RELAYER_PRIVATE_KEY" \
  --verifier "$CHAINLINK_FUNCTIONS_VERIFIER" \
  --primary-bitcoin-api "https://mempool.space/signet/api" \
  --secondary-bitcoin-api "https://blockstream.info/signet/api" \
  --deposit-address "$SIGNET_TREASURY_ADDRESS" \
  --authorization mint-authorization.json
```

The command prints the Functions request transaction, `requestId`, `mintStructHash`, and `chainlinkAttestation` bytes to pass into `mintWithAuthorization` after the callback approves.

## Request A Release Authorization

Build the PSBT/spend plan first, then request Chainlink authorization:

```bash
npm run request:chainlink-release -- \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --private-key "$RELAYER_PRIVATE_KEY" \
  --verifier "$CHAINLINK_FUNCTIONS_VERIFIER" \
  --adapter-url "https://<public-adapter-host>/release/preflight" \
  --primary-rpc-url "$SEPOLIA_RPC_URL_PRIMARY" \
  --secondary-rpc-url "$SEPOLIA_RPC_URL_SECONDARY" \
  --burn-gateway "$CHAINLINK_BURN_GATEWAY" \
  --authorization release-authorization.json \
  --spend-plan normalized-spend-plan.json
```

The command prints:

- the Functions request transaction,
- the `requestId`,
- the `releaseStructHash`,
- and the `chainlinkAttestation` bytes to pass into `completeRedeemWithAuthorization` after the callback approves.

If needed, recreate the attestation bytes:

```bash
npm run encode:chainlink-attestation -- --request-id <request-id>
```

## Operational Notes

- Do not share the same `bridgeLabel` between ECDSA staging and Chainlink staging.
- Keep the ECDSA verifier deployment as a fallback until the Functions path has completed at least one signet release.
- For production, replace temporary HTTPS tunnels with pinned infrastructure and move this workflow to CRE when deploy access is available.
