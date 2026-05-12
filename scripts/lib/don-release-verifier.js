const {
  authorizationDigest,
  redeemId,
  redeemRequestHash,
  releaseStructHash,
  signerSetDigest
} = require("./bridge");
const {
  toReleaseAuthorization,
  verifyReleaseSpendPlan
} = require("./authorization-validator");
const { destinationScriptHash } = require("./evm-redeem-watcher");
const { normalizeSignerAddresses } = require("./attestation-ingest");
const {
  extractNormalizedSpendPlanFromPsbt,
  spendPlanDigest,
  unsignedPsbtDigest
} = require("./bitcoin-psbt");

function assertSameHex(actual, expected, message) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(message);
  }
}

function assertSameInteger(actual, expected, message) {
  if (BigInt(actual) !== BigInt(expected)) {
    throw new Error(message);
  }
}

function assertThreshold(signerAddresses, threshold) {
  if (!Number.isInteger(threshold) || threshold <= 0) {
    throw new Error("threshold must be a positive integer");
  }

  if (threshold > signerAddresses.length) {
    throw new Error("threshold exceeds signer set length");
  }
}

function optionalExpectedInteger(authorizationValue, expectedValue, field, label) {
  if (expectedValue === undefined || expectedValue === null) {
    return false;
  }

  assertSameInteger(authorizationValue, expectedValue, `${field} does not match expected ${label}`);
  return true;
}

function verifyAuthorizationWindow({
  authorization,
  now,
  maxAuthorizationTtlSeconds,
  maxClockSkewSeconds = 60,
  minTimeToDeadlineSeconds = 0
}) {
  const effectiveNow = BigInt(now ?? Math.floor(Date.now() / 1000));
  const attestationTimestamp = BigInt(authorization.attestationTimestamp);
  const deadline = BigInt(authorization.deadline);
  const skew = BigInt(maxClockSkewSeconds);
  const minTimeToDeadline = BigInt(minTimeToDeadlineSeconds);

  if (deadline < attestationTimestamp) {
    throw new Error("release authorization deadline is before attestationTimestamp");
  }

  if (attestationTimestamp > effectiveNow + skew) {
    throw new Error("release authorization attestationTimestamp is too far in the future");
  }

  if (effectiveNow > deadline) {
    throw new Error("release authorization is expired");
  }

  if (deadline - effectiveNow < minTimeToDeadline) {
    throw new Error("release authorization deadline is too close");
  }

  if (maxAuthorizationTtlSeconds !== undefined && maxAuthorizationTtlSeconds !== null) {
    const maxTtl = BigInt(maxAuthorizationTtlSeconds);
    if (deadline - attestationTimestamp > maxTtl) {
      throw new Error("release authorization TTL exceeds local policy");
    }
  }

  return {
    now: effectiveNow.toString(),
    attestationTimestamp: attestationTimestamp.toString(),
    deadline: deadline.toString(),
    ttlSeconds: (deadline - attestationTimestamp).toString(),
    secondsToDeadline: (deadline - effectiveNow).toString()
  };
}

function normalizeRedeemEvent(event) {
  if (!event) {
    return null;
  }

  return {
    redeemRequestHash: event.redeemRequestHash,
    blockNumber: event.blockNumber,
    blockHash: event.blockHash,
    txHash: event.txHash ?? event.burnTxHash,
    logIndex: event.logIndex ?? event.burnLogIndex,
    requester: event.requester,
    destinationScriptHash: event.destinationScriptHash,
    requestNonce: event.requestNonce,
    amountSats: event.amountSats,
    maxMinerFeeSats: event.maxMinerFeeSats,
    deadline: event.deadline,
    destinationScriptPubKey: event.destinationScriptPubKey
  };
}

function requireRedeemEventField(event, field) {
  if (event[field] === undefined || event[field] === null || event[field] === "") {
    throw new Error(`redeem event is missing ${field}`);
  }
}

