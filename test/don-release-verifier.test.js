const test = require("node:test");
const assert = require("node:assert/strict");
const { keccak256, toUtf8Bytes, Wallet } = require("ethers");

const { spendPlanCommitments } = require("../scripts/lib/authorization-validator");
const {
  redeemId,
  redeemRequestHash
} = require("../scripts/lib/bridge");
const { verifyDonReleaseRequest } = require("../scripts/lib/don-release-verifier");

function makeSpendPlan(destinationScriptPubKey) {
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
        scriptPubKeyHex: destinationScriptPubKey,
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
    sighashType: "1"
  };
}

function makeRedeemFixture() {
  const bridgeDomain = keccak256(toUtf8Bytes("BitcoinBride:don-verifier"));
  const destinationScriptPubKey = "0x0014" + "22".repeat(20);
  const destinationScriptHash = keccak256(destinationScriptPubKey);
  const request = {
    requester: "0x1111111111111111111111111111111111111111",
    destinationScriptHash,
    amountSats: "80000",
    maxMinerFeeSats: "600",
    deadline: "1710000600",
    requestNonce: "5"
  };
  const event = {
    redeemRequestHash: redeemRequestHash(bridgeDomain, request),
    blockNumber: 123,
    blockHash: "0x" + "aa".repeat(32),
    txHash: "0x" + "44".repeat(32),
    logIndex: 7,
    destinationScriptPubKey,
    ...request
  };
  const spendPlan = makeSpendPlan(destinationScriptPubKey);
  const changePolicyHash = keccak256(toUtf8Bytes("change-policy-v1"));
  const commitments = spendPlanCommitments(spendPlan, changePolicyHash);
  const authorization = {
    kind: "ReleaseAuthorizationV1",
    schemaVersion: "1.0.0",
    bridgeDomain,
    redeemRequestHash: event.redeemRequestHash,
    redeemId: redeemId(bridgeDomain, event.txHash, event.logIndex, event.redeemRequestHash),
    btcNetwork: "1",
    sourceEvmChainId: "31337",
    burnTxHash: event.txHash,
    burnLogIndex: String(event.logIndex),
    requester: event.requester,
    destinationScriptHash,
    amountSats: event.amountSats,
    maxMinerFeeSats: event.maxMinerFeeSats,
    changePolicyHash,
    inputsCommitment: commitments.inputsCommitment,
    outputsCommitment: commitments.outputsCommitment,
    psbtPolicyHash: commitments.psbtPolicyHash,
    attestationTimestamp: "1710000000",
    deadline: "1710001200"
  };

  return { authorization, bridgeDomain, event, spendPlan };
}

test("DON release verifier accepts only event-bound and spend-plan-bound authorizations", () => {
  const { authorization, bridgeDomain, event, spendPlan } = makeRedeemFixture();
  const signers = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];

  const result = verifyDonReleaseRequest({
    authorization,
    redeemEvent: event,
    secondaryRedeemEvent: { ...event },
    spendPlan,
    expectedBridgeDomain: bridgeDomain,
    expectedBtcNetwork: "1",
    expectedSourceEvmChainId: "31337",
    signerAddresses: signers.map((wallet) => wallet.address),
    threshold: 2,
    now: 1710000100,
    maxAuthorizationTtlSeconds: 1200,
    requireSecondaryRedeemEvent: true,
    requireSpendPlan: true
  });

  assert.equal(result.signable, true);
  assert.equal(result.redeemId, authorization.redeemId);
  assert.equal(result.checks.redeemEvent.verified, true);
  assert.equal(result.checks.secondaryRedeemEvent.verified, true);
  assert.equal(result.checks.spendPlans[0].source, "spendPlan");
  assert.equal(result.checks.spendPlans[0].feeSats, "500");
  assert.match(result.releaseStructHash, /^0x[a-fA-F0-9]{64}$/);
  assert.match(result.messageDigest, /^0x[a-fA-F0-9]{64}$/);

  assert.throws(
    () => verifyDonReleaseRequest({
      authorization,
      redeemEvent: { ...event, amountSats: "70000" },
      spendPlan,
      now: 1710000100,
      requireSpendPlan: true
    }),
    /redeem event hash|amountSats/
  );
});

test("DON release verifier requires a spend plan when signing policy asks for one", () => {
  const { authorization, event } = makeRedeemFixture();

  assert.throws(
    () => verifyDonReleaseRequest({
      authorization,
      redeemEvent: event,
      now: 1710000100,
      requireSpendPlan: true
    }),
    /spend plan or PSBT is required/
  );
});

test("DON release verifier rejects secondary source disagreement", () => {
  const { authorization, event, spendPlan } = makeRedeemFixture();

  assert.throws(
    () => verifyDonReleaseRequest({
      authorization,
      redeemEvent: event,
      secondaryRedeemEvent: { ...event, txHash: "0x" + "55".repeat(32) },
      spendPlan,
      now: 1710000100,
      requireSecondaryRedeemEvent: true,
      requireSpendPlan: true
    }),
    /secondary redeem event txHash disagrees/
  );

  assert.throws(
    () => verifyDonReleaseRequest({
      authorization,
      redeemEvent: event,
      spendPlan,
      now: 1710000100,
      requireSecondaryRedeemEvent: true,
      requireSpendPlan: true
    }),
    /secondary redeem event is required/
  );
});
