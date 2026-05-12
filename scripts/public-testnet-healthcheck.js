#!/usr/bin/env node
const { Command } = require("commander");

const DEFAULT_BASE_URL = "https://api.frombitcoin.link";
const DEFAULT_MAX_RESPONSE_MS = 5_000;
const TESTNET_WARNING_TEXT = "TESTNET ONLY";

const FORBIDDEN_PUBLIC_KEYS = new Set([
  "intent",
  "nonce",
  "depositAddressHash",
  "mintAuthorization",
  "mintStructHash",
  "destinationScriptHash",
  "destinationScriptPubKey",
  "destinationAddress",
  "requestNonce",
  "blockHash",
  "psbt",
  "spendPlan",
  "releaseAuthorization",
  "releaseStructHash",
  "releaseRequestId",
  "bitcoinTxHex",
  "error",
  "internalStatus",
  "cursors"
]);

async function runPublicTestnetHealthcheck({
  baseUrl = DEFAULT_BASE_URL,
  adapterUrl = null,
  expectedEvmChainId = 11155111,
  expectedBitcoinNetwork = "signet",
  expectedBurnGateway = null,
  maxResponseMs = DEFAULT_MAX_RESPONSE_MS,
  expectMetrics = false,
  checkFrontendWarning = true
} = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const checks = [];

  const health = await requestJson(`${base}/healthz`, { maxResponseMs });
  assertCheck(health.status === 200 && health.body && health.body.ok === true, "/healthz must return ok=true");
  checks.push(checkResult("/healthz", health));

  const status = await requestJson(`${base}/status`, { maxResponseMs });
  assertCheck(status.status === 200 && status.body && status.body.ok === true, "/status must return ok=true");
  assertCheck(status.body.mode === "public_testnet", "/status mode must be public_testnet");
  assertCheck(Number(status.body.network && status.body.network.evmChainId) === Number(expectedEvmChainId), "/status EVM chain id mismatch");
  assertCheck(status.body.network && status.body.network.bitcoinNetwork === expectedBitcoinNetwork, "/status Bitcoin network mismatch");
  assertCheck(status.body.relayer && status.body.relayer.fundingStatus === "funded", "/status relayer must be funded");
  if (expectedBurnGateway) {
    assertCheck(
      String(status.body.contracts && status.body.contracts.burnGateway).toLowerCase() === String(expectedBurnGateway).toLowerCase(),
      "/status burnGateway mismatch"
    );
  }
  checks.push(checkResult("/status", status));

  const deposits = await requestJson(`${base}/deposits?limit=5`, { maxResponseMs });
  assertCheck(deposits.status === 200 && Array.isArray(deposits.body && deposits.body.deposits), "/deposits must return a deposits array");
  const depositLeaks = scanForbiddenPublicKeys(deposits.body);
  assertCheck(depositLeaks.length === 0, `/deposits exposes internal fields: ${depositLeaks.join(", ")}`);
  checks.push(checkResult("/deposits?limit=5", deposits));

  const redeems = await requestJson(`${base}/redeems?limit=5`, { maxResponseMs });
  assertCheck(redeems.status === 200 && Array.isArray(redeems.body && redeems.body.redeems), "/redeems must return a redeems array");
  const redeemLeaks = scanForbiddenPublicKeys(redeems.body);
  assertCheck(redeemLeaks.length === 0, `/redeems exposes internal fields: ${redeemLeaks.join(", ")}`);
  checks.push(checkResult("/redeems?limit=5", redeems));

  const metrics = await requestText(`${base}/metrics`, { maxResponseMs });
  assertCheck(expectMetrics ? metrics.status === 200 : metrics.status === 404, expectMetrics ? "/metrics must be enabled" : "/metrics must stay disabled publicly");
  checks.push(checkResult("/metrics", metrics));

  if (checkFrontendWarning) {
    const root = await requestText(`${base}/`, { maxResponseMs });
    assertCheck(root.status === 200 && root.body.includes(TESTNET_WARNING_TEXT), "frontend must include visible TESTNET ONLY warning");
    checks.push(checkResult("/", root));
  }

  if (adapterUrl) {
    const adapterBase = normalizeBaseUrl(adapterUrl);
    const adapter = await requestJson(`${adapterBase}/healthz`, { maxResponseMs });
    assertCheck(adapter.status === 200 && adapter.body && adapter.body.ok === true, "adapter /healthz must return ok=true");
    checks.push(checkResult("adapter:/healthz", adapter));
  }

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    baseUrl: base,
    checks
  };
}

