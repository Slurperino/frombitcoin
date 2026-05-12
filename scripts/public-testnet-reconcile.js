const { Command } = require("commander");
const { Contract, JsonRpcProvider } = require("ethers");
const { loadArtifact } = require("./lib/artifacts");
const { PublicTestnetStore } = require("./lib/public-testnet-store");
const { loadPublicTestnetConfig } = require("./lib/public-testnet-config");
const { buildPublicTestnetReconciliationReport } = require("./lib/public-testnet-reconciliation");

async function readTotalSupply(config) {
  const provider = new JsonRpcProvider(config.evm.rpcUrl);
  const wrappedBitcoin = new Contract(config.evm.wrappedBitcoin, loadArtifact("WrappedBitcoin").abi, provider);
  return (await wrappedBitcoin.totalSupply()).toString();
}

async function main() {
  const program = new Command();
  program
    .requiredOption("--config <path>", "public testnet service JSON config")
    .option("--stale-seconds <seconds>", "warn about non-final redeems older than this", "3600")
    .option("--integrity-limit <count>", "max release rows to verify per run", "500")
    .option("--skip-total-supply", "skip onchain totalSupply comparison", false)
    .option("--fail-on-warning", "return non-zero when reconciliation warnings are present", false);
  program.parse(process.argv);
  const options = program.opts();

  const config = loadPublicTestnetConfig(options.config);
  const store = new PublicTestnetStore(config.database);
  try {
    const totalSupplySats = options.skipTotalSupply ? null : await readTotalSupply(config);
    const report = buildPublicTestnetReconciliationReport({
      config,
      store,
      totalSupplySats,
      staleSeconds: parsePositiveInteger(options.staleSeconds, "stale-seconds"),
      integrityLimit: parsePositiveInteger(options.integrityLimit, "integrity-limit")
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok || (options.failOnWarning && report.warnings.length > 0)) {
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parsePositiveInteger,
  readTotalSupply
};
