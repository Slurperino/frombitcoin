const http = require("http");
const fs = require("fs");
const path = require("path");
const { Command } = require("commander");
const {
  Contract,
  JsonRpcProvider,
  Wallet,
  getAddress,
  hexlify,
  keccak256,
  parseEther,
  randomBytes,
  toUtf8Bytes
} = require("ethers");
const { loadArtifact } = require("./lib/artifacts");
const { depositId } = require("./lib/bridge");
const { BitcoinCoreRpc } = require("./lib/bitcoin-core-rpc");
const { PublicTestnetStore } = require("./lib/public-testnet-store");
const {
  bitcoinRpcOptions,
  loadPublicTestnetConfig,
  resolveEnvSecret
} = require("./lib/public-testnet-config");
const { PublicTestnetCostLimiter } = require("./lib/public-testnet-cost-limiter");
const {
  assertPublicTestnetRuntime,
  assertSignetAddress,
  publicRelayerBalanceBucket,
  publicRelayerFundingStatus
} = require("./lib/public-testnet-runtime-guard");
const {
  toPublicDeposit,
  toPublicDepositCounts,
  toPublicDepositList,
  toPublicRedeem,
  toPublicRedeemCounts,
  toPublicRedeemList
} = require("./lib/public-testnet-views");
const { createLogger } = require("./lib/service-runtime");

const PUBLIC_ROOT = path.join(__dirname, "..", "public");
const PUBLIC_ASSETS = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8", cache: "no-store" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8", cache: "no-store" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8", cache: "public, max-age=60" }],
  ["/app.js", { file: "app.js", type: "application/javascript; charset=utf-8", cache: "public, max-age=60" }],
  ["/favicon.svg", { file: "favicon.svg", type: "image/svg+xml", cache: "public, max-age=3600" }]
]);

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function createContracts(config) {
  const provider = new JsonRpcProvider(config.evm.rpcUrl);
  const relayer = new Wallet(resolveEnvSecret(config.evm.relayerPrivateKeyEnv, "EVM relayer private key"), provider);
  return {
    provider,
    relayer,
    depositRegistry: new Contract(config.evm.depositRegistry, loadArtifact("DepositRegistry").abi, relayer),
    mintGateway: new Contract(config.evm.mintGateway, loadArtifact("MintGateway").abi, relayer),
    burnGateway: new Contract(config.evm.burnGateway, loadArtifact("BurnGateway").abi, relayer),
    verifier: new Contract(config.evm.chainlinkVerifier, loadArtifact("ChainlinkFunctionsVerifier").abi, relayer),
    wrappedBitcoin: new Contract(config.evm.wrappedBitcoin, loadArtifact("WrappedBitcoin").abi, provider)
  };
}