function compareOptionalField(primary, secondary, field, comparator, message) {
  if (primary[field] === undefined || primary[field] === null || secondary[field] === undefined || secondary[field] === null) {
    return;
  }
  comparator(primary[field], secondary[field], message);
}

function compareRedeemEvents(primary, secondary) {
  assertSameHex(primary.redeemRequestHash, secondary.redeemRequestHash, "secondary redeem event redeemRequestHash disagrees");
  assertSameHex(primary.txHash, secondary.txHash, "secondary redeem event txHash disagrees");
  assertSameInteger(primary.logIndex, secondary.logIndex, "secondary redeem event logIndex disagrees");
  assertSameHex(primary.requester, secondary.requester, "secondary redeem event requester disagrees");
  assertSameHex(
    primary.destinationScriptHash,
    secondary.destinationScriptHash,
    "secondary redeem event destinationScriptHash disagrees"
  );
  assertSameInteger(primary.requestNonce, secondary.requestNonce, "secondary redeem event requestNonce disagrees");
  assertSameInteger(primary.amountSats, secondary.amountSats, "secondary redeem event amountSats disagrees");
  assertSameInteger(primary.maxMinerFeeSats, secondary.maxMinerFeeSats, "secondary redeem event maxMinerFeeSats disagrees");
  assertSameInteger(primary.deadline, secondary.deadline, "secondary redeem event deadline disagrees");
  assertSameHex(
    primary.destinationScriptPubKey,
    secondary.destinationScriptPubKey,
    "secondary redeem event destinationScriptPubKey disagrees"
  );
  compareOptionalField(primary, secondary, "blockNumber", assertSameInteger, "secondary redeem event blockNumber disagrees");
  compareOptionalField(primary, secondary, "blockHash", assertSameHex, "secondary redeem event blockHash disagrees");
}

function verifyRedeemEvent({ authorization, redeemEvent }) {
  const event = normalizeRedeemEvent(redeemEvent);
  if (!event) {
    return null;
  }

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
    "destinationScriptPubKey"
  ]) {
    requireRedeemEventField(event, field);
  }

  const computedDestinationScriptHash = destinationScriptHash(event.destinationScriptPubKey);
  assertSameHex(
    computedDestinationScriptHash,
    event.destinationScriptHash,
    "redeem event destinationScriptPubKey does not hash to destinationScriptHash"
  );

  const computedRedeemRequestHash = redeemRequestHash(authorization.bridgeDomain, {
    requester: event.requester,
    destinationScriptHash: event.destinationScriptHash,
    amountSats: event.amountSats,
    maxMinerFeeSats: event.maxMinerFeeSats,
    deadline: event.deadline,
    requestNonce: event.requestNonce
  });

  assertSameHex(computedRedeemRequestHash, event.redeemRequestHash, "redeem event hash does not match event fields");
  assertSameHex(authorization.redeemRequestHash, event.redeemRequestHash, "authorization redeemRequestHash does not match redeem event");
  assertSameHex(authorization.burnTxHash, event.txHash, "authorization burnTxHash does not match redeem event txHash");
  assertSameInteger(authorization.burnLogIndex, event.logIndex, "authorization burnLogIndex does not match redeem event logIndex");
  assertSameHex(authorization.requester, event.requester, "authorization requester does not match redeem event");
  assertSameHex(
    authorization.destinationScriptHash,
    event.destinationScriptHash,
    "authorization destinationScriptHash does not match redeem event"
  );
  assertSameInteger(authorization.amountSats, event.amountSats, "authorization amountSats does not match redeem event");
  assertSameInteger(
    authorization.maxMinerFeeSats,
    event.maxMinerFeeSats,
    "authorization maxMinerFeeSats does not match redeem event"
  );

  const computedRedeemId = redeemId(
    authorization.bridgeDomain,
    authorization.burnTxHash,
    Number(authorization.burnLogIndex),
    authorization.redeemRequestHash
  );
  assertSameHex(computedRedeemId, authorization.redeemId, "authorization redeemId does not match burn identity");

  return {
    verified: true,
    redeemRequestHash: event.redeemRequestHash,
    redeemId: authorization.redeemId,
    burnTxHash: event.txHash,
    burnLogIndex: String(event.logIndex),
    blockNumber: event.blockNumber ?? null,
    blockHash: event.blockHash ?? null
  };
}

