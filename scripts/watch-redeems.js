const fs = require("fs");
const { Command } = require("commander");
const { RedeemStore } = require("./lib/redeem-store");
const {
  authorizeFinalizedRedeems,
  createBurnGateway,
  createProvider,
  scanRedeemRequests
} = require("./lib/evm-redeem-watcher");

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

async function main() {
  const program = new Command();

  program
    .requiredOption("--rpc-url <url>", "JSON-RPC URL")
    .requiredOption("--burn-gateway <address>", "BurnGateway contract address")
    .requiredOption("--db <path>", "SQLite database path")
    .requiredOption("--from-block <number>", "first block to scan")
    .option("--to-block <number>", "last block to scan; defaults to latest")
    .option("--finality-blocks <number>", "EVM finality depth", "12")
    .option("--spend-plan <path>", "NormalizedSpendPlanV1 JSON used to build release authorizations")
    .option("--change-policy-hash <bytes32>", "change policy hash for spend-plan authorization")
    .option("--authorization-ttl-seconds <number>", "release authorization TTL", "1200");

  program.parse(process.argv);
  const options = program.opts();

  const provider = createProvider(options.rpcUrl);
  const burnGateway = createBurnGateway(provider, options.burnGateway);
  const store = new RedeemStore(options.db);

  try {
    const latestBlock = await provider.getBlockNumber();
    const fromBlock = Number(options.fromBlock);
    const toBlock = options.toBlock === undefined ? latestBlock : Number(options.toBlock);
    const finalityBlocks = Number(options.finalityBlocks);

    const events = await scanRedeemRequests({
      burnGateway,
      store,
      fromBlock,
      toBlock
    });

    let authorizations = [];
    if (options.spendPlan || options.changePolicyHash) {
      if (!options.spendPlan || !options.changePolicyHash) {
        throw new Error("--spend-plan and --change-policy-hash must be provided together");
      }

      authorizations = await authorizeFinalizedRedeems({
        provider,
        burnGateway,
        store,
        finalityBlocks,
        spendPlan: readJson(options.spendPlan),
        changePolicyHash: options.changePolicyHash,
        ttlSeconds: Number(options.authorizationTtlSeconds)
      });
    }

    console.log(JSON.stringify(
      {
        scanned: events.length,
        authorized: authorizations.length,
        latestBlock,
        fromBlock,
        toBlock,
        finalityBlocks,
        authorizations
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
