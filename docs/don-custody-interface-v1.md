# DON Custody Interface V1

This document defines the interface expected from the Chainlink DON-controlled BTC custody path.

The purpose of this interface is to keep FromBitcoin's production redeem path inside the Chainlink-only-risk model:

- the app worker does not locally fund PSBTs,
- the app worker does not locally sign Bitcoin spends,
- the app worker does not locally finalize Bitcoin transactions,
- the app worker only broadcasts a finalized Bitcoin transaction whose inputs and outputs match a DON-produced normalized spend plan.

## Endpoint

`bitcoin.donCustodyAdapterUrl` must accept:

```text
POST /release/prepare
content-type: application/json
accept: application/json
```

The endpoint may return the response object directly or inside a Chainlink-style `{ "data": ... }` envelope.

## Request

Schema: [don-release-preparation-request.schema.json](../schemas/don-release-preparation-request.schema.json)

```json
{
  "kind": "DonReleasePreparationRequestV1",
  "schemaVersion": "1.0.0",
  "bridgeDomain": "0xb84b49c26567950191efc570d62716815979df41894b791965fae07dd06ce09a",
  "btcNetwork": "3",
  "sourceEvmChainId": "11155111",
  "bitcoinNetwork": "signet",
  "treasuryAddress": "tb1q...",
  "changePolicyHash": "0xd1bb7ad48d0a3e6b4f62528a1991704291537ed02dae8d039a4e818391a89b0b",
  "redeemEvent": {
    "redeemRequestHash": "0x...",
    "requester": "0x1111111111111111111111111111111111111111",
    "txHash": "0x...",
    "blockNumber": "10730000",
    "blockHash": "0x...",
    "logIndex": "12",
    "destinationScriptHash": "0x...",
    "destinationScriptPubKey": "0x0014...",
    "requestNonce": "0",
    "amountSats": "5000",
    "maxMinerFeeSats": "1000",
    "deadline": "1910000500"
  },
  "destinationAddress": "tb1q..."
}
```

The custody service must independently verify the burn event, destination script, chain/network IDs, policy limits, UTXO availability, fee budget, and replay state before producing a Bitcoin transaction.

## Response

Schema: [don-release-preparation-response.schema.json](../schemas/don-release-preparation-response.schema.json)

```json
{
  "kind": "DonReleasePreparationResponseV1",
  "schemaVersion": "1.0.0",
  "destinationAddress": "tb1q...",
  "spendPlan": {
    "kind": "NormalizedSpendPlanV1",
    "schemaVersion": "1.0.0",
    "btcNetwork": "3",
    "inputs": [
      {
        "btcTxId": "0x...",
        "vout": "0",
        "valueSats": "6000",
        "scriptTemplateId": "0x..."
      }
    ],
    "outputs": [
      {
        "scriptPubKeyHex": "0x0014...",
        "valueSats": "5000"
      },
      {
        "scriptPubKeyHex": "0x0014...",
        "valueSats": "500"
      }
    ],
    "feeSats": "500",
    "nVersion": "2",
    "nLockTime": "0",
    "sighashType": "1"
  },
  "bitcoinTxHex": "02000000...",
  "custodyReceipt": {
    "policyId": "chainlink-don-custody-v1",
    "signerSet": "chainlink-don"
  }
}
```

`custodyReceipt` is optional and informational. It can include DON-local evidence such as policy id, signer set identifier, workflow id, or custody job id. The app does not trust it for settlement safety.

## App-Side Verification

Before persisting the release as prepared, the public worker:

- validates the request and response JSON schemas,
- parses `bitcoinTxHex` as a Bitcoin transaction,
- checks transaction version and locktime against `spendPlan`,
- checks every transaction input txid/vout against `spendPlan.inputs`,
- checks every transaction output script/value against `spendPlan.outputs`,
- derives `ReleaseAuthorizationV1` commitments from that exact spend plan,
- later broadcasts only the same finalized `bitcoinTxHex` after EVM redeem completion.

If any check fails, the row remains unprepared and no Bitcoin transaction is broadcast.

## Non-Goals

This endpoint must not expose:

- raw signing,
- arbitrary PSBT signing,
- arbitrary transaction finalization,
- mutable app-owner policy overrides,
- replay reset through key rotation.

For production, replay state and UTXO reservation should be controlled by the DON custody system, not by the public app worker.
