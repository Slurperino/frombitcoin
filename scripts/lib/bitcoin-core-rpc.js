const fs = require("fs");

const DEFAULT_RPC_TIMEOUT_MS = 9000;
const DEFAULT_RPC_MAX_RETRIES = 2;
const DEFAULT_RPC_RETRY_DELAY_MS = 250;

function rpcAuthHeader({ rpcUser, rpcPassword, rpcCookie }) {
  let user = rpcUser;
  let password = rpcPassword;

  if (rpcCookie) {
    const cookie = fs.readFileSync(rpcCookie, "utf8").trim();
    const separator = cookie.indexOf(":");
    if (separator === -1) {
      throw new Error("Bitcoin Core RPC cookie must contain user:password");
    }
    user = cookie.slice(0, separator);
    password = cookie.slice(separator + 1);
  }

  if (!user || !password) {
    throw new Error("Bitcoin Core RPC credentials are required");
  }

  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function walletRpcUrl(rpcUrl, wallet) {
  const trimmed = rpcUrl.replace(/\/+$/, "");
  if (!wallet) {
    return trimmed;
  }

  return `${trimmed}/wallet/${encodeURIComponent(wallet)}`;
}

class BitcoinCoreRpc {
  constructor({
    rpcUrl,
    rpcUser,
    rpcPassword,
    rpcCookie,
    wallet,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
    maxRetries = DEFAULT_RPC_MAX_RETRIES,
    retryDelayMs = DEFAULT_RPC_RETRY_DELAY_MS
  }) {
    this.rpcUrl = walletRpcUrl(rpcUrl, wallet);
    this.authHeader = rpcAuthHeader({ rpcUser, rpcPassword, rpcCookie });
    this.fetch = fetchImpl;
    this.timeoutMs = positiveInteger(timeoutMs, "Bitcoin Core RPC timeoutMs");
    this.maxRetries = nonNegativeInteger(maxRetries, "Bitcoin Core RPC maxRetries");
    this.retryDelayMs = nonNegativeInteger(retryDelayMs, "Bitcoin Core RPC retryDelayMs");
    this.nextId = 1;
  }

  async call(method, params = []) {
    const id = this.nextId++;
    const request = {
      method: "POST",
      headers: {
        authorization: this.authHeader,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "1.0",
        id,
        method,
        params
      })
    };

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this._callOnce(method, request);
      } catch (error) {
        if (attempt >= this.maxRetries || !isRetryableRpcError(error)) {
          throw error;
        }
        await sleep(this.retryDelayMs);
      }
    }

    throw new Error(`Bitcoin Core RPC ${method} failed after retries`);
  }

  async _callOnce(method, request) {
    const response = await this._fetchWithTimeout(method, request);

    if (!response.ok) {
      const error = new Error(`Bitcoin Core RPC HTTP ${response.status}`);
      error.retryable = response.status >= 500;
      throw error;
    }

    const payload = await response.json();
    if (payload.error) {
      throw new Error(`Bitcoin Core RPC ${method} failed: ${payload.error.message || JSON.stringify(payload.error)}`);
    }

    return payload.result;
  }

  async _fetchWithTimeout(method, request) {
    const controller = new AbortController();
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const timeoutError = new Error(`Bitcoin Core RPC ${method} timed out after ${this.timeoutMs}ms`);
        timeoutError.retryable = true;
        controller.abort(timeoutError);
        reject(timeoutError);
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([
        this.fetch(this.rpcUrl, {
          ...request,
          signal: controller.signal
        }),
        timeoutPromise
      ]);
    } catch (error) {
      if (controller.signal.aborted) {
        const timeoutError = controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error(`Bitcoin Core RPC ${method} timed out after ${this.timeoutMs}ms`);
        timeoutError.retryable = true;
        throw timeoutError;
      }
      error.retryable = true;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function readRpcOptions(options) {
  return {
    rpcUrl: options.rpcUrl,
    rpcUser: options.rpcUser,
    rpcPassword: options.rpcPassword,
    rpcCookie: options.rpcCookie,
    wallet: options.wallet,
    timeoutMs: options.rpcTimeoutMs,
    maxRetries: options.rpcMaxRetries,
    retryDelayMs: options.rpcRetryDelayMs
  };
}

function isRetryableRpcError(error) {
  return Boolean(error && error.retryable);
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be zero or greater`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  BitcoinCoreRpc,
  DEFAULT_RPC_MAX_RETRIES,
  DEFAULT_RPC_RETRY_DELAY_MS,
  DEFAULT_RPC_TIMEOUT_MS,
  readRpcOptions,
  rpcAuthHeader,
  walletRpcUrl
};
