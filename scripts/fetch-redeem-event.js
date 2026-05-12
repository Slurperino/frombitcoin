const { Command } = require("commander");
const {
  createProvider,
  fetchRedeemEventByTxLog
} = require("./lib/redeem-event-source");

async function main() {
  const program = new Command();

  program
    .requiredOption("--rpc-url <url>", "EVM JSON-RPC URL for this observation source")
    .requiredOption("--burn-gateway <address>", "BurnGateway contract address")
    .requiredOption("--tx-hash <hash>", "transaction hash containing RedeemRequested")
    .requiredOption("--log-index <number>", "RedeemRequested log index in the transaction receipt")
    .option("--expected-redeem-request-hash <bytes32>", "optional expected redeemRequestHash guard")
    .option("--expected-block-hash <bytes32>", "optional expected block hash guard");

  program.parse(process.argv);
  const options = program.opts();
  const provider = createProvider(options.rpcUrl);
  const event = await fetchRedeemEventByTxLog({
    provider,
    burnGatewayAddress: options.burnGateway,
    txHash: options.txHash,
    logIndex: Number(options.logIndex),
    expectedRedeemRequestHash: options.expectedRedeemRequestHash,
    expectedBlockHash: options.expectedBlockHash
  });

  console.log(JSON.stringify(event, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
