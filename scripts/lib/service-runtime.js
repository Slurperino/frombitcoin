const fs = require("fs");
const http = require("http");

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLogger({ service, role = "service" }) {
  function write(level, event, fields = {}) {
    const record = {
      ts: new Date().toISOString(),
      level,
      service,
      role,
      event,
      ...fields
    };
    const stream = level === "error" ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(record)}\n`);
  }

  return {
    info: (event, fields) => write("info", event, fields),
    error: (event, fields) => write("error", event, fields)
  };
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalNumber(value, name, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }
  return parsed;
}

function optionalInteger(value, name, defaultValue) {
  const parsed = optionalNumber(value, name, defaultValue);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function optionalPositiveInteger(value, name, defaultValue) {
  const parsed = optionalInteger(value, name, defaultValue);
  if (parsed <= 0) {
    throw new Error(`${name} must be greater than zero`);
  }
  return parsed;
}

function optionalNonNegativeInteger(value, name, defaultValue) {
  const parsed = optionalInteger(value, name, defaultValue);
  if (parsed < 0) {
    throw new Error(`${name} must be zero or greater`);
  }
  return parsed;
}

function resolveSecret(config, field, envField, name) {
  if (config[field]) {
    return requiredString(config[field], name);
  }

  if (config[envField]) {
    const envName = requiredString(config[envField], `${name} env name`);
    const value = process.env[envName];
    if (!value) {
      throw new Error(`${envName} is not set`);
    }
    return value;
  }

  throw new Error(`${name} or ${name}Env must be configured`);
}

function loadRedeemServiceConfig(path) {
  const raw = readJson(path);
  const config = {
    serviceName: raw.serviceName ?? "bitcoinbride-redeem-service",
    database: requiredString(raw.database, "database"),
    pollIntervalMs: optionalPositiveInteger(raw.pollIntervalMs, "pollIntervalMs", 12000),
    health: {
      enabled: raw.health && raw.health.enabled !== undefined ? Boolean(raw.health.enabled) : true,
      host: process.env.BITCOINBRIDE_HEALTH_HOST || (raw.health && raw.health.host ? raw.health.host : "127.0.0.1"),
      port: process.env.BITCOINBRIDE_HEALTH_PORT !== undefined
        ? optionalPositiveInteger(process.env.BITCOINBRIDE_HEALTH_PORT, "BITCOINBRIDE_HEALTH_PORT", 8787)
        : (raw.health && raw.health.port !== undefined ? optionalPositiveInteger(raw.health.port, "health.port", 8787) : 8787)
    },
    watcher: raw.watcher ? normalizeWatcherConfig(raw.watcher) : { enabled: false },
    attester: raw.attester ? normalizeAttesterConfig(raw.attester) : { enabled: false },
    relayer: raw.relayer ? normalizeRelayerConfig(raw.relayer) : { enabled: false }
  };

  if (!config.watcher.enabled && !config.attester.enabled && !config.relayer.enabled) {
    throw new Error("at least one service role must be enabled");
  }

  return config;
}

function normalizeWatcherConfig(raw) {
  const enabled = raw.enabled !== undefined ? Boolean(raw.enabled) : true;
  if (!enabled) {
    return { enabled: false };
  }

  const hasSpendPlan = raw.spendPlanPath !== undefined || raw.changePolicyHash !== undefined;
  if (hasSpendPlan && (!raw.spendPlanPath || !raw.changePolicyHash)) {
    throw new Error("watcher.spendPlanPath and watcher.changePolicyHash must be configured together");
  }

  return {
    enabled: true,
    rpcUrl: requiredString(raw.rpcUrl, "watcher.rpcUrl"),
    burnGateway: requiredString(raw.burnGateway, "watcher.burnGateway"),
    fromBlock: optionalNonNegativeInteger(raw.fromBlock, "watcher.fromBlock", 0),
    batchSize: optionalPositiveInteger(raw.batchSize, "watcher.batchSize", 1000),
    finalityBlocks: optionalNonNegativeInteger(raw.finalityBlocks, "watcher.finalityBlocks", 12),
    spendPlanPath: raw.spendPlanPath,
    changePolicyHash: raw.changePolicyHash,
    authorizationTtlSeconds: optionalPositiveInteger(
      raw.authorizationTtlSeconds,
      "watcher.authorizationTtlSeconds",
      1200
    ),
    cursorName: raw.cursorName ?? "evm_redeem_watcher.last_scanned_block"
  };
}

function normalizeAttesterConfig(raw) {
  const enabled = raw.enabled !== undefined ? Boolean(raw.enabled) : true;
  if (!enabled) {
    return { enabled: false };
  }

  return {
    enabled: true,
    donPrivateKeys: raw.donPrivateKeys,
    donPrivateKeysEnv: raw.donPrivateKeysEnv,
    threshold: optionalPositiveInteger(raw.threshold, "attester.threshold", undefined),
    limit: optionalPositiveInteger(raw.limit, "attester.limit", 100)
  };
}

function normalizeRelayerConfig(raw) {
  const enabled = raw.enabled !== undefined ? Boolean(raw.enabled) : true;
  if (!enabled) {
    return { enabled: false };
  }

  return {
    enabled: true,
    rpcUrl: requiredString(raw.rpcUrl, "relayer.rpcUrl"),
    burnGateway: requiredString(raw.burnGateway, "relayer.burnGateway"),
    privateKey: raw.privateKey,
    privateKeyEnv: raw.privateKeyEnv,
    limit: optionalPositiveInteger(raw.limit, "relayer.limit", 100)
  };
}

function createServiceState({ serviceName, roles }) {
  return {
    serviceName,
    roles,
    startedAt: unixNow(),
    lastCycleAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    cycles: 0,
    stopping: false,
    lastResults: {}
  };
}

function stateIsHealthy(state) {
  return state.lastErrorAt === null || (state.lastSuccessAt !== null && state.lastSuccessAt >= state.lastErrorAt);
}

function metricsText({ state, store }) {
  const lines = [];
  const up = stateIsHealthy(state) ? 1 : 0;
  lines.push("# HELP bitcoinbride_service_up Service health status.");
  lines.push("# TYPE bitcoinbride_service_up gauge");
  lines.push(`bitcoinbride_service_up{service="${escapeLabel(state.serviceName)}"} ${up}`);
  lines.push("# HELP bitcoinbride_service_cycles_total Completed service cycles.");
  lines.push("# TYPE bitcoinbride_service_cycles_total counter");
  lines.push(`bitcoinbride_service_cycles_total{service="${escapeLabel(state.serviceName)}"} ${state.cycles}`);
  lines.push("# HELP bitcoinbride_service_last_success_timestamp_seconds Last successful cycle unix timestamp.");
  lines.push("# TYPE bitcoinbride_service_last_success_timestamp_seconds gauge");
  lines.push(`bitcoinbride_service_last_success_timestamp_seconds{service="${escapeLabel(state.serviceName)}"} ${state.lastSuccessAt ?? 0}`);
  lines.push("# HELP bitcoinbride_redeem_events Events by persisted redeem status.");
  lines.push("# TYPE bitcoinbride_redeem_events gauge");

  const counts = store.countEventsByStatus();
  for (const [status, count] of Object.entries(counts)) {
    lines.push(`bitcoinbride_redeem_events{status="${escapeLabel(status)}"} ${count}`);
  }

  lines.push("");
  return lines.join("\n");
}

function escapeLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\"", "\\\"");
}

function startHealthServer({ host, port, state, store, logger }) {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      const healthy = stateIsHealthy(state);
      const body = JSON.stringify({
        ok: healthy,
        service: state.serviceName,
        roles: state.roles,
        startedAt: state.startedAt,
        lastCycleAt: state.lastCycleAt,
        lastSuccessAt: state.lastSuccessAt,
        lastErrorAt: state.lastErrorAt,
        lastError: state.lastError,
        stopping: state.stopping,
        cursors: store.listCursors()
      });
      res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
      res.end(body);
      return;
    }

    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(metricsText({ state, store }));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });

  server.listen(port, host, () => {
    logger.info("health_server_started", { host, port });
  });

  return server;
}

module.exports = {
  createLogger,
  createServiceState,
  loadRedeemServiceConfig,
  readJson,
  resolveSecret,
  sleep,
  startHealthServer,
  unixNow
};
