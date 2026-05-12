const { Contract, JsonRpcProvider, keccak256 } = require("ethers");
const { loadArtifact } = require("./artifacts");
const { redeemId } = require("./bridge");
const { spendPlanCommitments, verifyReleaseSpendPlan } = require("./authorization-validator");

function createProvider(rpcUrl) {
  return new JsonRpcProvider(rpcUrl);
}

function createBurnGateway(provider, address) {
  const artifact = loadArtifact("BurnGateway");
  return new Contract(address, artifact.abi, provider);
}

function logToRedeemEvent(log) {
  return {
    redeemRequestHash: log.args.redeemRequestHash,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    txHash: log.transactionHash,
    logIndex: Number(log.index),
    requester: log.args.requester,
    destinationScriptHash: log.args.destinationScriptHash,
    requestNonce: log.args.requestNonce.toString(),
    amountSats: log.args.amountSats.toString(),
    maxMinerFeeSats: log.args.maxMinerFeeSats.toString(),
    deadline: log.args.deadline.toString(),
    destinationScriptPubKey: log.args.destinationScriptPubKey
  };
}

async function scanRedeemRequests({ burnGateway, store, fromBlock, toBlock }) {
  const logs = await burnGateway.queryFilter(
    burnGateway.filters.RedeemRequested(),
    fromBlock,
    toBlock
  );

  const events = logs.map(logToRedeemEvent);
  for (const event of events) {
    store.upsertRedeemEvent(event);
  }

  return events;
}

async function readBridgeConfig(burnGateway) {
  const [bridgeDomain, btcNetwork, sourceEvmChainId] = await Promise.all([
    burnGateway.bridgeDomain(),
    burnGateway.btcNetwork(),
    burnGateway.sourceEvmChainId()
  ]);

  return {
    bridgeDomain,
    btcNetwork: Number(btcNetwork),
    sourceEvmChainId: Number(sourceEvmChainId)
  };
}

function buildReleaseAuthorization({ event, bridgeConfig, spendPlan, changePolicyHash, now, ttlSeconds }) {
  const commitments = spendPlanCommitments(spendPlan, changePolicyHash);
  const burnLogIndex = Number(event.logIndex);
  const authorization = {
    kind: "ReleaseAuthorizationV1",
    schemaVersion: "1.0.0",
    bridgeDomain: bridgeConfig.bridgeDomain,
    redeemRequestHash: event.redeemRequestHash,
    redeemId: redeemId(bridgeConfig.bridgeDomain, event.txHash, burnLogIndex, event.redeemRequestHash),
    btcNetwork: String(bridgeConfig.btcNetwork),
    sourceEvmChainId: String(bridgeConfig.sourceEvmChainId),
    burnTxHash: event.txHash,
    burnLogIndex: String(burnLogIndex),
    requester: event.requester,
    destinationScriptHash: event.destinationScriptHash,
    amountSats: event.amountSats,
    maxMinerFeeSats: event.maxMinerFeeSats,
    changePolicyHash,
    inputsCommitment: commitments.inputsCommitment,
    outputsCommitment: commitments.outputsCommitment,
    psbtPolicyHash: commitments.psbtPolicyHash,
    attestationTimestamp: String(now),
    deadline: String(now + ttlSeconds)
  };

  verifyReleaseSpendPlan(authorization, spendPlan);
  return authorization;
}

async function authorizeFinalizedRedeems({
  provider,
  burnGateway,
  store,
  finalityBlocks,
  spendPlan,
  changePolicyHash,
  ttlSeconds,
  latestBlockNumber,
  now = Math.floor(Date.now() / 1000)
}) {
  const bridgeConfig = await readBridgeConfig(burnGateway);
  const effectiveLatestBlockNumber = latestBlockNumber ?? (await provider.getBlock("latest")).number;
  const eligibleEvents = store.listFinalityEligible(effectiveLatestBlockNumber, finalityBlocks);
  const authorizations = [];

  for (const event of eligibleEvents) {
    try {
      const currentBlock = await provider.getBlock(event.blockNumber);
      if (!currentBlock || currentBlock.hash !== event.blockHash) {
        throw new Error("redeem event block hash changed before finality");
      }

      const authorization = buildReleaseAuthorization({
        event,
        bridgeConfig,
        spendPlan,
        changePolicyHash,
        now,
        ttlSeconds
      });
      store.markAuthorized(event.redeemRequestHash, authorization, now);
      authorizations.push(authorization);
    } catch (error) {
      store.markError(event.redeemRequestHash, error);
      throw error;
    }
  }

  return authorizations;
}

function normalizedReleaseAuthorizationForContract(authorization) {
  return {
    bridgeDomain: authorization.bridgeDomain,
    redeemRequestHash: authorization.redeemRequestHash,
    redeemId: authorization.redeemId,
    btcNetwork: authorization.btcNetwork,
    sourceEvmChainId: authorization.sourceEvmChainId,
    burnTxHash: authorization.burnTxHash,
    burnLogIndex: authorization.burnLogIndex,
    requester: authorization.requester,
    destinationScriptHash: authorization.destinationScriptHash,
    amountSats: authorization.amountSats,
    maxMinerFeeSats: authorization.maxMinerFeeSats,
    changePolicyHash: authorization.changePolicyHash,
    inputsCommitment: authorization.inputsCommitment,
    outputsCommitment: authorization.outputsCommitment,
    psbtPolicyHash: authorization.psbtPolicyHash,
    attestationTimestamp: authorization.attestationTimestamp,
    deadline: authorization.deadline
  };
}

function destinationScriptHash(destinationScriptPubKey) {
  return keccak256(destinationScriptPubKey);
}

module.exports = {
  authorizeFinalizedRedeems,
  buildReleaseAuthorization,
  createBurnGateway,
  createProvider,
  destinationScriptHash,
  logToRedeemEvent,
  normalizedReleaseAuthorizationForContract,
  readBridgeConfig,
  scanRedeemRequests
};
