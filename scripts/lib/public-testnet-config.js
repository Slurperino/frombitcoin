const fs = require("fs");
const { getAddress, isHexString } = require("ethers");

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value, name, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }
  return requiredString(value, name);
}

function requiredAddress(value, name) {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${name} must be an EVM address`);
  }
}

function requiredBytes32(value, name) {
  if (!isHexString(value, 32)) {
    throw new Error(`${name} must be bytes32 hex`);
  }
  return value;
}

function optionalPositiveInteger(value, name, defaultValue) {
  const parsed = value === undefined ? defaultValue : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function optionalNonNegativeInteger(value, name, defaultValue) {
  const parsed = value === undefined ? defaultValue : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be zero or greater`);
  }
  return parsed;
}

function optionalUintString(value, name, defaultValue) {
  const raw = value === undefined ? defaultValue : value;
  const normalized = String(raw);
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    throw new Error(`${name} must be a canonical uint string`);
  }
  return normalized;
}

function optionalBoolean(value, defaultValue) {
  return value === undefined ? defaultValue : Boolean(value);
}

function optionalEnum(value, name, defaultValue, allowedValues) {
  const normalized = value === undefined ? defaultValue : String(value);
  if (!allowedValues.includes(normalized)) {
    throw new Error(`${name} must be one of ${allowedValues.join(", ")}`);
  }
  return normalized;
}

function optionalEthString(value, name, defaultValue) {
  const normalized = optionalUintDecimalString(value, name, defaultValue);
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(normalized)) {
    throw new Error(`${name} must be an ETH decimal string`);
  }
  return normalized;
}

function optionalUintDecimalString(value, name, defaultValue) {
  const raw = value === undefined ? defaultValue : value;
  const normalized = String(raw);
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(normalized)) {
    throw new Error(`${name} must be a decimal string`);
  }
  return normalized;
}

