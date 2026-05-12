const bitcoin = require("bitcoinjs-lib");
const {
  toDonReleasePreparationRequest,
  toDonReleasePreparationResponse,
  toNormalizedSpendPlan
} = require("./authorization-validator");

function createDonCustodyClient({ url, timeoutMs = 9000, fetchImpl = fetch }) {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("bitcoin.donCustodyAdapterUrl must be configured when custodyController is chainlink-don");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("DON custody client requires a fetch implementation");
  }

  return {
    async prepareRelease({ request }) {
      return requestDonReleasePreparation({ url, timeoutMs, request, fetchImpl });
    }
  };
}

async function requestDonReleasePreparation({ url, timeoutMs, request, fetchImpl = fetch }) {
  const normalizedRequest = toDonReleasePreparationRequest(request);
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json"
    },
    body: JSON.stringify(normalizedRequest)
  }, timeoutMs);

  const body = await readJsonResponse(response);
  if (!response.ok) {
    const message = body && body.error && body.error.message ? body.error.message : `HTTP ${response.status}`;
    throw new Error(`DON custody adapter rejected release preparation: ${message}`);
  }

  return normalizeDonReleasePreparation(body);
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs));
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`DON custody adapter timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`DON custody adapter returned invalid JSON: ${error.message}`);
  }
}

function unwrapData(body) {
  if (body && typeof body === "object" && body.data && typeof body.data === "object") {
    return body.data;
  }
  return body;
}

function normalizeDonReleasePreparation(body) {
  const data = unwrapData(body);
  if (!data || typeof data !== "object") {
    throw new Error("DON custody adapter response must be a JSON object");
  }

  const response = toDonReleasePreparationResponse(data);

  const bitcoinTxHex = requiredHexString(response.bitcoinTxHex, "bitcoinTxHex");
  assertFinalTransactionMatchesSpendPlan({ txHex: bitcoinTxHex, spendPlan: response.spendPlan });

  return {
    destinationAddress: response.destinationAddress || null,
    spendPlan: response.spendPlan,
    bitcoinTxHex,
    custodyReceipt: response.custodyReceipt || null
  };
}

function requiredHexString(value, label) {
  if (typeof value !== "string" || value.length === 0 || !/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    throw new Error(`DON custody adapter ${label} must be even-length transaction hex`);
  }
  return value.toLowerCase();
}

function assertFinalTransactionMatchesSpendPlan({ txHex, spendPlan }) {
  const normalized = toNormalizedSpendPlan({
    kind: "NormalizedSpendPlanV1",
    schemaVersion: "1.0.0",
    ...spendPlan
  });
  let tx;
  try {
    tx = bitcoin.Transaction.fromHex(txHex);
  } catch (error) {
    throw new Error(`DON custody adapter bitcoinTxHex is not a valid Bitcoin transaction: ${error.message}`);
  }

  if (String(tx.version) !== String(normalized.nVersion)) {
    throw new Error("DON custody transaction version does not match spend plan");
  }
  if (String(tx.locktime) !== String(normalized.nLockTime)) {
    throw new Error("DON custody transaction locktime does not match spend plan");
  }
  if (tx.ins.length !== normalized.inputs.length) {
    throw new Error("DON custody transaction input count does not match spend plan");
  }
  if (tx.outs.length !== normalized.outputs.length) {
    throw new Error("DON custody transaction output count does not match spend plan");
  }

  for (let i = 0; i < normalized.inputs.length; i += 1) {
    const expected = normalized.inputs[i];
    const actual = tx.ins[i];
    const actualTxId = `0x${Buffer.from(actual.hash).reverse().toString("hex")}`;
    if (actualTxId.toLowerCase() !== String(expected.btcTxId).toLowerCase()) {
      throw new Error(`DON custody transaction input ${i} txid does not match spend plan`);
    }
    if (String(actual.index) !== String(expected.vout)) {
      throw new Error(`DON custody transaction input ${i} vout does not match spend plan`);
    }
  }

  for (let i = 0; i < normalized.outputs.length; i += 1) {
    const expected = normalized.outputs[i];
    const actual = tx.outs[i];
    const actualScript = `0x${Buffer.from(actual.script).toString("hex")}`;
    if (actualScript.toLowerCase() !== String(expected.scriptPubKeyHex).toLowerCase()) {
      throw new Error(`DON custody transaction output ${i} script does not match spend plan`);
    }
    if (String(actual.value) !== String(expected.valueSats)) {
      throw new Error(`DON custody transaction output ${i} value does not match spend plan`);
    }
  }
}

module.exports = {
  assertFinalTransactionMatchesSpendPlan,
  createDonCustodyClient,
  normalizeDonReleasePreparation,
  requestDonReleasePreparation
};
