const { AbiCoder, getAddress, getBytes, verifyMessage } = require("ethers");
const {
  toReleaseAttestation,
  toReleaseAuthorization
} = require("./authorization-validator");
const {
  authorizationDigest,
  releaseStructHash,
  signerSetDigest
} = require("./bridge");
const { normalizedReleaseAuthorizationForContract } = require("./evm-redeem-watcher");
const { STATUS_CONSUMED } = require("./redeem-store");

const abiCoder = AbiCoder.defaultAbiCoder();

function normalizeSignerAddresses(addresses) {
  const normalized = addresses
    .map((address) => getAddress(address))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const lower = normalized.map((address) => address.toLowerCase());
  if (new Set(lower).size !== lower.length) {
    throw new Error("signer set contains duplicate addresses");
  }

  return normalized;
}

function parseSignerAddresses(value) {
  return normalizeSignerAddresses(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function assertThreshold(signerAddresses, threshold) {
  if (!Number.isInteger(threshold) || threshold <= 0) {
    throw new Error("threshold must be a positive integer");
  }

  if (threshold > signerAddresses.length) {
    throw new Error("threshold exceeds signer set length");
  }
}

function decodeAttestation(attestation) {
  const [decodedSignerSetDigest, signatures] = abiCoder.decode(["bytes32", "bytes[]"], attestation);
  return {
    signerSetDigest: decodedSignerSetDigest,
    signatures: Array.from(signatures)
  };
}

function verifyReleaseAttestationEnvelope({
  authorization,
  envelope,
  signerAddresses,
  threshold,
  now
}) {
  const releaseAuthorization = toReleaseAuthorization(authorization);
  const releaseAttestation = toReleaseAttestation(envelope);
  const normalizedSigners = normalizeSignerAddresses(signerAddresses);
  assertThreshold(normalizedSigners, threshold);

  if (releaseAttestation.redeemRequestHash !== releaseAuthorization.redeemRequestHash) {
    throw new Error("release attestation redeemRequestHash does not match stored authorization");
  }

  const contractAuthorization = normalizedReleaseAuthorizationForContract(releaseAuthorization);
  if (now !== undefined && BigInt(now) > BigInt(contractAuthorization.deadline)) {
    throw new Error("release attestation authorization is expired");
  }

  const expectedSignerSetDigest = signerSetDigest(normalizedSigners, threshold);
  if (releaseAttestation.signerSetDigest !== expectedSignerSetDigest) {
    throw new Error("release attestation signerSetDigest does not match configured signer set");
  }

  const decoded = decodeAttestation(releaseAttestation.attestation);
  if (decoded.signerSetDigest !== releaseAttestation.signerSetDigest) {
    throw new Error("encoded attestation signerSetDigest does not match envelope");
  }

  const expectedMessageDigest = authorizationDigest(
    contractAuthorization.bridgeDomain,
    releaseStructHash(contractAuthorization),
    expectedSignerSetDigest
  );
  if (releaseAttestation.messageDigest !== expectedMessageDigest) {
    throw new Error("release attestation messageDigest does not match authorization");
  }

  if (decoded.signatures.length < threshold) {
    throw new Error("release attestation has fewer signatures than threshold");
  }

  const authorized = new Set(normalizedSigners.map((address) => address.toLowerCase()));
  const recovered = new Set();

  for (const signature of decoded.signatures) {
    const signer = getAddress(verifyMessage(getBytes(expectedMessageDigest), signature));
    const lowerSigner = signer.toLowerCase();
    if (!authorized.has(lowerSigner)) {
      throw new Error("release attestation contains unauthorized signer");
    }

    if (recovered.has(lowerSigner)) {
      throw new Error("release attestation contains duplicate signer signature");
    }

    recovered.add(lowerSigner);
  }

  if (recovered.size < threshold) {
    throw new Error("release attestation has insufficient valid signatures");
  }

  return {
    contractAuthorization,
    attestation: releaseAttestation.attestation,
    signerSetDigest: releaseAttestation.signerSetDigest,
    messageDigest: releaseAttestation.messageDigest,
    signerCount: recovered.size
  };
}

function releaseAttestationEnvelope({ redeemRequestHash, signed }) {
  return {
    kind: "ReleaseAttestationV1",
    schemaVersion: "1.0.0",
    redeemRequestHash,
    signerSetDigest: signed.signerSetDigest,
    messageDigest: signed.messageDigest,
    attestation: signed.attestation
  };
}

function ingestReleaseAttestation({
  store,
  envelope,
  signerAddresses,
  threshold,
  now = Math.floor(Date.now() / 1000)
}) {
  const releaseAttestation = toReleaseAttestation(envelope);
  const event = store.getRedeemEvent(releaseAttestation.redeemRequestHash);
  if (!event) {
    throw new Error("redeem event not found for release attestation");
  }

  if (!event.releaseAuthorization) {
    throw new Error("redeem event is missing release authorization");
  }

  if (event.status === STATUS_CONSUMED) {
    throw new Error("redeem event is already consumed");
  }

  const verified = verifyReleaseAttestationEnvelope({
    authorization: event.releaseAuthorization,
    envelope,
    signerAddresses,
    threshold,
    now
  });

  store.markAttested(
    releaseAttestation.redeemRequestHash,
    {
      attestation: verified.attestation,
      signerSetDigest: verified.signerSetDigest,
      messageDigest: verified.messageDigest
    },
    now
  );

  return {
    redeemRequestHash: releaseAttestation.redeemRequestHash,
    redeemId: verified.contractAuthorization.redeemId,
    signerSetDigest: verified.signerSetDigest,
    messageDigest: verified.messageDigest,
    signerCount: verified.signerCount
  };
}

module.exports = {
  decodeAttestation,
  ingestReleaseAttestation,
  normalizeSignerAddresses,
  parseSignerAddresses,
  releaseAttestationEnvelope,
  verifyReleaseAttestationEnvelope
};
