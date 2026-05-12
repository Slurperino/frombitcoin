const { verifyReleaseSpendPlan } = require("./authorization-validator");

function buildPublicTestnetReconciliationReport({
  config,
  store,
  totalSupplySats = null,
  now = unixNow(),
  staleSeconds = 3600,
  integrityLimit = 500
}) {
  const stats = store.reconciliationStats({ now, staleSeconds });
  const failures = [];
  const warnings = [];

  if (stats.releaseArtifactsMissing > 0) {
    failures.push({
      code: "release_artifacts_missing",
      message: `${stats.releaseArtifactsMissing} release rows are missing spend plan or authorization artifacts`
    });
  }

  if (config.bitcoin.custodyController === "chainlink-don" && stats.donMissingFinalizedTxs > 0) {
    failures.push({
      code: "don_finalized_tx_missing",
      message: `${stats.donMissingFinalizedTxs} DON-custody release rows are missing finalized Bitcoin transactions`
    });
  }

  const integrityFailures = verifyReleaseIntegrity({ store, limit: integrityLimit });
  failures.push(...integrityFailures);

  const staleStatuses = Object.entries(stats.staleRedeems);
  if (staleStatuses.length > 0) {
    warnings.push({
      code: "stale_redeems",
      message: staleStatuses.map(([status, count]) => `${status}:${count}`).join(", ")
    });
  }

  if (totalSupplySats !== null && totalSupplySats !== undefined) {
    const knownNetSupply = BigInt(stats.knownNetSupplySats);
    const onchainSupply = BigInt(totalSupplySats);
    if (knownNetSupply !== onchainSupply) {
      warnings.push({
        code: "known_supply_mismatch",
        message: `known indexed net supply ${knownNetSupply} sats differs from onchain totalSupply ${onchainSupply} sats`
      });
    }
  }

  return {
    ok: failures.length === 0,
    checkedAt: now,
    custodyController: config.bitcoin.custodyController,
    stats,
    totalSupplySats: totalSupplySats === null || totalSupplySats === undefined ? null : String(totalSupplySats),
    failures,
    warnings
  };
}

function verifyReleaseIntegrity({ store, limit }) {
  const failures = [];
  const candidates = store.listReleaseIntegrityCandidates(limit);
  for (const redeem of candidates) {
    try {
      verifyReleaseSpendPlan(redeem.releaseAuthorization, redeem.spendPlan);
    } catch (error) {
      failures.push({
        code: "release_spend_plan_mismatch",
        redeemRequestHash: redeem.redeemRequestHash,
        message: error.message
      });
    }
  }
  return failures;
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

module.exports = {
  buildPublicTestnetReconciliationReport,
  verifyReleaseIntegrity
};
