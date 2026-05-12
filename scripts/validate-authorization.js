const fs = require("fs");
const { Command } = require("commander");
const {
  spendPlanCommitments,
  toBitcoinPsbt,
  toMintAuthorization,
  toReleaseAuthorization,
  verifyReleaseSpendPlan
} = require("./lib/authorization-validator");
const { mintStructHash, releaseStructHash } = require("./lib/bridge");
const {
  parseSignerAddresses,
  verifyReleaseAttestationEnvelope
} = require("./lib/attestation-ingest");
const {
  extractNormalizedSpendPlanFromPsbt,
  spendPlanDigest,
  unsignedPsbtDigest
} = require("./lib/bitcoin-psbt");

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function main() {
  const program = new Command();

  program
    .command("mint <authorization-json>")
    .description("validate a MintAuthorizationV1 artifact and print its contract struct hash")
    .action((authorizationPath) => {
      const authorization = toMintAuthorization(readJson(authorizationPath));
      console.log(JSON.stringify(
        {
          kind: "MintAuthorizationV1",
          structHash: mintStructHash(authorization)
        },
        null,
        2
      ));
    });

  program
    .command("release <authorization-json>")
    .description("validate a ReleaseAuthorizationV1 artifact and print its contract struct hash")
    .action((authorizationPath) => {
      const authorization = toReleaseAuthorization(readJson(authorizationPath));
      console.log(JSON.stringify(
        {
          kind: "ReleaseAuthorizationV1",
          structHash: releaseStructHash(authorization)
        },
        null,
        2
      ));
    });

  program
    .command("spend-plan <spend-plan-json>")
    .requiredOption("--change-policy-hash <bytes32>", "change policy hash used in psbtPolicyHash")
    .description("validate a NormalizedSpendPlanV1 artifact and print spend commitments")
    .action((spendPlanPath, options) => {
      const commitments = spendPlanCommitments(readJson(spendPlanPath), options.changePolicyHash);
      console.log(JSON.stringify(commitments, null, 2));
    });

  program
    .command("bitcoin-psbt <psbt-json>")
    .requiredOption("--bitcoin-network <name>", "bitcoinjs network name: mainnet, testnet, testnet4, signet, or regtest")
    .description("validate a BitcoinPsbtV1 artifact and print the derived NormalizedSpendPlanV1")
    .action((psbtPath, options) => {
      const artifact = toBitcoinPsbt(readJson(psbtPath));
      const spendPlan = extractNormalizedSpendPlanFromPsbt(
        {
          kind: "BitcoinPsbtV1",
          schemaVersion: "1.0.0",
          ...artifact
        },
        options.bitcoinNetwork
      );

      console.log(JSON.stringify(
        {
          kind: "BitcoinPsbtV1",
          spendPlan,
          spendPlanDigest: spendPlanDigest(spendPlan),
          unsignedPsbtDigest: unsignedPsbtDigest(
            {
              kind: "BitcoinPsbtV1",
              schemaVersion: "1.0.0",
              ...artifact
            },
            options.bitcoinNetwork
          )
        },
        null,
        2
      ));
    });

  program
    .command("release-spend-plan <authorization-json> <spend-plan-json>")
    .description("verify ReleaseAuthorizationV1 spend commitments against a NormalizedSpendPlanV1 artifact")
    .action((authorizationPath, spendPlanPath) => {
      const { authorization, commitments } = verifyReleaseSpendPlan(
        readJson(authorizationPath),
        readJson(spendPlanPath)
      );
      console.log(JSON.stringify(
        {
          kind: "ReleaseAuthorizationV1",
          structHash: releaseStructHash(authorization),
          commitments
        },
        null,
        2
      ));
    });

  program
    .command("release-attestation <authorization-json> <attestation-json>")
    .requiredOption("--signers <addresses>", "comma-separated configured DON signer addresses")
    .requiredOption("--threshold <number>", "DON attestation threshold")
    .option("--now <unix-seconds>", "override current unix timestamp for deterministic checks")
    .description("verify a ReleaseAttestationV1 artifact against a ReleaseAuthorizationV1 artifact")
    .action((authorizationPath, attestationPath, options) => {
      const verified = verifyReleaseAttestationEnvelope({
        authorization: readJson(authorizationPath),
        envelope: readJson(attestationPath),
        signerAddresses: parseSignerAddresses(options.signers),
        threshold: Number(options.threshold),
        now: options.now === undefined ? undefined : Number(options.now)
      });

      console.log(JSON.stringify(
        {
          kind: "ReleaseAttestationV1",
          signerSetDigest: verified.signerSetDigest,
          messageDigest: verified.messageDigest,
          signerCount: verified.signerCount
        },
        null,
        2
      ));
    });

  program.parse(process.argv);
}

main();
