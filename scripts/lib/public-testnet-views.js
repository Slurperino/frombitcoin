"use strict";

const DEPOSIT_STATUS = {
  intent_created: "awaiting_bitcoin_deposit",
  btc_observed: "bitcoin_deposit_observed",
  mint_requested: "external_authorization_requested",
  minted: "mint_confirmed",
  failed: "operator_review_required"
};

const REDEEM_STATUS = {
  observed: "burn_observed",
  release_prepared: "release_plan_prepared",
  release_requested: "external_authorization_requested",
  redeem_submitted: "evm_completion_submitted",
  redeem_completed: "evm_completion_confirmed",
  btc_broadcast: "bitcoin_broadcast",
  failed: "operator_review_required"
};

function publicDepositStatus(deposit) {
  return DEPOSIT_STATUS[deposit && deposit.status] || "operator_review_required";
}

function publicRedeemStatus(redeem) {
  if (!redeem) {
    return "operator_review_required";
  }
  if (redeem.status === "redeem_completed" && redeem.bitcoinTxHex && !redeem.bitcoinTxId) {
    return "bitcoin_broadcast_retrying";
  }
  return REDEEM_STATUS[redeem.status] || "operator_review_required";
}

function publicErrorCategory(error) {
  if (!error) {
    return null;
  }
  const message = String(error).toLowerCase();
  if (message.includes("deadline") || message.includes("expired")) {
    return "expired";
  }
  if (message.includes("limit") || message.includes("cap") || message.includes("policy") || message.includes("unsupported")) {
    return "policy_rejected";
  }
  if (message.includes("rate")) {
    return "rate_limited";
  }
  if (message.includes("timeout") || message.includes("rpc") || message.includes("network")) {
    return "external_service_unavailable";
  }
  if (message.includes("rejected") || message.includes("reverted")) {
    return "authorization_or_transaction_rejected";
  }
  return "operator_review_required";
}

function toPublicDeposit(deposit) {
  if (!deposit) {
    return null;
  }
  return omitNullish({
    depositId: deposit.depositId,
    status: publicDepositStatus(deposit),
    recipient: deposit.recipient,
    depositAddress: deposit.depositAddress,
    expectedSats: deposit.expectedSats,
    expiry: deposit.expiry,
    createIntentTxHash: deposit.createIntentTxHash,
    createIntentBlockNumber: deposit.createIntentBlockNumber,
    btcTxId: deposit.btcTxId,
    btcVout: deposit.btcVout,
    btcSats: deposit.btcSats,
    btcConfirmations: deposit.btcConfirmations,
    mintRequestTxHash: deposit.mintRequestTxHash,
    mintTxHash: deposit.mintTxHash,
    mintBlockNumber: deposit.mintBlockNumber,
    createdAt: deposit.createdAt,
    updatedAt: deposit.updatedAt,
    errorCategory: publicErrorCategory(deposit.error)
  });
}

function toPublicRedeem(redeem) {
  if (!redeem) {
    return null;
  }
  return omitNullish({
    redeemRequestHash: redeem.redeemRequestHash,
    status: publicRedeemStatus(redeem),
    requester: redeem.requester,
    burnTxHash: redeem.txHash,
    txHash: redeem.txHash,
    blockNumber: redeem.blockNumber,
    logIndex: redeem.logIndex,
    amountSats: redeem.amountSats,
    maxMinerFeeSats: redeem.maxMinerFeeSats,
    deadline: redeem.deadline,
    releaseRequestTxHash: redeem.releaseRequestTxHash,
    completeRedeemTxHash: redeem.completeRedeemTxHash,
    completeRedeemBlockNumber: redeem.completeRedeemBlockNumber,
    bitcoinTxId: redeem.bitcoinTxId,
    observedAt: redeem.observedAt,
    updatedAt: redeem.updatedAt,
    errorCategory: publicErrorCategory(redeem.error)
  });
}

function toPublicDepositList(deposits) {
  return deposits.map(toPublicDeposit);
}

function toPublicRedeemList(redeems) {
  return redeems.map(toPublicRedeem);
}

function toPublicDepositCounts(counts) {
  return mapCounts(counts, (status) => publicDepositStatus({ status }));
}

function toPublicRedeemCounts(counts) {
  return mapCounts(counts, (status) => publicRedeemStatus({ status }));
}

function mapCounts(counts, mapper) {
  const result = {};
  for (const [status, count] of Object.entries(counts || {})) {
    const publicStatus = mapper(status);
    result[publicStatus] = (result[publicStatus] || 0) + Number(count);
  }
  return result;
}

function omitNullish(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

module.exports = {
  publicDepositStatus,
  publicErrorCategory,
  publicRedeemStatus,
  toPublicDeposit,
  toPublicDepositCounts,
  toPublicDepositList,
  toPublicRedeem,
  toPublicRedeemCounts,
  toPublicRedeemList
};
