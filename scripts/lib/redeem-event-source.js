const { getAddress, Interface, JsonRpcProvider } = require("ethers");
const { loadArtifact } = require("./artifacts");

function createProvider(rpcUrl) {
  return new JsonRpcProvider(rpcUrl);
}

function burnGatewayInterface() {
  return new Interface(loadArtifact("BurnGateway").abi);
}

function logIndex(log) {
  const value = log.index ?? log.logIndex;
  if (value === undefined || value === null) {
    throw new Error("log is missing index/logIndex");
  }
  return Number(value);
}

function txHashFromLog(log, receipt) {
  return log.transactionHash || receipt.transactionHash || receipt.hash;
}

function blockNumberFromLog(log, receipt) {
  const value = log.blockNumber ?? receipt.blockNumber;
  if (value === undefined || value === null) {
    throw new Error("log is missing blockNumber");
  }
  return Number(value);
}

function blockHashFromLog(log, receipt) {
  const value = log.blockHash || receipt.blockHash;
  if (!value) {
    throw new Error("log is missing blockHash");
  }
  return value;
}

function logAddressMatches(log, address) {
  return getAddress(log.address) === getAddress(address);
}

function parseRedeemRequestedLog({ log, receipt = {}, iface = burnGatewayInterface() }) {
  const parsed = iface.parseLog({
    topics: Array.from(log.topics),
    data: log.data
  });
  if (!parsed || parsed.name !== "RedeemRequested") {
    throw new Error("log is not a RedeemRequested event");
  }

  const txHash = txHashFromLog(log, receipt);
  if (!txHash) {
    throw new Error("log is missing transaction hash");
  }

  return {
    redeemRequestHash: parsed.args.redeemRequestHash,
    blockNumber: blockNumberFromLog(log, receipt),
    blockHash: blockHashFromLog(log, receipt),
    txHash,
    logIndex: logIndex(log),
    requester: parsed.args.requester,
    destinationScriptHash: parsed.args.destinationScriptHash,
    requestNonce: parsed.args.requestNonce.toString(),
    amountSats: parsed.args.amountSats.toString(),
    maxMinerFeeSats: parsed.args.maxMinerFeeSats.toString(),
    deadline: parsed.args.deadline.toString(),
    destinationScriptPubKey: parsed.args.destinationScriptPubKey
  };
}

function findRedeemRequestedLog({ receipt, burnGatewayAddress, logIndex: expectedLogIndex, iface = burnGatewayInterface() }) {
  if (!receipt) {
    throw new Error("transaction receipt not found");
  }

  for (const log of receipt.logs || []) {
    if (!log.address || !logAddressMatches(log, burnGatewayAddress)) {
      continue;
    }
    if (Number(expectedLogIndex) !== logIndex(log)) {
      continue;
    }

    return parseRedeemRequestedLog({ log, receipt, iface });
  }

  throw new Error("RedeemRequested log not found for burn gateway and log index");
}

function assertExpectedEvent(event, { expectedRedeemRequestHash, expectedBlockHash }) {
  if (expectedRedeemRequestHash && event.redeemRequestHash.toLowerCase() !== expectedRedeemRequestHash.toLowerCase()) {
    throw new Error("fetched redeemRequestHash does not match expected value");
  }

  if (expectedBlockHash && event.blockHash.toLowerCase() !== expectedBlockHash.toLowerCase()) {
    throw new Error("fetched blockHash does not match expected value");
  }
}

async function fetchRedeemEventByTxLog({
  provider,
  burnGatewayAddress,
  txHash,
  logIndex: expectedLogIndex,
  expectedRedeemRequestHash,
  expectedBlockHash
}) {
  const receipt = await provider.getTransactionReceipt(txHash);
  const event = findRedeemRequestedLog({
    receipt,
    burnGatewayAddress,
    logIndex: expectedLogIndex
  });
  assertExpectedEvent(event, { expectedRedeemRequestHash, expectedBlockHash });
  return event;
}

module.exports = {
  assertExpectedEvent,
  burnGatewayInterface,
  createProvider,
  fetchRedeemEventByTxLog,
  findRedeemRequestedLog,
  parseRedeemRequestedLog
};
