# Sepolia + Signet Staging Runbook

This is the first external staging target:

- EVM: Sepolia, chain id `11155111`.
- BTC: Bitcoin signet, internal `btcNetwork` id `3`.
- Bitcoin Core RPC: signet default port `38332`.
- Bitcoin transaction/address parsing: use `--bitcoin-network signet`.

The numeric `btcNetwork` value is a bridge-local domain separator. Contracts only enforce exact equality across deployments, authorizations, PSBT artifacts, and signer policy. Current project convention:

- `1`: Bitcoin testnet/testnet3
- `2`: local regtest
- `3`: signet
- `4`: testnet4

## Required Inputs

- Primary Sepolia RPC URL.
- Secondary Sepolia RPC URL from a different provider.
- Sepolia deployer private key with ETH for deployment gas.
- Sepolia relayer private key with ETH for relay gas.
- Owner address. Use a multisig or timelock for serious staging; a hot wallet is acceptable only for throwaway tests.
- DON signer addresses and threshold.
- Signet Bitcoin Core node with a wallet-funded treasury.
- Local/test BTC signer WIF for signet only, or a custody adapter that preserves exact-match policy.

## Start Bitcoin Signet

```bash
bitcoind -signet -daemon \
  -server=1 \
  -fallbackfee=0.00001 \
  -rpcuser=bitcoinbride \
  -rpcpassword=<strong-password>
```

Create or load a treasury wallet:

```bash
bitcoin-cli -signet -rpcuser=bitcoinbride -rpcpassword=<strong-password> createwallet treasury
bitcoin-cli -signet -rpcuser=bitcoinbride -rpcpassword=<strong-password> -rpcwallet=treasury getnewaddress "" bech32
```

Fund that address from a signet faucet before attempting releases.

## Dry-Run Deployment Plan

Use exact values before deployment. The dry run prints `bridgeDomain`; copy that into the DON adapter config.

```bash
npm run deploy -- \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --expected-chain-id 11155111 \
  --deployment-environment staging \
  --owner "$OWNER_ADDRESS" \
  --signers "$DON_SIGNER_ADDRESSES" \
  --threshold 2 \
  --btc-network 3 \
  --bridge-label sepolia-signet-v1 \
  --min-confirmations 6 \
  --mint-limit-sats 100000 \
  --mint-limit-window-seconds 86400 \
  --redeem-limit-sats 100000 \
  --redeem-limit-window-seconds 86400 \
  --dry-run
```

## Deploy And Configure

If the deployer is also the owner for throwaway staging:

```bash
npm run deploy -- \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --expected-chain-id 11155111 \
  --deployment-environment staging \
  --owner "$OWNER_ADDRESS" \
  --signers "$DON_SIGNER_ADDRESSES" \
  --threshold 2 \
  --btc-network 3 \
  --bridge-label sepolia-signet-v1 \
  --min-confirmations 6 \
  --mint-limit-sats 100000 \
  --mint-limit-window-seconds 86400 \
  --redeem-limit-sats 100000 \
  --redeem-limit-window-seconds 86400 \
  --configure
```

Persist the emitted contract addresses, `bridgeDomain`, and `bridgeDomainPreimage`.

## Configure Services

Copy and edit:

```bash
sudo cp config/redeem-watcher.sepolia-signet.example.json /etc/bitcoinbride/redeem-watcher.json
sudo cp config/redeem-relayer.sepolia-signet.example.json /etc/bitcoinbride/redeem-relayer.json
sudo cp config/don-release-adapter.sepolia-signet.example.json /etc/bitcoinbride/don-release-adapter.json
```

Set:

- `watcher.rpcUrl`: primary Sepolia RPC.
- `watcher.burnGateway`: deployed `BurnGateway`.
- `watcher.fromBlock`: deployment block or first block to scan.
- `relayer.rpcUrl`: primary Sepolia RPC.
- `relayer.burnGateway`: deployed `BurnGateway`.
- `policy.expectedBridgeDomain`: deploy output `bridgeDomain`.
- `policy.signerAddresses`: configured DON signer addresses.

The included Sepolia config uses `finalityBlocks: 64`. Keep it conservative until you have observed provider behavior.

## Build Signet PSBT

For each redeem, derive the destination address/script from the burn event and build a wallet-funded PSBT:

```bash
npm run build:bitcoin-psbt -- \
  --rpc-url http://127.0.0.1:38332 \
  --rpc-user bitcoinbride \
  --rpc-password <strong-password> \
  --wallet treasury \
  --btc-network 3 \
  --bitcoin-network signet \
  --destination-address <tb1...> \
  --amount-sats <redeem-amount-sats>
```

Use the output `psbt`, `spendPlan`, and `destinationScriptPubKey` in the DON release preflight.

## DON Preflight With Two EVM Sources

Fetch the same `RedeemRequested` event from two independent Sepolia RPC providers:

```bash
npm run fetch:redeem-event -- \
  --rpc-url "$SEPOLIA_RPC_URL_PRIMARY" \
  --burn-gateway "$BURN_GATEWAY" \
  --tx-hash "$BURN_TX_HASH" \
  --log-index "$REDEEM_LOG_INDEX" \
  > redeem-event.primary.json

npm run fetch:redeem-event -- \
  --rpc-url "$SEPOLIA_RPC_URL_SECONDARY" \
  --burn-gateway "$BURN_GATEWAY" \
  --tx-hash "$BURN_TX_HASH" \
  --log-index "$REDEEM_LOG_INDEX" \
  --expected-redeem-request-hash "$(node -e 'console.log(require("./redeem-event.primary.json").redeemRequestHash)')" \
  --expected-block-hash "$(node -e 'console.log(require("./redeem-event.primary.json").blockHash)')" \
  > redeem-event.secondary.json
```

Then preflight:

```bash
npm run verify:don-release -- \
  --authorization release-authorization.json \
  --redeem-event redeem-event.primary.json \
  --secondary-redeem-event redeem-event.secondary.json \
  --spend-plan spend-plan.json \
  --expected-bridge-domain "$BRIDGE_DOMAIN" \
  --expected-btc-network 3 \
  --expected-source-evm-chain-id 11155111 \
  --signers "$DON_SIGNER_ADDRESSES" \
  --threshold 2 \
  --require-secondary-redeem-event \
  --max-authorization-ttl-seconds 1200
```

## Run Services

```bash
npm run service:redeems -- --config /etc/bitcoinbride/redeem-watcher.json --role watcher
npm run service:don-release-adapter -- --config /etc/bitcoinbride/don-release-adapter.json
npm run service:redeems -- --config /etc/bitcoinbride/redeem-relayer.json --role relayer
```

Health endpoints:

- watcher: `http://127.0.0.1:8787/healthz`
- relayer: `http://127.0.0.1:8789/healthz`
- DON adapter: `http://127.0.0.1:8790/healthz`

## Production Boundary

Use the local/test BTC WIF signer only for signet. Mainnet needs HSM/MPC/custody integration that preserves:

- no raw-sign endpoint,
- exact PSBT-to-authorization matching,
- durable `redeemId` replay protection,
- identical signed-transaction rebroadcast policy.