function loadPublicTestnetConfig(path) {
  const raw = readJson(path);
  const evm = raw.evm || {};
  const chainlink = raw.chainlink || {};
  const bitcoin = raw.bitcoin || {};
  const deposits = raw.deposits || {};
  const redeems = raw.redeems || {};
  const worker = raw.worker || {};
  const http = raw.http || {};

  return {
    serviceName: raw.serviceName || "bitcoinbride-public-testnet",
    database: requiredString(raw.database, "database"),
    http: {
      enabled: http.enabled === undefined ? true : Boolean(http.enabled),
      host: optionalString(http.host, "http.host", "127.0.0.1"),
      port: optionalPositiveInteger(http.port, "http.port", 8880),
      maxBodyBytes: optionalPositiveInteger(http.maxBodyBytes, "http.maxBodyBytes", 65536),
      depositPostLimitPerMinute: optionalPositiveInteger(
        http.depositPostLimitPerMinute,
        "http.depositPostLimitPerMinute",
        12
      ),
      depositGlobalLimitPerMinute: optionalPositiveInteger(
        http.depositGlobalLimitPerMinute,
        "http.depositGlobalLimitPerMinute",
        60
      ),
      depositRecipientLimitPerHour: optionalPositiveInteger(
        http.depositRecipientLimitPerHour,
        "http.depositRecipientLimitPerHour",
        6
      ),
      minRelayerBalanceEth: optionalEthString(http.minRelayerBalanceEth, "http.minRelayerBalanceEth", "0.005"),
      statusCacheTtlMs: optionalPositiveInteger(http.statusCacheTtlMs, "http.statusCacheTtlMs", 5000),
      metricsEnabled: optionalBoolean(http.metricsEnabled, false)
    },
    evm: {
      rpcUrl: requiredString(evm.rpcUrl, "evm.rpcUrl"),
      primaryRpcUrl: requiredString(evm.primaryRpcUrl || evm.rpcUrl, "evm.primaryRpcUrl"),
      secondaryRpcUrl: requiredString(evm.secondaryRpcUrl, "evm.secondaryRpcUrl"),
      chainId: optionalPositiveInteger(evm.chainId, "evm.chainId", 11155111),
      bridgeDomain: requiredBytes32(evm.bridgeDomain, "evm.bridgeDomain"),
      relayerPrivateKeyEnv: requiredString(evm.relayerPrivateKeyEnv, "evm.relayerPrivateKeyEnv"),
      depositRegistry: requiredAddress(evm.depositRegistry, "evm.depositRegistry"),
      mintGateway: requiredAddress(evm.mintGateway, "evm.mintGateway"),
      burnGateway: requiredAddress(evm.burnGateway, "evm.burnGateway"),
      wrappedBitcoin: requiredAddress(evm.wrappedBitcoin, "evm.wrappedBitcoin"),
      chainlinkVerifier: requiredAddress(evm.chainlinkVerifier, "evm.chainlinkVerifier"),
      fromBlock: optionalNonNegativeInteger(evm.fromBlock, "evm.fromBlock", 0),
      scanBatchSize: optionalPositiveInteger(evm.scanBatchSize, "evm.scanBatchSize", 500),
      finalityBlocks: optionalNonNegativeInteger(evm.finalityBlocks, "evm.finalityBlocks", 12)
    },
    chainlink: {
      primaryBitcoinApi: requiredString(chainlink.primaryBitcoinApi, "chainlink.primaryBitcoinApi"),
      secondaryBitcoinApi: requiredString(chainlink.secondaryBitcoinApi, "chainlink.secondaryBitcoinApi"),
      adapterUrl: requiredString(chainlink.adapterUrl, "chainlink.adapterUrl"),
      minConfirmations: optionalPositiveInteger(chainlink.minConfirmations, "chainlink.minConfirmations", 6),
      releaseFinalityBlocks: optionalPositiveInteger(
        chainlink.releaseFinalityBlocks,
        "chainlink.releaseFinalityBlocks",
        12
      )
    },
    bitcoin: {
      rpcUrl: requiredString(bitcoin.rpcUrl, "bitcoin.rpcUrl"),
      rpcUserEnv: optionalString(bitcoin.rpcUserEnv, "bitcoin.rpcUserEnv", null),
      rpcPasswordEnv: optionalString(bitcoin.rpcPasswordEnv, "bitcoin.rpcPasswordEnv", null),
      rpcCookie: optionalString(bitcoin.rpcCookie, "bitcoin.rpcCookie", null),
      wallet: requiredString(bitcoin.wallet, "bitcoin.wallet"),
      custodyController: optionalEnum(
        bitcoin.custodyController,
        "bitcoin.custodyController",
        "local-wallet",
        ["local-wallet", "chainlink-don"]
      ),
      donCustodyAdapterUrl: optionalString(bitcoin.donCustodyAdapterUrl, "bitcoin.donCustodyAdapterUrl", null),
      donCustodyAdapterTimeoutMs: optionalPositiveInteger(
        bitcoin.donCustodyAdapterTimeoutMs,
        "bitcoin.donCustodyAdapterTimeoutMs",
        9000
      ),
      bitcoinNetwork: requiredString(bitcoin.bitcoinNetwork, "bitcoin.bitcoinNetwork"),
      btcNetwork: optionalUintString(bitcoin.btcNetwork, "bitcoin.btcNetwork", "3"),
      treasuryAddress: requiredString(bitcoin.treasuryAddress, "bitcoin.treasuryAddress"),
      changeAddress: requiredString(bitcoin.changeAddress || bitcoin.treasuryAddress, "bitcoin.changeAddress"),
      minConf: optionalNonNegativeInteger(bitcoin.minConf, "bitcoin.minConf", 1),
      rpcTimeoutMs: optionalPositiveInteger(bitcoin.rpcTimeoutMs, "bitcoin.rpcTimeoutMs", 9000),
      rpcMaxRetries: optionalNonNegativeInteger(bitcoin.rpcMaxRetries, "bitcoin.rpcMaxRetries", 2),
      rpcRetryDelayMs: optionalNonNegativeInteger(bitcoin.rpcRetryDelayMs, "bitcoin.rpcRetryDelayMs", 250)
    },
    deposits: {
      minSats: optionalUintString(deposits.minSats, "deposits.minSats", "1000"),
      maxSats: optionalUintString(deposits.maxSats, "deposits.maxSats", "100000"),
      ttlSeconds: optionalPositiveInteger(deposits.ttlSeconds, "deposits.ttlSeconds", 86400),
      authorizationTtlSeconds: optionalPositiveInteger(
        deposits.authorizationTtlSeconds,
        "deposits.authorizationTtlSeconds",
        1200
      ),
      addressLabelPrefix: optionalString(deposits.addressLabelPrefix, "deposits.addressLabelPrefix", "bitcoinbride-deposit"),
      limit: optionalPositiveInteger(deposits.limit, "deposits.limit", 20)
    },
    redeems: {
      maxSats: optionalUintString(redeems.maxSats, "redeems.maxSats", "100000"),
      maxMinerFeeSats: optionalUintString(redeems.maxMinerFeeSats, "redeems.maxMinerFeeSats", "5000"),
      authorizationTtlSeconds: optionalPositiveInteger(
        redeems.authorizationTtlSeconds,
        "redeems.authorizationTtlSeconds",
        1200
      ),
      changePolicyHash: requiredBytes32(redeems.changePolicyHash, "redeems.changePolicyHash"),
      limit: optionalPositiveInteger(redeems.limit, "redeems.limit", 20),
      autoBroadcastBitcoin: optionalBoolean(redeems.autoBroadcastBitcoin, true)
    },
    worker: {
      pollIntervalMs: optionalPositiveInteger(worker.pollIntervalMs, "worker.pollIntervalMs", 12000),
      once: optionalBoolean(worker.once, false),
      rpcTimeoutMs: optionalPositiveInteger(worker.rpcTimeoutMs, "worker.rpcTimeoutMs", 9000),
      rpcMaxRetries: optionalNonNegativeInteger(worker.rpcMaxRetries, "worker.rpcMaxRetries", 1),
      rpcRetryDelayMs: optionalNonNegativeInteger(worker.rpcRetryDelayMs, "worker.rpcRetryDelayMs", 250)
    }
  };
}

function resolveEnvSecret(envName, label) {
  const value = process.env[envName];
  if (!value) {
    throw new Error(`${label} env var ${envName} is not set`);
  }
  return value;
}

function bitcoinRpcOptions(config) {
  return {
    rpcUrl: config.bitcoin.rpcUrl,
    rpcUser: config.bitcoin.rpcUserEnv ? resolveEnvSecret(config.bitcoin.rpcUserEnv, "Bitcoin RPC user") : undefined,
    rpcPassword: config.bitcoin.rpcPasswordEnv
      ? resolveEnvSecret(config.bitcoin.rpcPasswordEnv, "Bitcoin RPC password")
      : undefined,
    rpcCookie: config.bitcoin.rpcCookie || undefined,
    wallet: config.bitcoin.wallet,
    timeoutMs: config.bitcoin.rpcTimeoutMs,
    maxRetries: config.bitcoin.rpcMaxRetries,
    retryDelayMs: config.bitcoin.rpcRetryDelayMs
  };
}

module.exports = {
  bitcoinRpcOptions,
  loadPublicTestnetConfig,
  resolveEnvSecret
};
