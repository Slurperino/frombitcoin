const fs = require("fs");
const path = require("path");
const { AbiCoder, isHexString } = require("ethers");
const { ROOT } = require("./paths");
const { buildFunctionsRequestCBOR } = require("./chainlink-functions-request");
const { toMintAuthorization } = require("./authorization-validator");
const { normalizedReleaseAuthorizationForContract } = require("./evm-redeem-watcher");
const { mintStructHash, releaseStructHash } = require("./bridge");

const abiCoder = AbiCoder.defaultAbiCoder();

function loadFunctionsSource(name) {
  return fs.readFileSync(path.join(ROOT, "chainlink/functions", name), "utf8");
}

function buildMintAuthorization({ config, deposit, now }) {
  if (!deposit.btcTxId || deposit.btcVout === null || deposit.btcVout === undefined) {
    throw new Error("deposit has no observed Bitcoin UTXO");
  }
  if (!deposit.btcSats || deposit.btcConfirmations === null || deposit.btcConfirmations === undefined) {
    throw new Error("deposit observation is incomplete");
  }
  if (!deposit.btcObservedBlockHeight) {
    throw new Error("deposit observation has no observed block height");
  }

  const deadline = now + config.deposits.authorizationTtlSeconds;
  return {
    kind: "MintAuthorizationV1",
    schemaVersion: "1.0.0",
    bridgeDomain: config.evm.bridgeDomain,
    depositId: deposit.depositId,
    recipient0x: deposit.recipient,
    btcNetwork: config.bitcoin.btcNetwork,
    depositAddressHash: deposit.depositAddressHash,
    btcTxId: normalizeBytes32TxId(deposit.btcTxId),
    vout: String(deposit.btcVout),
    sats: String(deposit.btcSats),
    confirmations: String(deposit.btcConfirmations),
    observedBlockHeight: String(deposit.btcObservedBlockHeight),
    attestationTimestamp: String(now),
    deadline: String(deadline)
  };
}

function buildMintAuthorizationRequest({ config, source, authorization, depositAddress }) {
  const contractAuthorization = toMintAuthorization(authorization);
  const structHash = mintStructHash(contractAuthorization);
  const requestData = buildFunctionsRequestCBOR({
    source,
    args: [
      config.chainlink.primaryBitcoinApi,
      config.chainlink.secondaryBitcoinApi,
      String(config.chainlink.minConfirmations),
      JSON.stringify(authorization),
      depositAddress,
      structHash
    ]
  });

  return {
    contractAuthorization,
    requestData,
    structHash
  };
}

function buildReleaseAuthorizationRequest({ config, source, authorization, spendPlan }) {
  const contractAuthorization = normalizedReleaseAuthorizationForContract(authorization);
  const structHash = releaseStructHash(contractAuthorization);
  const requestData = buildFunctionsRequestCBOR({
    source,
    args: [
      config.chainlink.adapterUrl,
      config.evm.primaryRpcUrl,
      config.evm.secondaryRpcUrl,
      config.evm.burnGateway,
      String(config.chainlink.releaseFinalityBlocks),
      JSON.stringify(authorization),
      JSON.stringify(spendPlan),
      structHash
    ]
  });

  return {
    contractAuthorization,
    requestData,
    structHash
  };
}

async function requestMintAuthorization({ verifier, requestData, contractAuthorization }) {
  const tx = await verifier.requestMintAuthorization(requestData, contractAuthorization);
  const receipt = await tx.wait();
  return {
    requestId: requestIdFromReceipt(verifier, receipt),
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber
  };
}

async function requestReleaseAuthorization({ verifier, requestData, contractAuthorization }) {
  const tx = await verifier.requestReleaseAuthorization(requestData, contractAuthorization);
  const receipt = await tx.wait();
  return {
    requestId: requestIdFromReceipt(verifier, receipt),
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber
  };
}

function requestIdFromReceipt(verifier, receipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = verifier.interface.parseLog(log);
      if (parsed && parsed.name === "ChainlinkAuthorizationRequested") {
        return parsed.args.requestId;
      }
    } catch {
      // Ignore logs emitted by the Chainlink router.
    }
  }

  throw new Error("ChainlinkAuthorizationRequested event not found in receipt");
}

function normalizePendingRequest(pending) {
  return {
    kind: Number(pending.kind ?? pending[0]),
    structHash: pending.structHash ?? pending[1],
    requester: pending.requester ?? pending[2],
    deadline: (pending.deadline ?? pending[3]).toString(),
    exists: Boolean(pending.exists ?? pending[4]),
    fulfilled: Boolean(pending.fulfilled ?? pending[5]),
    approved: Boolean(pending.approved ?? pending[6])
  };
}

function chainlinkAttestation(requestId) {
  if (!isHexString(requestId, 32)) {
    throw new Error("requestId must be bytes32 hex");
  }
  return abiCoder.encode(["bytes32"], [requestId]);
}

function normalizeBytes32TxId(value) {
  const raw = String(value).startsWith("0x") ? String(value) : `0x${value}`;
  if (!isHexString(raw, 32)) {
    throw new Error(`invalid Bitcoin txid: ${value}`);
  }
  return raw.toLowerCase();
}

module.exports = {
  buildMintAuthorization,
  buildMintAuthorizationRequest,
  buildReleaseAuthorizationRequest,
  chainlinkAttestation,
  loadFunctionsSource,
  normalizePendingRequest,
  requestMintAuthorization,
  requestReleaseAuthorization
};
