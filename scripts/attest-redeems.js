const { Command } = require("commander");
const { RedeemStore } = require("./lib/redeem-store");
const {
  attestAuthorizedRedeems,
  parsePrivateKeys,
  walletsFromPrivateKeys
} = require("./lib/attestation-provider");

async function main() {
  const program = new Command();

  program
    .requiredOption("--db <path>", "SQLite database path")
    .requiredOption("--don-private-keys <hexes>", "comma-separated DON signer private keys for local/test deployments")
    .requiredOption("--threshold <number>", "DON attestation threshold")
    .option("--limit <number>", "max authorized redeems to attest", "100");

  program.parse(process.argv);
  const options = program.opts();

  const threshold = Number(options.threshold);
  const signerWallets = walletsFromPrivateKeys(parsePrivateKeys(options.donPrivateKeys));
  const store = new RedeemStore(options.db);

  try {
    const results = await attestAuthorizedRedeems({
      store,
      signerWallets,
      threshold,
      limit: Number(options.limit)
    });

    console.log(JSON.stringify(
      {
        attested: results.length,
        results
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