async function runPublicTestnetHealthcheckWithRetries({
  attempts = 1,
  retryDelayMs = 2_000,
  ...options
} = {}) {
  const maxAttempts = Math.max(1, Number(attempts));
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await runPublicTestnetHealthcheck(options);
      return {
        ...result,
        attempts: attempt
      };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(Number(retryDelayMs));
      }
    }
  }
  throw lastError;
}

async function requestJson(url, { maxResponseMs }) {
  const result = await requestText(url, { maxResponseMs });
  try {
    result.body = JSON.parse(result.body);
  } catch (error) {
    throw new Error(`${url} did not return JSON: ${error.message}`);
  }
  return result;
}

async function requestText(url, { maxResponseMs }) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(maxResponseMs));
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.text();
    return {
      status: response.status,
      durationMs: Date.now() - startedAt,
      body
    };
  } finally {
    clearTimeout(timer);
  }
}

function scanForbiddenPublicKeys(value, path = "$", hits = []) {
  if (!value || typeof value !== "object") {
    return hits;
  }

  for (const [key, child] of Object.entries(value)) {
    const nextPath = `${path}.${key}`;
    if (FORBIDDEN_PUBLIC_KEYS.has(key)) {
      hits.push(nextPath);
    }
    scanForbiddenPublicKeys(child, nextPath, hits);
  }
  return hits;
}

function checkResult(path, result) {
  return {
    path,
    status: result.status,
    durationMs: result.durationMs
  };
}

function assertCheck(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function main() {
  const program = new Command();
  program
    .option("--base-url <url>", "public API base URL", DEFAULT_BASE_URL)
    .option("--adapter-url <url>", "public Chainlink adapter base URL")
    .option("--expected-evm-chain-id <number>", "expected EVM chain id", "11155111")
    .option("--expected-bitcoin-network <name>", "expected Bitcoin network", "signet")
    .option("--expected-burn-gateway <address>", "expected public BurnGateway address")
    .option("--max-response-ms <number>", "per-request timeout in milliseconds", String(DEFAULT_MAX_RESPONSE_MS))
    .option("--attempts <number>", "number of healthcheck attempts before failing", "1")
    .option("--retry-delay-ms <number>", "delay between failed attempts", "2000")
    .option("--expect-metrics", "expect public /metrics to be enabled", false)
    .option("--no-frontend-warning", "skip frontend TESTNET ONLY warning check");
  program.parse(process.argv);

  const options = program.opts();
  try {
    const result = await runPublicTestnetHealthcheckWithRetries({
      baseUrl: options.baseUrl,
      adapterUrl: options.adapterUrl,
      expectedEvmChainId: Number(options.expectedEvmChainId),
      expectedBitcoinNetwork: options.expectedBitcoinNetwork,
      expectedBurnGateway: options.expectedBurnGateway,
      maxResponseMs: Number(options.maxResponseMs),
      attempts: Number(options.attempts),
      retryDelayMs: Number(options.retryDelayMs),
      expectMetrics: Boolean(options.expectMetrics),
      checkFrontendWarning: Boolean(options.frontendWarning)
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      checkedAt: new Date().toISOString(),
      error: error.message
    })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  FORBIDDEN_PUBLIC_KEYS,
  runPublicTestnetHealthcheck,
  runPublicTestnetHealthcheckWithRetries,
  scanForbiddenPublicKeys
};
