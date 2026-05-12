const { Command } = require("commander");
const { Contract, JsonRpcProvider, Wallet, encodeBytes32String, getAddress, isHexString } = require("ethers");
const { loadArtifact } = require("./lib/artifacts");

function parseUint(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return parsed;
}

function parseAddress(value, label) {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`invalid ${label}: ${value}`);
  }
}

function parseAddressList(value, label) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => parseAddress(entry, label));
}

function assertRequesterListsDoNotConflict(authorizeRequesters, revokeRequesters) {
  const revokeSet = new Set(revokeRequesters.map((requester) => requester.toLowerCase()));
  const conflict = authorizeRequesters.find((requester) => revokeSet.has(requester.toLowerCase()));
  if (conflict) {
    throw new Error(`requester cannot be both authorized and revoked: ${conflict}`);
  }
}

function parseBytes32OrText(value, label) {
  if (isHexString(value, 32)) {
    return value;
  }

  try {
    return encodeBytes32String(value);
  } catch {
    throw new Error(`invalid ${label}: expected bytes32 hex or <=31 byte text`);
  }
}

function optionOrEnv(optionValue, envNames, label) {
  if (optionValue) {
    return optionValue;
  }

  for (const envName of envNames) {
    if (process.env[envName]) {
      return process.env[envName];
    }
  }

  throw new Error(`${label} is required`);
}

async function main() {
  const program = new Command();
  program
    .option("--rpc-url <url>", "EVM JSON-RPC URL, defaults to SEPOLIA_RPC_URL or EVM_RPC_URL")
    .option("--private-key <hex>", "verifier owner private key, defaults to OWNER_PRIVATE_KEY")
    .option("--verifier <address>", "deployed ChainlinkFunctionsVerifier address, defaults to CHAINLINK_FUNCTIONS_VERIFIER")
    .option("--subscription-id <number>", "Chainlink Functions subscription id, defaults to CHAINLINK_FUNCTIONS_SUBSCRIPTION_ID")
    .option("--don-id <value>", "Chainlink Functions DON id as text or bytes32, defaults to CHAINLINK_FUNCTIONS_DON_ID_BYTES32 or CHAINLINK_FUNCTIONS_DON_ID")
    .option("--callback-gas-limit <number>", "Chainlink Functions callback gas limit, defaults to CHAINLINK_FUNCTIONS_CALLBACK_GAS_LIMIT")
    .option("--authorize-requesters <addresses>", "comma-separated requester addresses to authorize")
    .option("--revoke-requesters <addresses>", "comma-separated requester addresses to revoke")
    .option("--dry-run", "validate and print target configuration without sending transactions", false);

  program.parse(process.argv);
  const options = program.opts();

  const rpcUrl = optionOrEnv(options.rpcUrl, ["SEPOLIA_RPC_URL", "EVM_RPC_URL"], "--rpc-url");
  const privateKey = optionOrEnv(options.privateKey, ["OWNER_PRIVATE_KEY"], "--private-key");
  const verifierAddress = parseAddress(
    optionOrEnv(options.verifier, ["CHAINLINK_FUNCTIONS_VERIFIER"], "--verifier"),
    "verifier"
  );
  const subscriptionId = parseUint(
    optionOrEnv(options.subscriptionId, ["CHAINLINK_FUNCTIONS_SUBSCRIPTION_ID"], "--subscription-id"),
    "subscription-id"
  );
  const donId = parseBytes32OrText(
    optionOrEnv(options.donId, ["CHAINLINK_FUNCTIONS_DON_ID_BYTES32", "CHAINLINK_FUNCTIONS_DON_ID"], "--don-id"),
    "don-id"
  );
  const callbackGasLimit = parseUint(
    optionOrEnv(options.callbackGasLimit, ["CHAINLINK_FUNCTIONS_CALLBACK_GAS_LIMIT"], "--callback-gas-limit"),
    "callback-gas-limit"
  );
  const requestersToAuthorize = parseAddressList(options.authorizeRequesters, "authorized requester");
  const requestersToRevoke = parseAddressList(options.revokeRequesters, "revoked requester");
  assertRequesterListsDoNotConflict(requestersToAuthorize, requestersToRevoke);

  const target = {
    verifier: verifierAddress,
    subscriptionId,
    donId,
    callbackGasLimit,
    authorizeRequesters: requestersToAuthorize,
    revokeRequesters: requestersToRevoke
  };

  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, target }, null, 2));
    return;
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const owner = new Wallet(privateKey, provider);
  const artifact = loadArtifact("ChainlinkFunctionsVerifier");
  const verifier = new Contract(verifierAddress, artifact.abi, owner);

  const txs = [];
  const configTx = await verifier.setFunctionsConfig(subscriptionId, donId, callbackGasLimit);
  txs.push({ action: "setFunctionsConfig", hash: configTx.hash });
  await configTx.wait();

  for (const requester of requestersToAuthorize) {
    const tx = await verifier.setAuthorizedRequester(requester, true);
    txs.push({ action: "authorizeRequester", requester, hash: tx.hash });
    await tx.wait();
  }

  for (const requester of requestersToRevoke) {
    const tx = await verifier.setAuthorizedRequester(requester, false);
    txs.push({ action: "revokeRequester", requester, hash: tx.hash });
    await tx.wait();
  }

  const authorizedRequesters = {};
  for (const requester of [...requestersToAuthorize, ...requestersToRevoke]) {
    authorizedRequesters[requester] = await verifier.authorizedRequester(requester);
  }

  console.log(JSON.stringify({
    verifier: verifierAddress,
    subscriptionId: (await verifier.subscriptionId()).toString(),
    donId: await verifier.donId(),
    callbackGasLimit: (await verifier.callbackGasLimit()).toString(),
    authorizedRequesters,
    txs
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
