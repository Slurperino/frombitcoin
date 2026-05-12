const fs = require("fs");
const { Command } = require("commander");
const { parseSignerAddresses } = require("./lib/attestation-ingest");
const { verifyDonReleaseRequest } = require("./lib/don-release-verifier");

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function optionalJson(path) {
  return path ? readJson(path) : undefined;
}

function optionalNumber(value) {
  return value === undefined ? undefined : Number(value);
}

function main() {
  const program = new Command();

  program
    .requiredOption("--authorization <path>", "ReleaseAuthorizationV1 JSON candidate")
    .option("--redeem-event <path>", "Redeem event JSON observed by the DON node")
    .option("--secondary-redeem-event <path>", "same Redeem event observed through an independent secondary source")
    .option("--spend-plan <path>", "NormalizedSpendPlanV1 JSON expected by the authorization")
    .option("--psbt <path>", "BitcoinPsbtV1 JSON; derives and verifies the spend plan")
    .option("--bitcoin-network <name>", "bitcoinjs network name when --psbt is provided: mainnet, testnet, testnet4, signet, or regtest")
    .option("--expected-bridge-domain <bytes32>", "local bridgeDomain guard")
    .option("--expected-btc-network <number>", "local btcNetwork guard")
    .option("--expected-source-evm-chain-id <number>", "local source EVM chain id guard")
    .option("--signers <addresses>", "comma-separated configured DON signer addresses")
    .option("--threshold <number>", "DON attestation threshold")
    .option("--now <unix-seconds>", "override current unix timestamp")
    .option("--max-authorization-ttl-seconds <seconds>", "maximum authorization TTL allowed by local policy")
    .option("--max-clock-skew-seconds <seconds>", "future attestation timestamp tolerance", "60")
    .option("--min-time-to-deadline-seconds <seconds>", "minimum time left before deadline", "0")
    .option("--require-secondary-redeem-event", "require an independent secondary redeem event observation (default)", false)
    .option("--allow-missing-secondary-redeem-event", "allow verification without an independent secondary redeem event observation", false)
    .option("--allow-authorization-only", "allow checks without a spend plan or PSBT", false);

  program.parse(process.argv);
  const options = program.opts();

  if ((options.signers && !options.threshold) || (!options.signers && options.threshold)) {
    throw new Error("--signers and --threshold must be provided together");
  }

  if (options.requireSecondaryRedeemEvent && options.allowMissingSecondaryRedeemEvent) {
    throw new Error("--require-secondary-redeem-event and --allow-missing-secondary-redeem-event cannot be used together");
  }

  const result = verifyDonReleaseRequest({
    authorization: readJson(options.authorization),
    redeemEvent: optionalJson(options.redeemEvent),
    secondaryRedeemEvent: optionalJson(options.secondaryRedeemEvent),
    spendPlan: optionalJson(options.spendPlan),
    psbtArtifact: optionalJson(options.psbt),
    bitcoinNetwork: options.bitcoinNetwork,
    expectedBridgeDomain: options.expectedBridgeDomain,
    expectedBtcNetwork: options.expectedBtcNetwork,
    expectedSourceEvmChainId: options.expectedSourceEvmChainId,
    signerAddresses: options.signers ? parseSignerAddresses(options.signers) : undefined,
    threshold: optionalNumber(options.threshold),
    now: optionalNumber(options.now),
    maxAuthorizationTtlSeconds: optionalNumber(options.maxAuthorizationTtlSeconds),
    maxClockSkewSeconds: optionalNumber(options.maxClockSkewSeconds),
    minTimeToDeadlineSeconds: optionalNumber(options.minTimeToDeadlineSeconds),
    requireSecondaryRedeemEvent: !options.allowMissingSecondaryRedeemEvent,
    requireSpendPlan: !options.allowAuthorizationOnly
  });

  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
