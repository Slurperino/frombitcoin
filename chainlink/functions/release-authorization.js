const REDEEM_REQUESTED_TOPIC = "0x7ac0a81dedaae7e40426a8a3e125effb9301759ac22c1699db5aad9f04ed8abc";
const KIND_RELEASE = 2;

function normalizeHex(value) {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw new Error(`invalid hex value: ${value}`);
  }
  return value.toLowerCase();
}

function topicAddress(topic) {
  return `0x${normalizeHex(topic).slice(-40)}`;
}

function word(data, index) {
  const hex = normalizeHex(data).slice(2);
  const start = index * 64;
  const out = hex.slice(start, start + 64);
  if (out.length !== 64) {
    throw new Error("redeem log data is too short");
  }
  return out;
}

function uintWord(data, index) {
  return BigInt(`0x${word(data, index)}`).toString();
}

function bytesWord(data, offsetBytes) {
  const hex = normalizeHex(data).slice(2);
  const offset = Number(offsetBytes) * 2;
  const length = Number(BigInt(`0x${hex.slice(offset, offset + 64)}`));
  const start = offset + 64;
  return `0x${hex.slice(start, start + length * 2)}`;
}

function decodeRedeemLog(log) {
  const offset = BigInt(`0x${word(log.data, 4)}`);
  return {
    redeemRequestHash: normalizeHex(log.topics[1]),
    blockNumber: Number.parseInt(log.blockNumber, 16),
    blockHash: normalizeHex(log.blockHash),
    txHash: normalizeHex(log.transactionHash),
    logIndex: Number.parseInt(log.logIndex, 16),
    requester: topicAddress(log.topics[2]),
    destinationScriptHash: normalizeHex(log.topics[3]),
    requestNonce: uintWord(log.data, 0),
    amountSats: uintWord(log.data, 1),
    maxMinerFeeSats: uintWord(log.data, 2),
    deadline: uintWord(log.data, 3),
    destinationScriptPubKey: bytesWord(log.data, offset)
  };
}

async function rpc(url, method, params) {
  const response = await Functions.makeHttpRequest({
    url,
    method: "POST",
    headers: { "content-type": "application/json" },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    },
    timeout: 9000
  });

  if (response.error) {
    throw new Error(`RPC request failed for ${method}`);
  }
  if (response.data.error) {
    throw new Error(`RPC ${method} error: ${response.data.error.message || JSON.stringify(response.data.error)}`);
  }
  return response.data.result;
}

async function redeemEventFromRpc({ rpcUrl, burnGateway, authorization }) {
  const receipt = await rpc(rpcUrl, "eth_getTransactionReceipt", [authorization.burnTxHash]);
  if (!receipt) {
    throw new Error("burn transaction receipt not found");
  }

  const burnAddress = normalizeHex(burnGateway);
  for (const log of receipt.logs || []) {
    if (
      normalizeHex(log.address) === burnAddress &&
      normalizeHex(log.topics[0]) === REDEEM_REQUESTED_TOPIC &&
      normalizeHex(log.topics[1]) === normalizeHex(authorization.redeemRequestHash) &&
      Number.parseInt(log.logIndex, 16) === Number(authorization.burnLogIndex)
    ) {
      return decodeRedeemLog(log);
    }
  }

  throw new Error("RedeemRequested log not found in burn receipt");
}

function assertSame(a, b, label) {
  if (String(a).toLowerCase() !== String(b).toLowerCase()) {
    throw new Error(`${label} mismatch`);
  }
}

function assertBytes32(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(value))) {
    throw new Error(`${label} must be bytes32 hex`);
  }
}

function assertEventMatchesAuthorization(event, authorization) {
  assertSame(event.redeemRequestHash, authorization.redeemRequestHash, "redeemRequestHash");
  assertSame(event.txHash, authorization.burnTxHash, "burnTxHash");
  assertSame(event.logIndex, authorization.burnLogIndex, "burnLogIndex");
  assertSame(event.requester, authorization.requester, "requester");
  assertSame(event.destinationScriptHash, authorization.destinationScriptHash, "destinationScriptHash");
  assertSame(event.amountSats, authorization.amountSats, "amountSats");
  assertSame(event.maxMinerFeeSats, authorization.maxMinerFeeSats, "maxMinerFeeSats");
}

function assertEventsAgree(primary, secondary) {
  for (const field of [
    "redeemRequestHash",
    "txHash",
    "logIndex",
    "requester",
    "destinationScriptHash",
    "requestNonce",
    "amountSats",
    "maxMinerFeeSats",
    "deadline",
    "destinationScriptPubKey",
    "blockHash"
  ]) {
    assertSame(primary[field], secondary[field], `secondary ${field}`);
  }
}

function abiEncodeApproval(kind, structHash) {
  const kindHex = BigInt(kind).toString(16).padStart(64, "0");
  return hexToBytes(`${kindHex}${normalizeHex(structHash).slice(2).padStart(64, "0")}`);
}

function hexToBytes(hex) {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(normalized)) {
    throw new Error("invalid bytes hex");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const adapterUrl = args[0];
const primaryRpcUrl = args[1];
const secondaryRpcUrl = args[2];
const burnGateway = args[3];
const minFinalityBlocks = Number(args[4]);
if (!Number.isSafeInteger(minFinalityBlocks) || minFinalityBlocks <= 0) {
  throw new Error("invalid finality policy");
}
const authorization = JSON.parse(args[5]);
const spendPlan = JSON.parse(args[6]);
const expectedReleaseStructHash = args[7];
assertBytes32(expectedReleaseStructHash, "releaseStructHash");

const primaryEvent = await redeemEventFromRpc({ rpcUrl: primaryRpcUrl, burnGateway, authorization });
const secondaryEvent = await redeemEventFromRpc({ rpcUrl: secondaryRpcUrl, burnGateway, authorization });
assertEventMatchesAuthorization(primaryEvent, authorization);
assertEventMatchesAuthorization(secondaryEvent, authorization);
assertEventsAgree(primaryEvent, secondaryEvent);

const primaryLatestHex = await rpc(primaryRpcUrl, "eth_blockNumber", []);
const secondaryLatestHex = await rpc(secondaryRpcUrl, "eth_blockNumber", []);
const primaryLatestBlock = Number.parseInt(primaryLatestHex, 16);
const secondaryLatestBlock = Number.parseInt(secondaryLatestHex, 16);
if (
  primaryLatestBlock - primaryEvent.blockNumber < minFinalityBlocks ||
  secondaryLatestBlock - secondaryEvent.blockNumber < minFinalityBlocks
) {
  throw new Error("burn event does not satisfy finality policy");
}

const preflight = await Functions.makeHttpRequest({
  url: adapterUrl,
  method: "POST",
  headers: { "content-type": "application/json" },
  data: {
    authorization,
    redeemEvent: primaryEvent,
    secondaryRedeemEvent: secondaryEvent,
    spendPlan
  },
  timeout: 9000
});

if (preflight.error) {
  throw new Error("DON release adapter request failed");
}
if (preflight.data.statusCode !== 200 || !preflight.data.data || preflight.data.data.signable !== true) {
  throw new Error(`DON release preflight rejected: ${JSON.stringify(preflight.data.error || preflight.data)}`);
}
assertSame(preflight.data.data.releaseStructHash, expectedReleaseStructHash, "releaseStructHash");

return abiEncodeApproval(KIND_RELEASE, expectedReleaseStructHash);
