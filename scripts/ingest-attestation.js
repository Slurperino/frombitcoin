const fs = require("fs");
const { Command } = require("commander");
const { RedeemStore } = require("./lib/redeem-store");
const {
  ingestReleaseAttestation,
  parseSignerAddresses
} = require("./lib/attestation-ingest");

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

async function main() {
  const program = new Command();

  program
    .requiredOption("--db <path>", "SQLite database path")
    .requiredOption("--attestation <path>", "ReleaseAttestationV1 JSON artifact")
    .requiredOption("--signers <addresses>", "comma-separated configured DON signer addresses")
    .requiredOption("--threshold <number>", "DON attestation threshold")
    .option("--now <unix-seconds>", "override current unix timestamp for deterministic checks");

  program.parse(process.argv);
  const options = program.opts();

  const signerAddresses = parseSignerAddresses(options.signers);
  const threshold = Number(options.threshold);
  const now = options.now === undefined ? undefined : Number(options.now);
  const store = new RedeemStore(options.db);

  try {
    const result = ingestReleaseAttestation({
      store,
      envelope: readJson(options.attestation),
      signerAddresses,
      threshold,
      now
    });

    console.log(JSON.stringify(
      {
        ingested: true,
        result
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