function startPublicTestnetApiServer({ config, store, bitcoinRpc, contracts, logger }) {
  const costLimiter = new PublicTestnetCostLimiter({
    ipLimitPerMinute: config.http.depositPostLimitPerMinute,
    globalLimitPerMinute: config.http.depositGlobalLimitPerMinute,
    recipientLimitPerHour: config.http.depositRecipientLimitPerHour
  });
  const cachedStatus = createCachedStatus({
    ttlMs: config.http.statusCacheTtlMs,
    read: () => serviceStatus({ config, store, bitcoinRpc, contracts })
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        writeEmpty(res, 204);
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      if (req.method === "GET" && servePublicAsset(url.pathname, res)) {
        return;
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        writeJson(res, 200, {
          ok: true,
          service: config.serviceName
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/status") {
        writeJson(res, 200, await cachedStatus.read());
        return;
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        if (!config.http.metricsEnabled) {
          throw new HttpError(404, "not found");
        }
        writeText(res, 200, metricsText({ serviceName: config.serviceName, store }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/deposits") {
        const ip = clientIp(req);
        const body = await readJsonBody(req, config.http.maxBodyBytes);
        const recipient = normalizeRecipient(body.recipient0x || body.recipient);
        if (!costLimiter.allowDeposit({ ip, recipient })) {
          throw new HttpError(429, "deposit intent rate limit exceeded");
        }
        await assertRelayerCanPayDeposit({ config, contracts });
        const deposit = await createDepositIntent({ config, store, bitcoinRpc, contracts, body: { ...body, recipient0x: recipient } });
        logger.info("public_deposit_intent_created", {
          depositId: deposit.depositId,
          recipient: deposit.recipient,
          expectedSats: deposit.expectedSats,
          createIntentTxHash: deposit.createIntentTxHash
        });
        writeJson(res, 201, { deposit: toPublicDeposit(deposit) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/deposits") {
        const limit = boundedLimit(url.searchParams.get("limit"), config.deposits.limit);
        writeJson(res, 200, { deposits: toPublicDepositList(store.listDeposits({ limit })) });
        return;
      }

      const depositIdMatch = url.pathname.match(/^\/deposits\/(0x[0-9a-fA-F]{64})$/);
      if (req.method === "GET" && depositIdMatch) {
        const deposit = store.getDeposit(depositIdMatch[1]);
        if (!deposit) {
          throw new HttpError(404, "deposit not found");
        }
        writeJson(res, 200, { deposit: toPublicDeposit(deposit) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/redeems") {
        const limit = boundedLimit(url.searchParams.get("limit"), config.redeems.limit);
        writeJson(res, 200, { redeems: toPublicRedeemList(store.listRedeems({ limit })) });
        return;
      }

      const redeemMatch = url.pathname.match(/^\/redeems\/(0x[0-9a-fA-F]{64})$/);
      if (req.method === "GET" && redeemMatch) {
        const redeem = store.getRedeem(redeemMatch[1]);
        if (!redeem) {
          throw new HttpError(404, "redeem not found");
        }
        writeJson(res, 200, { redeem: toPublicRedeem(redeem) });
        return;
      }

      throw new HttpError(404, "not found");
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) {
        logger.error("public_api_request_failed", {
          method: req.method,
          url: req.url,
          error: error.message
        });
      }
      writeJson(res, statusCode, {
        error: {
          message: publicErrorMessage(error, statusCode)
        }
      });
    }
  });

  server.listen(config.http.port, config.http.host, () => {
    logger.info("public_api_started", {
      host: config.http.host,
      port: config.http.port
    });
  });

  return { server };
}

async function createDepositIntent({ config, store, bitcoinRpc, contracts, body }) {
  const recipient = normalizeRecipient(body.recipient0x || body.recipient);
  const expectedSats = canonicalUintString(body.expectedSats, "expectedSats");
  assertWithinRange(expectedSats, config.deposits.minSats, config.deposits.maxSats, "expectedSats");

  const now = Math.floor(Date.now() / 1000);
  const nonce = hexlify(randomBytes(32));
  const label = `${config.deposits.addressLabelPrefix}-${nonce.slice(2, 10)}`;
  const depositAddress = await bitcoinRpc.call("getnewaddress", [label, "bech32"]);
  assertSignetAddress(depositAddress, "generated deposit address");
  const depositAddressHash = keccak256(toUtf8Bytes(depositAddress));
  const expiry = String(now + config.deposits.ttlSeconds);
  const intent = {
    recipient0x: recipient,
    depositAddressHash,
    amountMode: 0,
    expectedSats,
    minSats: expectedSats,
    maxSats: expectedSats,
    nonce,
    expiry
  };
  const computedDepositId = depositId(config.evm.bridgeDomain, intent);

  const tx = await contracts.depositRegistry.createDepositIntent(intent);
  const receipt = await tx.wait();
  if (receipt.status === 0) {
    throw new Error("createDepositIntent transaction reverted");
  }

  return store.createDeposit({
    depositId: computedDepositId,
    recipient,
    depositAddress,
    depositAddressHash,
    expectedSats,
    nonce,
    expiry,
    intent,
    createIntentTxHash: receipt.hash,
    createIntentBlockNumber: receipt.blockNumber
  });
}

async function serviceStatus({ config, store, bitcoinRpc, contracts }) {
  const [evmBlock, bitcoinBlock, relayerBalance, totalSupply] = await Promise.allSettled([
    contracts.provider.getBlockNumber(),
    bitcoinRpc.call("getblockcount"),
    contracts.provider.getBalance(contracts.relayer.address),
    contracts.wrappedBitcoin.totalSupply()
  ]);
  const relayerBalanceWei = relayerBalance.status === "fulfilled" ? relayerBalance.value : null;
  const ok = evmBlock.status === "fulfilled" && bitcoinBlock.status === "fulfilled";

  return {
    ok,
    service: config.serviceName,
    mode: "public_testnet",
    network: {
      evmChainId: config.evm.chainId,
      bitcoinNetwork: config.bitcoin.bitcoinNetwork
    },
    custody: {
      controller: config.bitcoin.custodyController
    },
    contracts: {
      depositRegistry: config.evm.depositRegistry,
      mintGateway: config.evm.mintGateway,
      burnGateway: config.evm.burnGateway,
      wrappedBitcoin: config.evm.wrappedBitcoin,
      chainlinkVerifier: config.evm.chainlinkVerifier
    },
    limits: {
      minDepositSats: config.deposits.minSats,
      maxDepositSats: config.deposits.maxSats,
      maxRedeemSats: config.redeems.maxSats,
      maxRedeemMinerFeeSats: config.redeems.maxMinerFeeSats,
      minConfirmations: config.chainlink.minConfirmations
    },
    chain: {
      evmBlock: settledValue(evmBlock),
      bitcoinBlock: settledValue(bitcoinBlock)
    },
    relayer: {
      fundingStatus: publicRelayerFundingStatus(relayerBalanceWei, config.http.minRelayerBalanceEth),
      balanceBucketEth: publicRelayerBalanceBucket(relayerBalanceWei)
    },
    token: {
      totalSupplySats: totalSupply.status === "fulfilled" ? totalSupply.value.toString() : null
    },
    reconciliation: store.reconciliationStats(),
    deposits: toPublicDepositCounts(store.countDepositsByStatus()),
    redeems: toPublicRedeemCounts(store.countRedeemsByStatus())
  };
}

function createCachedStatus({ ttlMs, read }) {
  let cached = null;
  let expiresAt = 0;
  let inFlight = null;
  return {
    async read(now = Date.now()) {
      if (cached && now < expiresAt) {
        return cached;
      }
      if (!inFlight) {
        inFlight = Promise.resolve()
          .then(read)
          .then((value) => {
            cached = value;
            expiresAt = Date.now() + Number(ttlMs || 0);
            return value;
          })
          .finally(() => {
            inFlight = null;
          });
      }
      return inFlight;
    }
  };
}

async function assertRelayerCanPayDeposit({ config, contracts }) {
  const minimum = parseEther(config.http.minRelayerBalanceEth);
  if (minimum === 0n) {
    return;
  }
  const balance = await contracts.provider.getBalance(contracts.relayer.address);
  if (BigInt(balance) < minimum) {
    throw new HttpError(503, "deposit intent creation is temporarily unavailable");
  }
}

function metricsText({ serviceName, store }) {
  const lines = [
    "# HELP bitcoinbride_public_deposits Deposits by public testnet status.",
    "# TYPE bitcoinbride_public_deposits gauge"
  ];
  for (const [status, count] of Object.entries(toPublicDepositCounts(store.countDepositsByStatus()))) {
    lines.push(`bitcoinbride_public_deposits{service="${escapeLabel(serviceName)}",status="${escapeLabel(status)}"} ${count}`);
  }
  lines.push("# HELP bitcoinbride_public_redeems Redeems by public testnet status.");
  lines.push("# TYPE bitcoinbride_public_redeems gauge");
  for (const [status, count] of Object.entries(toPublicRedeemCounts(store.countRedeemsByStatus()))) {
    lines.push(`bitcoinbride_public_redeems{service="${escapeLabel(serviceName)}",status="${escapeLabel(status)}"} ${count}`);
  }
  const reconciliation = store.reconciliationStats();
  lines.push("# HELP bitcoinbride_public_outstanding_redeem_sats Known redeem sats not yet broadcast on Bitcoin.");
  lines.push("# TYPE bitcoinbride_public_outstanding_redeem_sats gauge");
  lines.push(`bitcoinbride_public_outstanding_redeem_sats{service="${escapeLabel(serviceName)}"} ${reconciliation.outstandingRedeemSats}`);
  lines.push("# HELP bitcoinbride_public_don_missing_finalized_txs DON-custody release rows without finalized Bitcoin transactions.");
  lines.push("# TYPE bitcoinbride_public_don_missing_finalized_txs gauge");
  lines.push(`bitcoinbride_public_don_missing_finalized_txs{service="${escapeLabel(serviceName)}"} ${reconciliation.donMissingFinalizedTxs}`);
  lines.push("# HELP bitcoinbride_public_release_artifacts_missing Release rows missing spend plan or authorization artifacts.");
  lines.push("# TYPE bitcoinbride_public_release_artifacts_missing gauge");
  lines.push(`bitcoinbride_public_release_artifacts_missing{service="${escapeLabel(serviceName)}"} ${reconciliation.releaseArtifactsMissing}`);
  lines.push("");
  return lines.join("\n");
}

function servePublicAsset(pathname, res) {
  const asset = PUBLIC_ASSETS.get(pathname);
  if (!asset) {
    return false;
  }

  const filePath = path.join(PUBLIC_ROOT, asset.file);
  let body;
  try {
    body = fs.readFileSync(filePath);
  } catch {
    return false;
  }

  res.writeHead(200, {
    "cache-control": asset.cache,
    "content-type": asset.type
  });
  res.end(body);
  return true;
}

async function readJsonBody(req, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new HttpError(413, "request body too large");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    throw new HttpError(400, "request body is required");
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
}

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "application/json"
  });
  res.end(`${JSON.stringify(body)}\n`);
}

function writeText(res, statusCode, body) {
  res.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "text/plain; version=0.0.4"
  });
  res.end(body);
}

function writeEmpty(res, statusCode) {
  res.writeHead(statusCode, {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": "*"
  });
  res.end();
}

function canonicalUintString(value, name) {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new HttpError(400, `${name} must be a canonical uint string`);
  }
  return text;
}

