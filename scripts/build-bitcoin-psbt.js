const { Command } = require("commander");
const { BitcoinCoreRpc, readRpcOptions } = require("./lib/bitcoin-core-rpc");
const { buildWalletFundedPsbt } = require("./lib/bitcoin-core-psbt");

async function main() {
  const program = new Command();

  program
    .requiredOption("--rpc-url <url>", "Bitcoin Core RPC URL, e.g. http://127.0.0.1:18443")
    .option("--rpc-user <user>", "Bitcoin Core RPC username")
    .option("--rpc-password <password>", "Bitcoin Core RPC password")
    .option("--rpc-cookie <path>", "Bitcoin Core .cookie path")
    .option("--wallet <name>", "Bitcoin Core wallet name")
    .requiredOption("--btc-network <number>", "bridge btcNetwork id")
    .requiredOption("--bitcoin-network <name>", "bitcoinjs network name: mainnet, testnet, testnet4, signet, or regtest")
    .requiredOption("--destination-address <address>", "BTC destination address")
    .requiredOption("--amount-sats <sats>", "destination amount in sats")
    .option("--locktime <number>", "PSBT locktime", "0")
    .option("--fee-rate-btc-kvb <number>", "Bitcoin Core fee_rate option in BTC/kvB")
    .option("--change-address <address>", "Bitcoin Core changeAddress option")
    .option("--min-conf <number>", "Bitcoin Core minconf option")
    .option("--replaceable", "Bitcoin Core replaceable option", false);

  program.parse(process.argv);
  const options = program.opts();
  const rpc = new BitcoinCoreRpc(readRpcOptions(options));

  const result = await buildWalletFundedPsbt({
    rpc,
    btcNetwork: options.btcNetwork,
    bitcoinNetwork: options.bitcoinNetwork,
    destinationAddress: options.destinationAddress,
    amountSats: options.amountSats,
    locktime: options.locktime,
    feeRateBtcKvB: options.feeRateBtcKvb,
    changeAddress: options.changeAddress,
    minConf: options.minConf,
    replaceable: options.replaceable
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
