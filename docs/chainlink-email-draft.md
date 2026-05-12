# Chainlink Email Draft

Hi,

Thank you for the response. The short version is that FromBitcoin is a BTC <-> EVM bridge prototype where we want the production trust model to reduce to Chainlink DON honesty.

Current architecture:

- Mint: a user creates a deposit intent on Sepolia, sends Signet BTC to a unique address, and the service builds a `MintAuthorization`. Chainlink verifies the Bitcoin deposit through independent data sources before the EVM `MintGateway` can mint bbBTC.
- Redeem: a user burns bbBTC on Sepolia with a destination Bitcoin script, amount, fee cap, and deadline. The service waits for EVM finality, prepares a normalized Bitcoin spend plan, asks Chainlink to verify the burn/release policy, and only then calls `completeRedeemWithAuthorization`.
- EVM lockdown: the deploy mode for the target model pins the token minter and deposit consumer to `MintGateway`, wires both gateways to the Chainlink verifier, and renounces ownership so the app owner cannot add minters, rotate signers, pause, change limits, or manually consume redeems after launch.

The specific area where we would like Chainlink guidance is BTC custody/signing. We do not want FromBitcoin infrastructure to hold a Bitcoin treasury signer in the production model. The target design is:

- the Chainlink DON controls the BTC custody/signing workflow,
- the app worker cannot locally fund PSBTs, sign, or finalize,
- the DON returns a normalized spend plan plus a finalized Bitcoin transaction for an exact redeem event,
- the app verifies that transaction byte-for-byte against the spend plan and only broadcasts it after the EVM redeem is consumed.

I have formalized the expected adapter interface here:

- `docs/don-custody-interface-v1.md`
- `schemas/don-release-preparation-request.schema.json`
- `schemas/don-release-preparation-response.schema.json`

The question for your technical/product team is whether this is a fit for CRE/custom DON, and what Chainlink-recommended pattern should be used for DON-controlled BTC custody/signing without exposing a raw signing endpoint.

We are currently evaluating as a developer/infrastructure team. Preferred connection is email first, then Telegram or a quick technical call if useful.

Best,
Fausto
