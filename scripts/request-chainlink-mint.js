const fs = require("fs");
const path = require("path");
const { Command } = require("commander");
const { AbiCoder, Contract, JsonRpcProvider, Wallet } = require("ethers");
const { loadArtifact } = require("./lib/artifacts");
const { ROOT } = require("./lib/paths");
const { buildFunctionsRequestCBOR } = require("./lib/chainlink-functions-request");
const { toMintAuthorization } = require("./lib/authorization-validator");
const { mintStructHash } = require("./lib/bridge");

const abiCoder = AbiCoder.defaultAbiCoder();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function stringifyForFunctions(value) {
  return JSON.stringify(value);
}

async function main() {
  const program = new Command();
  program
    .requiredOption("--rpc-url <url>", "EVM JSON-RPC URL")
    .requiredOption("--private-key <hex>", "authorized requester private key")
    .requiredOption("--verifier <address>", "deployed ChainlinkFunctionsVerifier address")
    .requiredOption("--primary-bitcoin-api <url>", "primary Esplora-compatible Bitcoin API base URL")
    .requiredOption("--secondary-bitcoin-api <url>", "secondary Esplora-compatible Bitcoin API base URL")
    .requiredOption("--deposit-address <address>", "canonical Bitcoin deposit address expected in the observed UTXO")
    .requiredOption("--authorization <file>", "MintAuthorization JSON file")
    .option("--source <file>", "Chainlink Functions JavaScript source", path.join(ROOT, "chainlink/functions/mint-authorization.js"))
    .option("--min-confirmations <number>", "minimum BTC confirmations checked by the Functions source", "6")
    .option("--dry-run", "print request data without sending a transaction", false);

  program.parse(process.argv);
  const options = program.opts();

  const authorization = readJson(options.authorization);
  const source = fs.readFileSync(options.source, "utf8");
  const contractAuthorization = toMintAuthorization(authorization);
  const structHash = mintStructHash(contractAuthorization);
  const requestData = buildFunctionsRequestCBOR({
    source,
    args: [
      options.primaryBitcoinApi,
      options.secondaryBitcoinApi,
      String(options.minConfirmations),
      stringifyForFunctions(authorization),
      options.depositAddress,
      structHash
    ]
  });

  if (options.dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      verifier: options.verifier,
      depositAddress: options.depositAddress,
      mintStructHash: structHash,
      requestData
    }, null, 2));
    return;
  }

  const provider = new JsonRpcProvider(options.rpcUrl);
  const signer = new Wallet(options.privateKey, provider);
  const artifact = loadArtifact("ChainlinkFunctionsVerifier");
  const verifier = new Contract(options.verifier, artifact.abi, signer);
  const tx = await verifier.requestMintAuthorization(requestData, contractAuthorization);
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
    mintStructHash: structHash,
    chainlinkAttestation: requestId ? abiCoder.encode(["bytes32"], [requestId]) : null
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
