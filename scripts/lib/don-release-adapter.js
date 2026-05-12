const fs = require("fs");
const http = require("http");
const { parseSignerAddresses } = require("./attestation-ingest");
const { verifyDonReleaseRequest } = require("./don-release-verifier");
const { unixNow } = require("./service-runtime");

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requiredStringValue(value, name) {
  if (value === undefined || value === null) {
    throw new Error(`${name} must be configured`);
  }
  return requiredString(String(value), name);
}

function optionalPositiveInteger(value, name, defaultValue) {
  const parsed = value === undefined ? defaultValue : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function optionalNonNegativeInteger(value, name, defaultValue) {
  const parsed = value === undefined ? defaultValue : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be zero or greater`);
  }
  return parsed;
}

function signerAddressesFromConfig(raw) {
  const direct = raw.signerAddresses;
  if (Array.isArray(direct)) {
    return parseSignerAddresses(direct.join(","));
  }
  if (typeof direct === "string" && direct.length > 0) {
    return parseSignerAddresses(direct);
  }
  if (raw.signerAddressesEnv) {
    const envName = requiredString(raw.signerAddressesEnv, "policy.signerAddressesEnv");
    const value = process.env[envName];
    if (!value) {
      throw new Error(`${envName} is not set`);
    }
    return parseSignerAddresses(value);
  }

  throw new Error("policy.signerAddresses or policy.signerAddressesEnv must be configured");
}

function loadDonReleaseAdapterConfig(path) {
  const raw = readJson(path);
  const policy = raw.policy || {};

  return {
    serviceName: raw.serviceName || "bitcoinbride-don-release-adapter",
    http: {
      host: process.env.BITCOINBRIDE_ADAPTER_HOST || (raw.http && raw.http.host ? raw.http.host : "127.0.0.1"),
      port: process.env.BITCOINBRIDE_ADAPTER_PORT !== undefined
        ? optionalPositiveInteger(process.env.BITCOINBRIDE_ADAPTER_PORT, "BITCOINBRIDE_ADAPTER_PORT", 8790)
        : (raw.http && raw.http.port !== undefined ? optionalPositiveInteger(raw.http.port, "http.port", 8790) : 8790),
      maxBodyBytes: raw.http && raw.http.maxBodyBytes !== undefined
        ? optionalPositiveInteger(raw.http.maxBodyBytes, "http.maxBodyBytes", 1048576)
        : 1048576
    },
    policy: {
      expectedBridgeDomain: requiredString(policy.expectedBridgeDomain, "policy.expectedBridgeDomain"),
      expectedBtcNetwork: requiredStringValue(policy.expectedBtcNetwork, "policy.expectedBtcNetwork"),
      expectedSourceEvmChainId: requiredStringValue(policy.expectedSourceEvmChainId, "policy.expectedSourceEvmChainId"),
      signerAddresses: signerAddressesFromConfig(policy),
      threshold: optionalPositiveInteger(policy.threshold, "policy.threshold", undefined),
      maxAuthorizationTtlSeconds: optionalPositiveInteger(
        policy.maxAuthorizationTtlSeconds,
        "policy.maxAuthorizationTtlSeconds",
        1200
      ),
      maxClockSkewSeconds: optionalNonNegativeInteger(policy.maxClockSkewSeconds, "policy.maxClockSkewSeconds", 60),
      minTimeToDeadlineSeconds: optionalNonNegativeInteger(
        policy.minTimeToDeadlineSeconds,
        "policy.minTimeToDeadlineSeconds",
        0
      ),
      requireSecondaryRedeemEvent: policy.requireSecondaryRedeemEvent === undefined
        ? true
        : Boolean(policy.requireSecondaryRedeemEvent),
      requireSpendPlan: policy.requireSpendPlan === undefined ? true : Boolean(policy.requireSpendPlan),
      now: policy.now === undefined ? undefined : optionalNonNegativeInteger(policy.now, "policy.now", undefined)
    }
  };
}

function unwrapAdapterPayload(body) {
  if (body && typeof body === "object" && body.data && typeof body.data === "object") {
    return body.data;
  }
  return body;
}

function jobRunId(body) {
  if (!body || typeof body !== "object") {
    return null;
  }
  return body.id || body.jobRunID || body.jobRunId || null;
}

function verifyAdapterPayload({ body, policy }) {
  const data = unwrapAdapterPayload(body);
  if (!data || typeof data !== "object") {
    throw new Error("request body must be a JSON object");
  }

  return verifyDonReleaseRequest({
    authorization: data.authorization,
    redeemEvent: data.redeemEvent,
    secondaryRedeemEvent: data.secondaryRedeemEvent,
    spendPlan: data.spendPlan,
    psbtArtifact: data.psbt || data.psbtArtifact,
    bitcoinNetwork: data.bitcoinNetwork,
    expectedBridgeDomain: policy.expectedBridgeDomain,
    expectedBtcNetwork: policy.expectedBtcNetwork,
    expectedSourceEvmChainId: policy.expectedSourceEvmChainId,
    signerAddresses: policy.signerAddresses,
    threshold: policy.threshold,
    now: policy.now,
    maxAuthorizationTtlSeconds: policy.maxAuthorizationTtlSeconds,
    maxClockSkewSeconds: policy.maxClockSkewSeconds,
    minTimeToDeadlineSeconds: policy.minTimeToDeadlineSeconds,
    requireSecondaryRedeemEvent: policy.requireSecondaryRedeemEvent,
    requireSpendPlan: policy.requireSpendPlan
  });
}

function adapterSuccess({ body, verification }) {
  return {
    jobRunID: jobRunId(body),
    statusCode: 200,
    data: verification,
    result: verification.messageDigest
  };
}

function adapterError({ body, error, statusCode }) {
  return {
    jobRunID: jobRunId(body),
    statusCode,
    error: {
      message: error && error.message ? error.message : String(error)
    },
    data: null,
    result: null
  };
}

function readBodyJson(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        reject(new Error("request body exceeds maxBodyBytes"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw.length === 0 ? {} : JSON.parse(raw));
      } catch (error) {
        reject(new Error(`invalid JSON request body: ${error.message}`));
      }
    });

    req.on("error", reject);
  });
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function createAdapterState(serviceName) {
  return {
    serviceName,
    startedAt: unixNow(),
    requests: 0,
    successes: 0,
    failures: 0,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null
  };
}

function startDonReleaseAdapterServer({ config, logger }) {
  const state = createAdapterState(config.serviceName);
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      writeJson(res, 200, {
        ok: true,
        ...state
      });
      return;
    }

    if (req.method !== "POST" || (req.url !== "/" && req.url !== "/release/preflight")) {
      writeJson(res, 404, { error: { message: "not found" } });
      return;
    }

    let body = null;
    state.requests += 1;
    try {
      body = await readBodyJson(req, config.http.maxBodyBytes);
      const verification = verifyAdapterPayload({ body, policy: config.policy });
      state.successes += 1;
      state.lastSuccessAt = unixNow();
      state.lastError = null;
      logger.info("release_preflight_accepted", {
        redeemRequestHash: verification.redeemRequestHash,
        redeemId: verification.redeemId,
        messageDigest: verification.messageDigest
      });
      writeJson(res, 200, adapterSuccess({ body, verification }));
    } catch (error) {
      const statusCode = error.message && error.message.includes("maxBodyBytes") ? 413 : 400;
      state.failures += 1;
      state.lastErrorAt = unixNow();
      state.lastError = error && error.message ? error.message : String(error);
      logger.error("release_preflight_rejected", { error: state.lastError });
      writeJson(res, statusCode, adapterError({ body, error, statusCode }));
    }
  });

  server.listen(config.http.port, config.http.host, () => {
    logger.info("don_release_adapter_started", {
      host: config.http.host,
      port: config.http.port
    });
  });

  return { server, state };
}

module.exports = {
  adapterError,
  adapterSuccess,
  loadDonReleaseAdapterConfig,
  startDonReleaseAdapterServer,
  unwrapAdapterPayload,
  verifyAdapterPayload
};
