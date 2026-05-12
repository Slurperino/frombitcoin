const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { once } = require("node:events");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { keccak256, toUtf8Bytes, Wallet } = require("ethers");

const { spendPlanCommitments } = require("../scripts/lib/authorization-validator");
const {
  redeemId,
  redeemRequestHash
} = require("../scripts/lib/bridge");
const {
  loadDonReleaseAdapterConfig,
  startDonReleaseAdapterServer
} = require("../scripts/lib/don-release-adapter");

function makeSpendPlan(destinationScriptPubKey) {
  return {
    kind: "NormalizedSpendPlanV1",
    schemaVersion: "1.0.0",
    btcNetwork: "2",
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
  const bridgeDomain = keccak256(toUtf8Bytes("BitcoinBride:don-adapter"));
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
    btcNetwork: "2",
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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

function writeJson(dir, name, value) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, JSON.stringify(value));
  return filePath;
}

function runVerifyDonRelease(args) {
  return spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "verify-don-release.js"), ...args], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8"
  });
}

test("DON release adapter config requires secondary redeem evidence by default", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bitcoinbride-don-adapter-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const configPath = path.join(dir, "adapter.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      serviceName: "test-don-release-adapter",
      policy: {
        expectedBridgeDomain: keccak256(toUtf8Bytes("BitcoinBride:don-adapter")),
        expectedBtcNetwork: "2",
        expectedSourceEvmChainId: "31337",
        signerAddresses: [Wallet.createRandom().address],
        threshold: 1
      }
    })
  );

  const config = loadDonReleaseAdapterConfig(configPath);
  assert.equal(config.policy.requireSecondaryRedeemEvent, true);
});

test("verify-don-release CLI requires secondary redeem evidence by default", (t) => {
  const fixture = makeRedeemFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bitcoinbride-don-verify-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const baseArgs = [
    "--authorization",
    writeJson(dir, "authorization.json", fixture.authorization),
    "--redeem-event",
    writeJson(dir, "redeem-event.json", fixture.event),
    "--spend-plan",
    writeJson(dir, "spend-plan.json", fixture.spendPlan),
    "--expected-bridge-domain",
    fixture.bridgeDomain,
    "--expected-btc-network",
    "2",
    "--expected-source-evm-chain-id",
    "31337",
    "--now",
    "1710000100"
  ];

  const rejected = runVerifyDonRelease(baseArgs);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /secondary redeem event is required by local policy/);

  const accepted = runVerifyDonRelease([...baseArgs, "--allow-missing-secondary-redeem-event"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).signable, true);

  const conflictingFlags = runVerifyDonRelease([
    ...baseArgs,
    "--require-secondary-redeem-event",
    "--allow-missing-secondary-redeem-event"
  ]);
  assert.equal(conflictingFlags.status, 1);
  assert.match(
    conflictingFlags.stderr,
    /--require-secondary-redeem-event and --allow-missing-secondary-redeem-event cannot be used together/
  );
});

test("DON release adapter exposes Chainlink-style preflight responses", async (t) => {
  const fixture = makeRedeemFixture();
  const signers = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
  const logger = { info() {}, error() {} };
  const { server } = startDonReleaseAdapterServer({
    config: {
      serviceName: "test-don-release-adapter",
      http: {
        host: "127.0.0.1",
        port: 0,
        maxBodyBytes: 1048576
      },
      policy: {
        expectedBridgeDomain: fixture.bridgeDomain,
        expectedBtcNetwork: "2",
        expectedSourceEvmChainId: "31337",
        signerAddresses: signers.map((wallet) => wallet.address),
        threshold: 2,
        maxAuthorizationTtlSeconds: 1200,
        maxClockSkewSeconds: 60,
        minTimeToDeadlineSeconds: 0,
        requireSecondaryRedeemEvent: true,
        requireSpendPlan: true,
        now: 1710000100
      }
    },
    logger
  });
  t.after(() => server.close());
  if (!server.listening) {
    await once(server, "listening");
  }

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const accepted = await postJson(`${baseUrl}/release/preflight`, {
    id: "job-1",
    data: {
      authorization: fixture.authorization,
      redeemEvent: fixture.event,
      secondaryRedeemEvent: { ...fixture.event },
      spendPlan: fixture.spendPlan
    }
  });

  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.jobRunID, "job-1");
  assert.equal(accepted.body.statusCode, 200);
  assert.equal(accepted.body.data.signable, true);
  assert.equal(accepted.body.result, accepted.body.data.messageDigest);

  const rejected = await postJson(`${baseUrl}/release/preflight`, {
    id: "job-2",
    data: {
      authorization: fixture.authorization,
      redeemEvent: { ...fixture.event, amountSats: "70000" },
      secondaryRedeemEvent: { ...fixture.event },
      spendPlan: fixture.spendPlan
    }
  });

  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.jobRunID, "job-2");
  assert.match(rejected.body.error.message, /redeem event hash|amountSats/);

  const missingSecondary = await postJson(`${baseUrl}/release/preflight`, {
    id: "job-3",
    data: {
      authorization: fixture.authorization,
      redeemEvent: fixture.event,
      spendPlan: fixture.spendPlan
    }
  });

  assert.equal(missingSecondary.status, 400);
  assert.equal(missingSecondary.body.jobRunID, "job-3");
  assert.match(missingSecondary.body.error.message, /secondary redeem event is required by local policy/);

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});
