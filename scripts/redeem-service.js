const { Command } = require("commander");
const { Wallet } = require("ethers");
const { RedeemStore } = require("./lib/redeem-store");
const {
  authorizeFinalizedRedeems,
  createBurnGateway,
  createProvider,
  scanRedeemRequests
} = require("./lib/evm-redeem-watcher");
const {
  attestAuthorizedRedeems,
  parsePrivateKeys,
  walletsFromPrivateKeys
} = require("./lib/attestation-provider");
const { relayAttestedRedeems } = require("./lib/release-relayer");
const {
  createLogger,
  createServiceState,
  loadRedeemServiceConfig,
  readJson,
  resolveSecret,
  sleep,
  startHealthServer,
  unixNow
} = require("./lib/service-runtime");

async function main() {
  const program = new Command();

  program
    .requiredOption("--config <path>", "redeem service JSON config")
    .option("--role <role>", "role to run: watcher, attester, relayer, or all", "all")
    .option("--once", "run one cycle and exit", false);

  program.parse(process.argv);
  const options = program.opts();

  const config = loadRedeemServiceConfig(options.config);
  const roles = selectedRoles(config, options.role);
  if (roles.length === 0) {
    throw new Error(`no enabled roles selected by --role ${options.role}`);
  }

  const logger = createLogger({ service: config.serviceName });
  const store = new RedeemStore(config.database);
  const state = createServiceState({ serviceName: config.serviceName, roles });
  const resources = createRoleResources({ config, roles });
  let healthServer = null;

  if (!options.once && config.health.enabled) {
    healthServer = startHealthServer({
      host: config.health.host,
      port: config.health.port,
      state,
      store,
      logger
    });
  }

  const stop = () => {
    state.stopping = true;
    logger.info("shutdown_requested");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    logger.info("service_started", {
      roles,
      once: Boolean(options.once),
      pollIntervalMs: config.pollIntervalMs
    });

    do {
      await runCycle({
        config,
        roles,
        resources,
        store,
        state,
        logger
      });

      if (!options.once && !state.stopping) {
        await sleep(config.pollIntervalMs);
      }
    } while (!options.once && !state.stopping);
  } finally {
    if (healthServer) {
      await new Promise((resolve) => healthServer.close(resolve));
    }
    store.close();
    logger.info("service_stopped", { cycles: state.cycles });
  }
}

function selectedRoles(config, role) {
  const known = ["watcher", "attester", "relayer"];
  if (role !== "all" && !known.includes(role)) {
    throw new Error("--role must be watcher, attester, relayer, or all");
  }

  return known.filter((candidate) => {
    return (role === "all" || role === candidate) && config[candidate].enabled;
  });
}

function createRoleResources({ config, roles }) {
  const resources = {};

  if (roles.includes("watcher")) {
    const provider = createProvider(config.watcher.rpcUrl);
    resources.watcher = {
      provider,
      burnGateway: createBurnGateway(provider, config.watcher.burnGateway),
      spendPlan: config.watcher.spendPlanPath ? readJson(config.watcher.spendPlanPath) : null
    };
  }

  if (roles.includes("attester")) {
    const donPrivateKeys = resolveSecret(
      config.attester,
      "donPrivateKeys",
      "donPrivateKeysEnv",
      "attester.donPrivateKeys"
    );
    resources.attester = {
      signerWallets: walletsFromPrivateKeys(parsePrivateKeys(donPrivateKeys))
    };
  }

  if (roles.includes("relayer")) {
    const privateKey = resolveSecret(
      config.relayer,
      "privateKey",
      "privateKeyEnv",
      "relayer.privateKey"
    );
    const provider = createProvider(config.relayer.rpcUrl);
    const relayer = new Wallet(privateKey, provider);
    resources.relayer = {
      provider,
      burnGateway: createBurnGateway(provider, config.relayer.burnGateway).connect(relayer)
    };
  }

  return resources;
}

async function runCycle({ config, roles, resources, store, state, logger }) {
  const startedAtMs = Date.now();
  state.lastCycleAt = unixNow();

  try {
    const results = {};

    if (roles.includes("watcher")) {
      results.watcher = await runWatcherCycle({
        config: config.watcher,
        resources: resources.watcher,
        store
      });
      logger.info("watcher_cycle_completed", results.watcher);
    }

    if (roles.includes("attester")) {
      results.attester = await runAttesterCycle({
        config: config.attester,
        resources: resources.attester,
        store
      });
      logger.info("attester_cycle_completed", results.attester);
    }

    if (roles.includes("relayer")) {
      results.relayer = await runRelayerCycle({
        config: config.relayer,
        resources: resources.relayer,
        store
      });
      logger.info("relayer_cycle_completed", results.relayer);
    }

    state.cycles += 1;
    state.lastSuccessAt = unixNow();
    state.lastError = null;
    state.lastResults = results;
    logger.info("cycle_completed", {
      durationMs: Date.now() - startedAtMs,
      roles
    });
  } catch (error) {
    state.lastErrorAt = unixNow();
    state.lastError = error && error.message ? error.message : String(error);
    logger.error("cycle_failed", {
      durationMs: Date.now() - startedAtMs,
      error: state.lastError
    });
    throw error;
  }
}

async function runWatcherCycle({ config, resources, store }) {
  const latestBlock = await resources.provider.getBlockNumber();
  const finalizedBlock = latestBlock - config.finalityBlocks;
  const previousCursor = store.getCursor(config.cursorName);
  const lastScannedBlock = previousCursor === null ? config.fromBlock - 1 : Number(previousCursor);
  const fromBlock = lastScannedBlock + 1;

  let scanned = [];
  let toBlock = lastScannedBlock;
  if (finalizedBlock >= fromBlock) {
    toBlock = Math.min(finalizedBlock, fromBlock + config.batchSize - 1);
    scanned = await scanRedeemRequests({
      burnGateway: resources.burnGateway,
      store,
      fromBlock,
      toBlock
    });
    store.setCursor(config.cursorName, toBlock);
  }

  let authorizations = [];
  if (resources.spendPlan) {
    authorizations = await authorizeFinalizedRedeems({
      provider: resources.provider,
      burnGateway: resources.burnGateway,
      store,
      finalityBlocks: config.finalityBlocks,
      spendPlan: resources.spendPlan,
      changePolicyHash: config.changePolicyHash,
      ttlSeconds: config.authorizationTtlSeconds,
      latestBlockNumber: latestBlock
    });
  }

  return {
    latestBlock,
    finalizedBlock,
    fromBlock,
    toBlock,
    scanned: scanned.length,
    authorized: authorizations.length,
    cursor: store.getCursor(config.cursorName)
  };
}

async function runAttesterCycle({ config, resources, store }) {
  const results = await attestAuthorizedRedeems({
    store,
    signerWallets: resources.signerWallets,
    threshold: config.threshold,
    limit: config.limit
  });

  return {
    attested: results.length
  };
}

async function runRelayerCycle({ config, resources, store }) {
  const results = await relayAttestedRedeems({
    burnGateway: resources.burnGateway,
    store,
    limit: config.limit
  });

  const counts = {};
  for (const result of results) {
    const status = result.status || "unknown";
    counts[status] = (counts[status] || 0) + 1;
  }

  return {
    relayed: results.length,
    statuses: counts
  };
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
