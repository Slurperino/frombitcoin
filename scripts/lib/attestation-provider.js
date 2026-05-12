const { Wallet } = require("ethers");
const { toReleaseAuthorization } = require("./authorization-validator");
const { buildAttestation } = require("./bridge");
const { verifyDonReleaseRequest } = require("./don-release-verifier");
const { normalizedReleaseAuthorizationForContract } = require("./evm-redeem-watcher");

function parsePrivateKeys(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function walletsFromPrivateKeys(privateKeys, provider) {
  return privateKeys.map((privateKey) => new Wallet(privateKey, provider));
}

function assertSignerSet(signerWallets, threshold) {
  if (!Number.isInteger(threshold) || threshold <= 0) {
    throw new Error("threshold must be a positive integer");
  }

  if (signerWallets.length < threshold) {
    throw new Error("threshold exceeds DON signer count");
  }

  const addresses = signerWallets.map((wallet) => wallet.address.toLowerCase());
  if (new Set(addresses).size !== addresses.length) {
    throw new Error("DON signer set contains duplicate addresses");
  }
}

async function buildReleaseAttestation({ authorization, signerWallets, threshold, redeemEvent, now }) {
  assertSignerSet(signerWallets, threshold);
  verifyDonReleaseRequest({
    authorization,
    redeemEvent,
    signerAddresses: signerWallets.map((wallet) => wallet.address),
    threshold,
    now,
    requireSpendPlan: false
  });

  const releaseAuthorization = toReleaseAuthorization(authorization);
  const contractAuthorization = normalizedReleaseAuthorizationForContract(releaseAuthorization);
  const signed = await buildAttestation({
    bridgeDomain: contractAuthorization.bridgeDomain,
    authorization: contractAuthorization,
    kind: "release",
    signerWallets,
    threshold
  });

  return {
    contractAuthorization,
    attestation: signed.attestation,
    signerSetDigest: signed.signerSetDigest,
    messageDigest: signed.messageDigest
  };
}

async function attestAuthorizedRedeems({
  store,
  signerWallets,
  threshold,
  limit = 100,
  now = Math.floor(Date.now() / 1000)
}) {
  assertSignerSet(signerWallets, threshold);

  const events = store.listAttestationEligible(limit);
  const results = [];

  for (const event of events) {
    try {
      store.markAttestationRequested(event.redeemRequestHash, now);
      const signed = await buildReleaseAttestation({
        authorization: event.releaseAuthorization,
        signerWallets,
        threshold,
        redeemEvent: event,
        now
      });

      store.markAttested(event.redeemRequestHash, signed, now);
      results.push({
        redeemRequestHash: event.redeemRequestHash,
        redeemId: signed.contractAuthorization.redeemId,
        signerSetDigest: signed.signerSetDigest,
        messageDigest: signed.messageDigest
      });
    } catch (error) {
      store.markError(event.redeemRequestHash, error);
      throw error;
    }
  }

  return results;
}

module.exports = {
  attestAuthorizedRedeems,
  buildReleaseAttestation,
  parsePrivateKeys,
  walletsFromPrivateKeys
};
