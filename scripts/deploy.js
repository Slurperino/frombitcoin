const { Command } = require("commander");
const { JsonRpcProvider, Wallet, encodeBytes32String, getAddress, isHexString, keccak256, toUtf8Bytes } = require("ethers");
const { loadArtifacts } = require("./lib/artifacts");
const { deployContract } = require("./lib/bridge");

function parseUint(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
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

function parseSignerAddresses(value) {
  if (!value) {
    return [];
  }

  const addresses = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => parseAddress(entry, "signer address"))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  for (let i = 1; i < addresses.length; ++i) {
    if (addresses[i - 1].toLowerCase() === addresses[i].toLowerCase()) {
      throw new Error(`duplicate signer address: ${addresses[i]}`);
    }
  }

  return addresses;
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

function parseDeploymentEnvironment(value) {
  const allowed = new Set(["local", "testnet", "staging", "mainnet"]);
  if (!allowed.has(value)) {
    throw new Error(`invalid deployment environment: ${value}`);
  }
  return value;
}

function parseBridgeLabel(value) {
  if (!/^[a-zA-Z0-9._:-]+$/.test(value)) {
    throw new Error(`invalid bridge label: ${value}`);
  }
  return value;
}

function parseAttestationMode(value) {
  const allowed = new Set(["ecdsa", "chainlink-functions"]);
  if (!allowed.has(value)) {
    throw new Error(`invalid attestation mode: ${value}`);
  }
  return value;
}

function parseBtcCustodyController(value) {
  const allowed = new Set(["local-wallet", "chainlink-don"]);
  if (!allowed.has(value)) {
    throw new Error(`invalid BTC custody controller: ${value}`);
  }
  return value;
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

function validateLimit(label, limitSats, windowSeconds) {
  if ((limitSats === 0 && windowSeconds !== 0) || (limitSats !== 0 && windowSeconds === 0)) {
    throw new Error(`${label} limit and window must both be zero or both be non-zero`);
  }
}

async function main() {
  const program = new Command();

  program
    .requiredOption("--rpc-url <url>", "JSON-RPC URL")
    .requiredOption("--private-key <hex>", "deployer private key")
    .requiredOption("--expected-chain-id <number>", "expected EVM chain id for the RPC endpoint")
    .requiredOption("--deployment-environment <name>", "environment label, e.g. local, testnet, staging, mainnet")
    .requiredOption("--owner <address>", "owner address for managed contracts")
    .option("--attestation-mode <mode>", "authorization verifier mode: ecdsa or chainlink-functions", "ecdsa")
    .option("--signers <addresses>", "comma-separated DON signer addresses for ecdsa mode")
    .requiredOption("--btc-network <number>", "configured BTC network id")
    .requiredOption("--bridge-label <value>", "deployment-specific label included in the bridge domain")
    .option("--threshold <number>", "DON threshold", "2")
    .option("--min-confirmations <number>", "minimum BTC confirmations", "6")
    .option("--name <value>", "wrapped token name", "BitcoinBride Wrapped BTC")
    .option("--symbol <value>", "wrapped token symbol", "bbBTC")
    .option("--decimals <number>", "wrapped token decimals", "8")
    .option("--mint-limit-sats <number>", "mint limit per window; 0 disables", "0")
    .option("--mint-limit-window-seconds <number>", "mint limit window; 0 disables", "0")
    .option("--redeem-limit-sats <number>", "redeem limit per window; 0 disables", "0")
    .option("--redeem-limit-window-seconds <number>", "redeem limit window; 0 disables", "0")
    .option("--compile", "compile contracts before deployment instead of loading existing build artifacts")
    .option("--dry-run", "validate configuration and print the deployment plan without sending transactions")
    .option("--configure", "run owner-only post-deploy wiring")
    .option("--chainlink-only-risk", "lock EVM privileges and renounce ownership after configure; requires ECDSA Chainlink quorum")
    .option("--btc-custody-controller <controller>", "BTC custody controller: local-wallet or chainlink-don", "local-wallet")
    .option("--owner-private-key <hex>", "owner private key for --configure when owner is not deployer")
    .option("--functions-router <address>", "Chainlink Functions router address for chainlink-functions mode")
    .option("--functions-subscription-id <number>", "Chainlink Functions subscription id for chainlink-functions mode")
    .option("--functions-don-id <value>", "Chainlink Functions DON id as text or bytes32 for chainlink-functions mode")
    .option("--functions-callback-gas-limit <number>", "Chainlink Functions callback gas limit", "300000")
    .option("--authorized-requesters <addresses>", "comma-separated addresses allowed to request Chainlink authorizations");

  program.parse(process.argv);
  const options = program.opts();

  const threshold = parseUint(options.threshold, "threshold");
  const expectedChainId = parseUint(options.expectedChainId, "expected-chain-id");
  const deploymentEnvironment = parseDeploymentEnvironment(options.deploymentEnvironment);
  const attestationMode = parseAttestationMode(options.attestationMode);
  const btcCustodyController = parseBtcCustodyController(options.btcCustodyController);
  const bridgeLabel = parseBridgeLabel(options.bridgeLabel);
  const ownerAddress = parseAddress(options.owner, "owner");
  const btcNetwork = parseUint(options.btcNetwork, "btc-network");
  const minConfirmations = parseUint(options.minConfirmations, "min-confirmations");
  const decimals = parseUint(options.decimals, "decimals");
  const mintLimitSats = parseUint(options.mintLimitSats, "mint-limit-sats");
  const mintLimitWindowSeconds = parseUint(options.mintLimitWindowSeconds, "mint-limit-window-seconds");
  const redeemLimitSats = parseUint(options.redeemLimitSats, "redeem-limit-sats");
  const redeemLimitWindowSeconds = parseUint(options.redeemLimitWindowSeconds, "redeem-limit-window-seconds");
  const chainlinkOnlyRisk = Boolean(options.chainlinkOnlyRisk);

  validateLimit("mint", mintLimitSats, mintLimitWindowSeconds);
  validateLimit("redeem", redeemLimitSats, redeemLimitWindowSeconds);

  const signerAddresses = parseSignerAddresses(options.signers);
  const functionsCallbackGasLimit = parseUint(options.functionsCallbackGasLimit, "functions-callback-gas-limit");
  const functionsSubscriptionId = options.functionsSubscriptionId
    ? parseUint(options.functionsSubscriptionId, "functions-subscription-id")
    : 0;
  const functionsDonId = options.functionsDonId
    ? parseBytes32OrText(options.functionsDonId, "functions-don-id")
    : null;
  const functionsRouter = options.functionsRouter
    ? parseAddress(options.functionsRouter, "functions-router")
    : null;
  const authorizedRequesters = parseAddressList(options.authorizedRequesters, "authorized requester");

  if (attestationMode === "ecdsa") {
    if (signerAddresses.length === 0) {
      throw new Error("at least one signer address is required");
    }

    if (threshold === 0 || threshold > signerAddresses.length) {
      throw new Error("threshold must be between 1 and signer count");
    }
  } else if (attestationMode === "chainlink-functions") {
    if (!functionsRouter || functionsSubscriptionId === 0 || !functionsDonId || functionsCallbackGasLimit === 0) {
      throw new Error("chainlink-functions mode requires --functions-router, --functions-subscription-id, --functions-don-id, and --functions-callback-gas-limit");
    }
  }

  if (minConfirmations === 0) {
    throw new Error("min-confirmations must be greater than zero");
  }

  if (deploymentEnvironment === "mainnet") {
    if (attestationMode === "ecdsa" && threshold * 2 <= signerAddresses.length) {
      throw new Error("mainnet threshold must be a strict signer majority");
    }

    if (mintLimitSats === 0 || redeemLimitSats === 0) {
      throw new Error("mainnet deployments require non-zero mint and redeem limits");
    }
  }

  if (chainlinkOnlyRisk) {
    if (attestationMode !== "ecdsa") {
      throw new Error("--chainlink-only-risk requires --attestation-mode ecdsa with Chainlink DON signer addresses");
    }
    if (!options.configure) {
      throw new Error("--chainlink-only-risk requires --configure so minter and consumer permissions can be locked before ownership is renounced");
    }
    if (signerAddresses.length < 3) {
      throw new Error("--chainlink-only-risk requires at least three Chainlink DON signer addresses");
    }
    if (threshold * 2 <= signerAddresses.length) {
      throw new Error("--chainlink-only-risk requires a strict signer majority threshold");
    }
    if (btcCustodyController !== "chainlink-don") {
      throw new Error("--chainlink-only-risk requires --btc-custody-controller chainlink-don");
    }
  }

  const artifactNames = [
    attestationMode === "ecdsa" ? "AttestationVerifier" : "ChainlinkFunctionsVerifier",
    "BurnGateway",
    "DepositRegistry",
    "MintGateway",
    "WrappedBitcoin"
  ];
  const artifacts = options.compile
    ? (() => {
        const { compileContracts, writeArtifacts } = require("./lib/compile");
        const compiledArtifacts = compileContracts();
        writeArtifacts(compiledArtifacts);
        return compiledArtifacts;
      })()
    : loadArtifacts(artifactNames);

  const provider = new JsonRpcProvider(options.rpcUrl);
  const deployer = new Wallet(options.privateKey, provider);
  const ownerSigner = options.ownerPrivateKey ? new Wallet(options.ownerPrivateKey, provider) : deployer;
  const network = await provider.getNetwork();
  const actualChainId = Number(network.chainId);
  if (actualChainId !== expectedChainId) {
    throw new Error(`RPC chain id mismatch: expected ${expectedChainId}, got ${actualChainId}`);
  }

  if (deploymentEnvironment === "mainnet" && deployer.address.toLowerCase() === ownerAddress.toLowerCase()) {
    throw new Error("mainnet owner must not be the deployer hot key");
  }

  if (deploymentEnvironment === "mainnet") {
    const ownerCode = await provider.getCode(ownerAddress);
    if (ownerCode === "0x") {
      throw new Error("mainnet owner must be a deployed contract such as a multisig or timelock");
    }
  }

  const bridgeDomainPreimage = [
    "BitcoinBride",
    deploymentEnvironment,
    `evm:${actualChainId}`,
    `btc:${btcNetwork}`,
    bridgeLabel
  ].join(":");
  const bridgeDomain = keccak256(toUtf8Bytes(bridgeDomainPreimage));

  if (options.dryRun) {
    console.log(JSON.stringify(
      {
        dryRun: true,
        bridgeDomain,
        bridgeDomainPreimage,
        deploymentEnvironment,
        evmChainId: actualChainId,
        btcNetwork,
        owner: ownerAddress,
        deployer: deployer.address,
        attestationMode,
        chainlinkOnlyRisk,
        btcCustodyController,
        signerAddresses,
        threshold,
        chainlinkFunctions: attestationMode === "chainlink-functions"
          ? {
              router: functionsRouter,
              subscriptionId: functionsSubscriptionId,
              donId: functionsDonId,
              callbackGasLimit: functionsCallbackGasLimit,
              authorizedRequesters
            }
          : null,
        limits: {
          mint: {
            sats: mintLimitSats,
            windowSeconds: mintLimitWindowSeconds
          },
          redeem: {
            sats: redeemLimitSats,
            windowSeconds: redeemLimitWindowSeconds
          }
        },
        artifacts: Object.keys(artifacts)
      },
      null,
      2
    ));
    return;
  }

  const wrappedBitcoin = await deployContract(artifacts.WrappedBitcoin, deployer, [
    ownerAddress,
    options.name,
    options.symbol,
    decimals
  ]);

  const attestationVerifier = attestationMode === "ecdsa"
    ? await deployContract(artifacts.AttestationVerifier, deployer, [
        bridgeDomain,
        ownerAddress,
        signerAddresses,
        threshold
      ])
    : await deployContract(artifacts.ChainlinkFunctionsVerifier, deployer, [
        bridgeDomain,
        ownerAddress,
        functionsRouter,
        functionsSubscriptionId,
        functionsDonId,
        functionsCallbackGasLimit,
        authorizedRequesters
      ]);

  const depositRegistry = await deployContract(artifacts.DepositRegistry, deployer, [
    bridgeDomain,
    ownerAddress
  ]);

  const mintGateway = await deployContract(artifacts.MintGateway, deployer, [
    ownerAddress,
    await depositRegistry.getAddress(),
    await attestationVerifier.getAddress(),
    await wrappedBitcoin.getAddress(),
    btcNetwork,
    minConfirmations,
    mintLimitSats,
    mintLimitWindowSeconds
  ]);

  const burnGateway = await deployContract(artifacts.BurnGateway, deployer, [
    ownerAddress,
    await wrappedBitcoin.getAddress(),
    await attestationVerifier.getAddress(),
    bridgeDomain,
    btcNetwork,
    actualChainId,
    redeemLimitSats,
    redeemLimitWindowSeconds
  ]);

  let configured = false;
  let lockedDown = false;
  let ownershipRenounced = false;
  const mintGatewayAddress = await mintGateway.getAddress();
  if (options.configure) {
    const ownerSignerAddress = await ownerSigner.getAddress();
    if (ownerSignerAddress.toLowerCase() !== ownerAddress.toLowerCase()) {
      throw new Error("--configure requires a signer matching --owner; pass --owner-private-key if deployer is not owner");
    }

    await (await wrappedBitcoin.connect(ownerSigner).setMinter(mintGatewayAddress, true)).wait();
    await (await depositRegistry.connect(ownerSigner).setAuthorizedConsumer(mintGatewayAddress, true)).wait();
    configured = true;
  }

  if (chainlinkOnlyRisk) {
    await (await wrappedBitcoin.connect(ownerSigner).lockMinter(mintGatewayAddress)).wait();
    await (await depositRegistry.connect(ownerSigner).lockAuthorizedConsumer(mintGatewayAddress)).wait();
    lockedDown = true;

    for (const contract of [wrappedBitcoin, attestationVerifier, depositRegistry, mintGateway, burnGateway]) {
      await (await contract.connect(ownerSigner).renounceOwnership()).wait();
    }
    ownershipRenounced = true;
  }

  console.log(JSON.stringify(
    {
      bridgeDomain,
      bridgeDomainPreimage,
      deploymentEnvironment,
      evmChainId: actualChainId,
      btcNetwork,
      owner: ownerAddress,
      deployer: deployer.address,
      attestationMode,
      chainlinkOnlyRisk,
      btcCustodyController,
      signerAddresses,
      threshold,
      chainlinkFunctions: attestationMode === "chainlink-functions"
        ? {
            router: functionsRouter,
            subscriptionId: functionsSubscriptionId,
            donId: functionsDonId,
            callbackGasLimit: functionsCallbackGasLimit,
            authorizedRequesters
          }
        : null,
      limits: {
        mint: {
          sats: mintLimitSats,
          windowSeconds: mintLimitWindowSeconds
        },
        redeem: {
          sats: redeemLimitSats,
          windowSeconds: redeemLimitWindowSeconds
        }
      },
      contracts: {
        WrappedBitcoin: await wrappedBitcoin.getAddress(),
        [attestationMode === "ecdsa" ? "AttestationVerifier" : "ChainlinkFunctionsVerifier"]:
          await attestationVerifier.getAddress(),
        DepositRegistry: await depositRegistry.getAddress(),
        MintGateway: mintGatewayAddress,
        BurnGateway: await burnGateway.getAddress()
      },
      configured,
      lockedDown,
      ownershipRenounced,
      postDeploy: configured
        ? []
        : [
            `call WrappedBitcoin.setMinter(${mintGatewayAddress}, true) from owner`,
            `call DepositRegistry.setAuthorizedConsumer(${mintGatewayAddress}, true) from owner`
          ]
    },
    null,
    2
  ));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