function assertWithinRange(value, min, max, name) {
  const parsed = BigInt(value);
  if (parsed < BigInt(min) || parsed > BigInt(max)) {
    throw new HttpError(400, `${name} must be between ${min} and ${max} sats`);
  }
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, `${name} is required`);
  }
  return value;
}

function normalizeRecipient(value) {
  return getAddress(requiredString(value, "recipient0x"));
}

function boundedLimit(raw, defaultLimit) {
  if (raw === null) {
    return defaultLimit;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 100) {
    throw new HttpError(400, "limit must be an integer between 1 and 100");
  }
  return parsed;
}

function settledValue(result) {
  return result.status === "fulfilled" ? result.value : null;
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function publicErrorMessage(error, statusCode) {
  if (statusCode >= 500) {
    return "internal server error";
  }
  return error.message || String(error);
}

function escapeLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\"", "\\\"");
}

async function main() {
  const program = new Command();
  program.requiredOption("--config <path>", "public testnet service JSON config");
  program.parse(process.argv);

  const config = loadPublicTestnetConfig(program.opts().config);
  const logger = createLogger({ service: config.serviceName, role: "public-api" });
  const store = new PublicTestnetStore(config.database);
  const bitcoinRpc = new BitcoinCoreRpc(bitcoinRpcOptions(config));
  const contracts = createContracts(config);
  await assertPublicTestnetRuntime({
    config,
    bitcoinRpc,
    provider: contracts.provider,
    contracts,
    relayerAddress: contracts.relayer.address
  });

  const { server } = startPublicTestnetApiServer({ config, store, bitcoinRpc, contracts, logger });
  const stop = () => {
    logger.info("shutdown_requested");
    server.close(() => {
      store.close();
      logger.info("public_api_stopped");
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createCachedStatus,
  createDepositIntent,
  createContracts,
  serviceStatus,
  servePublicAsset,
  startPublicTestnetApiServer
};