function verifySecondaryRedeemEvent({ authorization, redeemEvent, secondaryRedeemEvent, requireSecondaryRedeemEvent }) {
  if (!secondaryRedeemEvent) {
    if (requireSecondaryRedeemEvent) {
      throw new Error("secondary redeem event is required by local policy");
    }
    return null;
  }

  if (!redeemEvent) {
    throw new Error("primary redeem event is required when secondary redeem event is provided");
  }

  const primary = normalizeRedeemEvent(redeemEvent);
  const secondary = normalizeRedeemEvent(secondaryRedeemEvent);
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
    "destinationScriptPubKey"
  ]) {
    requireRedeemEventField(primary, field);
    requireRedeemEventField(secondary, field);
  }
  compareRedeemEvents(primary, secondary);
  const verified = verifyRedeemEvent({ authorization, redeemEvent: secondary });

  return {
    ...verified,
    source: "secondary"
  };
}

function spendPlanWithKind(spendPlan) {
  return spendPlan.kind
    ? spendPlan
    : {
        kind: "NormalizedSpendPlanV1",
        schemaVersion: "1.0.0",
        ...spendPlan
      };
}

function releaseAuthorizationWithKind(authorization) {
  return authorization.kind
    ? authorization
    : {
        kind: "ReleaseAuthorizationV1",
        schemaVersion: "1.0.0",
        ...authorization
      };
}

function verifySpendPlanInputs({
  authorization,
  spendPlan,
  psbtArtifact,
  bitcoinNetwork,
  requireSpendPlan
}) {
  const summaries = [];
  let derivedSpendPlan = null;

  if (psbtArtifact) {
    if (!bitcoinNetwork) {
      throw new Error("bitcoinNetwork is required when verifying a PSBT");
    }

    derivedSpendPlan = spendPlanWithKind(extractNormalizedSpendPlanFromPsbt(psbtArtifact, bitcoinNetwork));
    verifyReleaseSpendPlan(releaseAuthorizationWithKind(authorization), derivedSpendPlan);
    summaries.push({
      source: "psbt",
      spendPlanDigest: spendPlanDigest(derivedSpendPlan),
      unsignedPsbtDigest: unsignedPsbtDigest(psbtArtifact, bitcoinNetwork),
      inputCount: derivedSpendPlan.inputs.length,
      outputCount: derivedSpendPlan.outputs.length,
      feeSats: derivedSpendPlan.feeSats
    });
  }

  if (spendPlan) {
    const normalizedSpendPlan = spendPlanWithKind(spendPlan);
    verifyReleaseSpendPlan(releaseAuthorizationWithKind(authorization), normalizedSpendPlan);

    if (derivedSpendPlan) {
      const derivedDigest = spendPlanDigest(derivedSpendPlan);
      const providedDigest = spendPlanDigest(normalizedSpendPlan);
      if (derivedDigest !== providedDigest) {
        throw new Error("provided spend plan does not match PSBT-derived spend plan");
      }
    }

    summaries.push({
      source: "spendPlan",
      spendPlanDigest: spendPlanDigest(normalizedSpendPlan),
      inputCount: normalizedSpendPlan.inputs.length,
      outputCount: normalizedSpendPlan.outputs.length,
      feeSats: normalizedSpendPlan.feeSats
    });
  }

  if (requireSpendPlan && summaries.length === 0) {
    throw new Error("spend plan or PSBT is required for DON release verification");
  }

  return summaries;
}

