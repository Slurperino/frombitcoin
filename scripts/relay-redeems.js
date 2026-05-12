const { Command } = require("commander");
const { Wallet } = require("ethers");
const { RedeemStore } = require("./lib/redeem-store");
const { createBurnGateway, createProvider } = require("./lib/evm-redeem-watcher");
const { relayAttestedRedeems } = require("./lib/release-relayer");

async function main() {
  const program = new Command();

  program
    .requiredOption("--rpc-url <url>", "JSON-RPC URL")
    .requiredOption("--burn-gateway <address>", "BurnGateway contract address")
    .requiredOption("--db <path>", "SQLite database path")
    .requiredOption("--private-key <hex>", "relayer private key")
    .option("--limit <number>", "max attested redeems to relay", "100");

  program.parse(process.argv);
  const options = program.opts();

  const provider = createProvider(options.rpcUrl);
  const relayer = new Wallet(options.privateKey, provider);
  const burnGateway = createBurnGateway(provider, options.burnGateway).connect(relayer);
  const store = new RedeemStore(options.db);

  try {
    const results = await relayAttestedRedeems({
      burnGateway,
      store,
      limit: Number(options.limit)
    });

    console.log(JSON.stringify(
      {
        relayed: results.length,
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
