const fs = require("fs");
const { Command } = require("commander");
const { BitcoinCoreRpc, readRpcOptions } = require("./lib/bitcoin-core-rpc");
const { broadcastRawTransaction } = require("./lib/bitcoin-core-psbt");

function readTxHex(options) {
  if (options.txHex) {
    return options.txHex;
  }

  if (options.txHexFile) {
    return fs.readFileSync(options.txHexFile, "utf8").trim();
  }

  throw new Error("--tx-hex or --tx-hex-file is required");
}

async function main() {
  const program = new Command();

  program
    .requiredOption("--rpc-url <url>", "Bitcoin Core RPC URL, e.g. http://127.0.0.1:18443")
    .option("--rpc-user <user>", "Bitcoin Core RPC username")
    .option("--rpc-password <password>", "Bitcoin Core RPC password")
    .option("--rpc-cookie <path>", "Bitcoin Core .cookie path")
    .option("--wallet <name>", "Bitcoin Core wallet name")
    .option("--tx-hex <hex>", "signed raw transaction hex")
    .option("--tx-hex-file <path>", "file containing signed raw transaction hex")
    .option("--max-fee-rate <number>", "Bitcoin Core sendrawtransaction maxfeerate");

  program.parse(process.argv);
  const options = program.opts();
  const rpc = new BitcoinCoreRpc(readRpcOptions(options));
  const result = await broadcastRawTransaction({
    rpc,
    txHex: readTxHex(options),
    maxFeeRate: options.maxFeeRate
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
