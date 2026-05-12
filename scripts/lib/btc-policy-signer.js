const { toBitcoinPsbt, verifyReleaseSpendPlan } = require("./authorization-validator");
const { verifyReleaseAttestationEnvelope } = require("./attestation-ingest");
const {
  extractNormalizedSpendPlanFromPsbt,
  signPsbtWithWif,
  spendPlanDigest,
  unsignedPsbtDigest
} = require("./bitcoin-psbt");

function assertExpected(value, expected, label) {
  if (expected !== undefined && String(value) !== String(expected)) {
    throw new Error(`${label} does not match local signer configuration`);
  }
}

function verifyPsbtSigningPolicy({
  authorization,
  attestation,
  psbtArtifact,
  bitcoinNetwork,
  signerAddresses,
  threshold,
  expectedBridgeDomain,
  expectedBtcNetwork,
  now
}) {
  const psbt = toBitcoinPsbt(psbtArtifact);
  const verifiedAttestation = verifyReleaseAttestationEnvelope({
    authorization,
    envelope: attestation,
    signerAddresses,
    threshold,
    now
  });

  assertExpected(verifiedAttestation.contractAuthorization.bridgeDomain, expectedBridgeDomain, "bridgeDomain");
  assertExpected(verifiedAttestation.contractAuthorization.btcNetwork, expectedBtcNetwork, "btcNetwork");

  if (BigInt(psbt.btcNetwork) !== BigInt(verifiedAttestation.contractAuthorization.btcNetwork)) {
    throw new Error("PSBT artifact btcNetwork does not match release authorization btcNetwork");
  }

  const derivedSpendPlan = extractNormalizedSpendPlanFromPsbt(psbtArtifact, bitcoinNetwork);
  const spendPlanVerification = verifyReleaseSpendPlan(authorization, {
    kind: "NormalizedSpendPlanV1",
    schemaVersion: "1.0.0",
    ...derivedSpendPlan
  });

  const derivedSpendPlanDigest = spendPlanDigest(derivedSpendPlan);
  const derivedUnsignedPsbtDigest = unsignedPsbtDigest(psbtArtifact, bitcoinNetwork);

  return {
    contractAuthorization: verifiedAttestation.contractAuthorization,
    signerSetDigest: verifiedAttestation.signerSetDigest,
    authorizationDigest: verifiedAttestation.messageDigest,
    spendPlan: derivedSpendPlan,
    spendPlanDigest: derivedSpendPlanDigest,
    unsignedPsbtDigest: derivedUnsignedPsbtDigest,
    destinationOutput: spendPlanVerification.destinationOutput
  };
}

function signReleasePsbt({
  store,
  authorization,
  attestation,
  psbtArtifact,
  bitcoinNetwork,
  signerAddresses,
  threshold,
  expectedBridgeDomain,
  expectedBtcNetwork,
  wif,
  finalize = true,
  dryRun = false,
  now = Math.floor(Date.now() / 1000)
}) {
  const policy = verifyPsbtSigningPolicy({
    authorization,
    attestation,
    psbtArtifact,
    bitcoinNetwork,
    signerAddresses,
    threshold,
    expectedBridgeDomain,
    expectedBtcNetwork,
    now
  });

  const reservation = store.reserveSigning({
    redeemId: policy.contractAuthorization.redeemId,
    authorizationDigest: policy.authorizationDigest,
    spendPlanDigest: policy.spendPlanDigest,
    unsignedPsbtDigest: policy.unsignedPsbtDigest,
    reservedAt: now
  });

  if (reservation.status === "already_signed") {
    return {
      status: "already_signed",
      policy,
      decision: reservation.decision
    };
  }

  if (dryRun) {
    return {
      status: "reserved",
      policy,
      decision: reservation.decision
    };
  }

  try {
    const signed = signPsbtWithWif({
      psbtArtifact,
      networkName: bitcoinNetwork,
      wif,
      finalize
    });

    const decision = store.markSigned({
      redeemId: policy.contractAuthorization.redeemId,
      signedPsbtBase64: signed.signedPsbtBase64,
      txHex: signed.txHex,
      txid: signed.txid,
      signedAt: now
    });

    return {
      status: "signed",
      policy,
      decision,
      signed
    };
  } catch (error) {
    store.markError(policy.contractAuthorization.redeemId, error);
    throw error;
  }
}

module.exports = {
  signReleasePsbt,
  verifyPsbtSigningPolicy
};
