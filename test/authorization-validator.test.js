const test = require("node:test");
const assert = require("node:assert/strict");
const { keccak256, toUtf8Bytes, Wallet } = require("ethers");

const {
  spendPlanCommitments,
  toMintAuthorization,
  verifyReleaseSpendPlan
} = require("../scripts/lib/authorization-validator");
const { buildAttestation, releaseStructHash } = require("../scripts/lib/bridge");
const {
  releaseAttestationEnvelope,
  verifyReleaseAttestationEnvelope
} = require("../scripts/lib/attestation-ingest");

function makeSpendPlan(overrides = {}) {
  return {
    kind: "NormalizedSpendPlanV1",
    schemaVersion: "1.0.0",
    btcNetwork: "1",
    inputs: [
      {
        btcTxId: "0x" + "11".repeat(32),
        vout: "0",
        valueSats: "90000",
        scriptTemplateId: keccak256(toUtf8Bytes("p2wpkh-treasury-v1"))
      }
    ],
    outputs: [
      {
        scriptPubKeyHex: "0x0014" + "22".repeat(20),
        valueSats: "80000"
      },
      {
        scriptPubKeyHex: "0x0014" + "33".repeat(20),
        valueSats: "9500"
      }
    ],
    feeSats: "500",
    nVersion: "2",
    nLockTime: "0",
    sighashType: "1",
    ...overrides
  };
}

function makeReleaseAuthorization(spendPlan, overrides = {}) {
  const changePolicyHash = overrides.changePolicyHash ?? keccak256(toUtf8Bytes("change-policy-v1"));
  const commitments = spendPlanCommitments(spendPlan, changePolicyHash);

  return {
    kind: "ReleaseAuthorizationV1",
    schemaVersion: "1.0.0",
    bridgeDomain: keccak256(toUtf8Bytes("BitcoinBride:test")),
    redeemRequestHash: keccak256(toUtf8Bytes("redeem-request")),
    redeemId: keccak256(toUtf8Bytes("redeem-id")),
    btcNetwork: "1",
    sourceEvmChainId: "31337",
    burnTxHash: "0x" + "44".repeat(32),
    burnLogIndex: "7",
    requester: "0x1111111111111111111111111111111111111111",
    destinationScriptHash: keccak256("0x0014" + "22".repeat(20)),
    amountSats: "80000",
    maxMinerFeeSats: "600",
    changePolicyHash,
    inputsCommitment: commitments.inputsCommitment,
    outputsCommitment: commitments.outputsCommitment,
    psbtPolicyHash: commitments.psbtPolicyHash,
    attestationTimestamp: "1710000000",
    deadline: "1710001200",
    ...overrides
  };
}

test("release authorization spend commitments match normalized spend plan", () => {
  const spendPlan = makeSpendPlan();
  const releaseAuthorization = makeReleaseAuthorization(spendPlan);

  const { authorization, commitments } = verifyReleaseSpendPlan(releaseAuthorization, spendPlan);

  assert.equal(authorization.inputsCommitment, commitments.inputsCommitment);
  assert.equal(authorization.outputsCommitment, commitments.outputsCommitment);
  assert.equal(authorization.psbtPolicyHash, commitments.psbtPolicyHash);
  assert.match(releaseStructHash(authorization), /^0x[a-fA-F0-9]{64}$/);
});

test("release authorization validator rejects spend plan drift", () => {
  const spendPlan = makeSpendPlan();
  const releaseAuthorization = makeReleaseAuthorization(spendPlan);

  const changedSpendPlan = makeSpendPlan({
    outputs: [
      {
        scriptPubKeyHex: "0x0014" + "22".repeat(20),
        valueSats: "79999"
      },
      {
        scriptPubKeyHex: "0x0014" + "33".repeat(20),
        valueSats: "9501"
      }
    ]
  });

  assert.throws(
    () => verifyReleaseSpendPlan(releaseAuthorization, changedSpendPlan),
    /outputsCommitment/
  );
});

test("release authorization validator rejects fee over authorization budget", () => {
  const spendPlan = makeSpendPlan({ feeSats: "700" });
  const releaseAuthorization = makeReleaseAuthorization(spendPlan, { maxMinerFeeSats: "600" });

  assert.throws(
    () => verifyReleaseSpendPlan(releaseAuthorization, spendPlan),
    /fee exceeds/
  );
});

test("authorization schemas reject extra fields and non-canonical integer encodings", () => {
  const mintAuthorization = {
    kind: "MintAuthorizationV1",
    schemaVersion: "1.0.0",
    bridgeDomain: keccak256(toUtf8Bytes("BitcoinBride:test")),
    depositId: keccak256(toUtf8Bytes("deposit")),
    recipient0x: "0x1111111111111111111111111111111111111111",
    btcNetwork: "01",
    depositAddressHash: keccak256(toUtf8Bytes("deposit-address")),
    btcTxId: "0x" + "55".repeat(32),
    vout: "1",
    sats: "1000",
    confirmations: "6",
    observedBlockHeight: "840000",
    attestationTimestamp: "1710000000",
    deadline: "1710001200",
    extra: true
  };

  assert.throws(
    () => toMintAuthorization(mintAuthorization),
    /validation failed/
  );
});

test("release attestation validator verifies signer quorum envelope", async () => {
  const signerWallets = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
  const threshold = 2;
  const releaseAuthorization = makeReleaseAuthorization(makeSpendPlan());
  const signed = await buildAttestation({
    bridgeDomain: releaseAuthorization.bridgeDomain,
    authorization: releaseAuthorization,
    kind: "release",
    signerWallets,
    threshold
  });
  const envelope = releaseAttestationEnvelope({
    redeemRequestHash: releaseAuthorization.redeemRequestHash,
    signed
  });

  const verified = verifyReleaseAttestationEnvelope({
    authorization: releaseAuthorization,
    envelope,
    signerAddresses: signerWallets.map((wallet) => wallet.address),
    threshold
  });

  assert.equal(verified.signerSetDigest, signed.signerSetDigest);
  assert.equal(verified.messageDigest, signed.messageDigest);
  assert.equal(verified.signerCount, threshold);

  assert.throws(
    () => verifyReleaseAttestationEnvelope({
      authorization: releaseAuthorization,
      envelope: {
        ...envelope,
        messageDigest: keccak256(toUtf8Bytes("wrong-message"))
      },
      signerAddresses: signerWallets.map((wallet) => wallet.address),
      threshold
    }),
    /messageDigest/
  );
});
