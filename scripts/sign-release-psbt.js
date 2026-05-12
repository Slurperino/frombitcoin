const fs = require("fs");
const { Command } = require("commander");
const { parseSignerAddresses } = require("./lib/attestation-ingest");
const { BtcSignerStore } = require("./lib/btc-signer-store");
const { signReleasePsbt } = require("./lib/btc-policy-signer");

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function readSecret(options, field, envField, name) {
  if (options[field]) {
    return options[field];
  }

  if (options[envField]) {
    const value = process.env[options[envField]];
    if (!value) {
      throw new Error(`${options[envField]} is not set`);
    }
    return value;
  }

  throw new Error(`${name} or ${name}-env must be provided`);
}

async function main() {
  const program = new Command();

  program
    .requiredOption("--db <path>", "BTC signer SQLite replay database path")
    .requiredOption("--authorization <path>", "ReleaseAuthorizationV1 JSON artifact")
    .requiredOption("--attestation <path>", "ReleaseAttestationV1 JSON artifact")
    .requiredOption("--psbt <path>", "BitcoinPsbtV1 JSON artifact")
    .requiredOption("--bitcoin-network <name>", "bitcoinjs network name: mainnet, testnet, testnet4, signet, or regtest")
    .requiredOption("--signers <addresses>", "comma-separated configured DON signer addresses")
    .requiredOption("--threshold <number>", "DON attestation threshold")
    .option("--wif <wif>", "local BTC signer WIF")
    .option("--wif-env <name>", "environment variable containing local BTC signer WIF")
    .option("--expected-bridge-domain <bytes32>", "local signer bridgeDomain guard")
    .option("--expected-btc-network <number>", "local signer btcNetwork guard")
    .option("--now <unix-seconds>", "override current unix timestamp for deterministic checks")
    .option("--dry-run", "verify policy and reserve redeemId without signing", false)
    .option("--no-finalize", "return a signed PSBT without finalizing/extracting the transaction");

  program.parse(process.argv);
  const options = program.opts();

  const store = new BtcSignerStore(options.db);

  try {
    const result = signReleasePsbt({
      store,
      authorization: readJson(options.authorization),
      attestation: readJson(options.attestation),
      psbtArtifact: readJson(options.psbt),
      bitcoinNetwork: options.bitcoinNetwork,
      signerAddresses: parseSignerAddresses(options.signers),
      threshold: Number(options.threshold),
      expectedBridgeDomain: options.expectedBridgeDomain,
      expectedBtcNetwork: options.expectedBtcNetwork,
      wif: options.dryRun ? undefined : readSecret(options, "wif", "wifEnv", "wif"),
      finalize: options.finalize,
      dryRun: Boolean(options.dryRun),
      now: options.now === undefined ? undefined : Number(options.now)
    });

    console.log(JSON.stringify(
      {
        status: result.status,
        redeemId: result.policy.contractAuthorization.redeemId,
        authorizationDigest: result.policy.authorizationDigest,
        spendPlanDigest: result.policy.spendPlanDigest,
        unsignedPsbtDigest: result.policy.unsignedPsbtDigest,
        decision: result.decision,
        signed: result.signed || null
      },
      null,
      2
    ));
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
