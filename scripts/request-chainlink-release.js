const fs = require("fs");
const path = require("path");
const { Command } = require("commander");
const { AbiCoder, Contract, JsonRpcProvider, Wallet } = require("ethers");
const { loadArtifact } = require("./lib/artifacts");
const { ROOT } = require("./lib/paths");
const { buildFunctionsRequestCBOR } = require("./lib/chainlink-functions-request");
const { normalizedReleaseAuthorizationForContract } = require("./lib/evm-redeem-watcher");
const { releaseStructHash } = require("./lib/bridge");

const abiCoder = AbiCoder.defaultAbiCoder();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function stringifyForFunctions(value) {
  return JSON.stringify(value);
}

function parsePositiveSafeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return parsed;
}

async function main() {
  const program = new Command();
  program
    .requiredOption("--rpc-url <url>", "EVM JSON-RPC URL")
    .requiredOption("--private-key <hex>", "authorized requester private key")
    .requiredOption("--verifier <address>", "deployed ChainlinkFunctionsVerifier address")
    .requiredOption("--adapter-url <url>", "public DON release adapter URL")
    .requiredOption("--primary-rpc-url <url>", "primary EVM RPC URL for Chainlink Functions nodes")
    .requiredOption("--secondary-rpc-url <url>", "secondary EVM RPC URL for Chainlink Functions nodes")
    .requiredOption("--burn-gateway <address>", "BurnGateway address")
    .requiredOption("--authorization <file>", "ReleaseAuthorization JSON file")
    .requiredOption("--spend-plan <file>", "NormalizedSpendPlan JSON file")
    .option("--source <file>", "Chainlink Functions JavaScript source", path.join(ROOT, "chainlink/functions/release-authorization.js"))
    .option("--finality-blocks <number>", "minimum EVM finality blocks checked by the Functions source", "64")
    .option("--dry-run", "print request data without sending a transaction", false);

  program.parse(process.argv);
  const options = program.opts();
  const finalityBlocks = parsePositiveSafeInteger(options.finalityBlocks, "--finality-blocks");

  const authorization = readJson(options.authorization);
  const spendPlan = readJson(options.spendPlan);
  const source = fs.readFileSync(options.source, "utf8");
  const contractAuthorization = normalizedReleaseAuthorizationForContract(authorization);
  const structHash = releaseStructHash(contractAuthorization);
  const requestData = buildFunctionsRequestCBOR({
    source,
    args: [
      options.adapterUrl,
      options.primaryRpcUrl,
      options.secondaryRpcUrl,
      options.burnGateway,
      String(finalityBlocks),
      stringifyForFunctions(authorization),
      stringifyForFunctions(spendPlan),
      structHash
    ]
  });

  if (options.dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      verifier: options.verifier,
      burnGateway: options.burnGateway,
      releaseStructHash: structHash,
      requestData
    }, null, 2));
    return;
  }

  const provider = new JsonRpcProvider(options.rpcUrl);
  const signer = new Wallet(options.privateKey, provider);
  const artifact = loadArtifact("ChainlinkFunctionsVerifier");
  const verifier = new Contract(options.verifier, artifact.abi, signer);
  const tx = await verifier.requestReleaseAuthorization(requestData, contractAuthorization);
  const receipt = await tx.wait();

  let requestId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = verifier.interface.parseLog(log);
      if (parsed && parsed.name === "ChainlinkAuthorizationRequested") {
        requestId = parsed.args.requestId;
        break;
      }
    } catch {
      // Ignore logs from the Functions router.
    }
  }

  console.log(JSON.stringify({
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    verifier: options.verifier,
    requestId,
    releaseStructHash: structHash,
    chainlinkAttestation: requestId ? abiCoder.encode(["bytes32"], [requestId]) : null
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