function verifySignerSet({ authorization, signerAddresses, threshold }) {
  if (signerAddresses === undefined && threshold === undefined) {
    return null;
  }

  if (!signerAddresses || threshold === undefined) {
    throw new Error("signerAddresses and threshold must be provided together");
  }

  const normalizedSigners = normalizeSignerAddresses(signerAddresses);
  assertThreshold(normalizedSigners, Number(threshold));
  const signerDigest = signerSetDigest(normalizedSigners, Number(threshold));
  const structHash = releaseStructHash(authorization);

  return {
    signerSetDigest: signerDigest,
    releaseStructHash: structHash,
    messageDigest: authorizationDigest(authorization.bridgeDomain, structHash, signerDigest),
    threshold: Number(threshold),
    signerCount: normalizedSigners.length
  };
}

function verifyDonReleaseRequest({
  authorization,
  redeemEvent,
  secondaryRedeemEvent,
  spendPlan,
  psbtArtifact,
  bitcoinNetwork,
  expectedBridgeDomain,
  expectedBtcNetwork,
  expectedSourceEvmChainId,
  signerAddresses,
  threshold,
  now,
  maxAuthorizationTtlSeconds,
  maxClockSkewSeconds,
  minTimeToDeadlineSeconds,
  requireSecondaryRedeemEvent = false,
  requireSpendPlan = false
}) {
  const releaseAuthorization = toReleaseAuthorization(authorization);

  const localPolicy = {
    bridgeDomain: false,
    btcNetwork: optionalExpectedInteger(
      releaseAuthorization.btcNetwork,
      expectedBtcNetwork,
      "btcNetwork",
      "BTC network"
    ),
    sourceEvmChainId: optionalExpectedInteger(
      releaseAuthorization.sourceEvmChainId,
      expectedSourceEvmChainId,
      "sourceEvmChainId",
      "source EVM chain"
    )
  };

  if (expectedBridgeDomain !== undefined && expectedBridgeDomain !== null) {
    assertSameHex(releaseAuthorization.bridgeDomain, expectedBridgeDomain, "bridgeDomain does not match expected bridge domain");
    localPolicy.bridgeDomain = true;
  }

  const timeWindow = verifyAuthorizationWindow({
    authorization: releaseAuthorization,
    now,
    maxAuthorizationTtlSeconds,
    maxClockSkewSeconds,
    minTimeToDeadlineSeconds
  });
  const event = verifyRedeemEvent({ authorization: releaseAuthorization, redeemEvent });
  const secondaryEvent = verifySecondaryRedeemEvent({
    authorization: releaseAuthorization,
    redeemEvent,
    secondaryRedeemEvent,
    requireSecondaryRedeemEvent
  });
  const spendPlans = verifySpendPlanInputs({
    authorization: releaseAuthorization,
    spendPlan,
    psbtArtifact,
    bitcoinNetwork,
    requireSpendPlan
  });
  const signerSet = verifySignerSet({
    authorization: releaseAuthorization,
    signerAddresses,
    threshold
  });
  const structHash = releaseStructHash(releaseAuthorization);

  return {
    kind: "DonReleaseVerificationV1",
    schemaVersion: "1.0.0",
    signable: true,
    redeemRequestHash: releaseAuthorization.redeemRequestHash,
    redeemId: releaseAuthorization.redeemId,
    releaseStructHash: structHash,
    signerSetDigest: signerSet ? signerSet.signerSetDigest : null,
    messageDigest: signerSet ? signerSet.messageDigest : null,
    checks: {
      authorizationSchema: true,
      localPolicy,
      timeWindow,
      redeemEvent: event,
      secondaryRedeemEvent: secondaryEvent,
      spendPlans,
      signerSet
    }
  };
}

module.exports = {
  verifyDonReleaseRequest,
  verifyRedeemEvent,
  verifyAuthorizationWindow
};
