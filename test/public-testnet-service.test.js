const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const bitcoin = require("bitcoinjs-lib");
const { hexlify, keccak256, parseEther, randomBytes, toUtf8Bytes } = require("ethers");

const {
  bitcoinRpcOptions,
  loadPublicTestnetConfig
} = require("../scripts/lib/public-testnet-config");
const {
  PublicTestnetCostLimiter
} = require("../scripts/lib/public-testnet-cost-limiter");
const { assertAllowedDestinationScript } = require("../scripts/lib/destination-script-policy");
const {
  DEPOSIT_BTC_OBSERVED,
  DEPOSIT_MINT_REQUESTED,
  DEPOSIT_MINTED,
  PublicTestnetStore,
  REDEEM_BTC_BROADCAST,
  REDEEM_RELEASE_PREPARED,
  REDEEM_RELEASE_REQUESTED,
  REDEEM_REDEEM_COMPLETED,
  REDEEM_REDEEM_SUBMITTED
} = require("../scripts/lib/public-testnet-store");
const {
  ECPair,
  buildP2wpkhSpendPsbt,
  extractNormalizedSpendPlanFromPsbt
} = require("../scripts/lib/bitcoin-psbt");
const {
  assertChainlinkOnlyRiskRuntime,
  assertStaticPublicTestnetConfig
} = require("../scripts/lib/public-testnet-runtime-guard");
const {
  assertValid,
  spendPlanCommitments
} = require("../scripts/lib/authorization-validator");
const {
  publicRedeemStatus,
  toPublicDeposit,
  toPublicRedeem
} = require("../scripts/lib/public-testnet-views");
const {
  buildPublicTestnetReconciliationReport
} = require("../scripts/lib/public-testnet-reconciliation");
const {
  normalizeDonReleasePreparation,
  requestDonReleasePreparation
} = require("../scripts/lib/don-custody-client");
const { serviceStatus, startPublicTestnetApiServer } = require("../scripts/public-testnet-api");
const {
  assertReleasePsbtMatchesAuthorization,
  btcAmountToSats,
  broadcastBitcoinReleases,
  buildDonCustodyReleaseRequest,
  destinationAddressFromScript,
  prepareRedeems,
  redeemExpirationReason,
  requestReleaseAuthorizations,
  runWorkerLoop,
  settleReleaseCallbacks
} = require("../scripts/public-testnet-worker");

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bitcoinbride-public-testnet-"));
  return {
    dbPath: path.join(dir, "store.sqlite"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

function bytes32(label) {
  return keccak256(toUtf8Bytes(label));
}

function makeDepositIntent() {
  return {
    recipient0x: "0x1111111111111111111111111111111111111111",
    depositAddressHash: bytes32("tb1qdeposit"),
    amountMode: 0,
    expectedSats: "10000",
    minSats: "10000",
    maxSats: "10000",
    nonce: hexlify(randomBytes(32)),
    expiry: "1910000000"
  };
}

function writeTempConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bitcoinbride-public-config-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return {
    file,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

function loadExampleConfigObject() {
  return JSON.parse(fs.readFileSync("config/public-testnet.sepolia-signet-chainlink.example.json", "utf8"));
}

function makeWorkerConfig(overrides = {}) {
  return {
    evm: {
      bridgeDomain: bytes32("bridge-domain"),
      chainId: 11155111,
      finalityBlocks: 0
    },
    bitcoin: {
      btcNetwork: "3",
      bitcoinNetwork: "signet",
      changeAddress: "tb1qc3r85fhqlv7u933wsexj3ffcwlvtlzchxey3f6",
      minConf: 1
    },
    chainlink: {
      releaseFinalityBlocks: 64
    },
    redeems: {
      limit: 20,
      maxSats: "100000",
      maxMinerFeeSats: "5000",
      authorizationTtlSeconds: 1200,
      changePolicyHash: bytes32("change-policy"),
      autoBroadcastBitcoin: true
    },
    worker: {
      rpcTimeoutMs: 50,
      rpcMaxRetries: 0,
      rpcRetryDelayMs: 0
    },
    ...overrides
  };
}

function makeRedeem(overrides = {}) {
  return {
    redeemRequestHash: bytes32("redeem-request"),
    requester: "0x2222222222222222222222222222222222222222",
    txHash: bytes32("burn-tx"),
    blockNumber: 200,
    blockHash: bytes32("burn-block"),
    logIndex: 3,
    destinationScriptHash: bytes32("destination-script"),
    destinationScriptPubKey: "0x0014" + "33".repeat(20),
    requestNonce: "0",
    amountSats: "5000",
    maxMinerFeeSats: "500",
    deadline: "100",
    ...overrides
  };
}

function makeReleaseAuthorization(overrides = {}) {
  return {
    kind: "ReleaseAuthorizationV1",
    schemaVersion: "1.0.0",
    bridgeDomain: bytes32("bridge-domain"),
    redeemRequestHash: bytes32("redeem-request"),
    redeemId: bytes32("redeem-id"),
    btcNetwork: "3",
    sourceEvmChainId: "11155111",
    burnTxHash: bytes32("burn-tx"),
    burnLogIndex: "3",
    requester: "0x2222222222222222222222222222222222222222",
    destinationScriptHash: bytes32("destination-script"),
    amountSats: "5000",
    maxMinerFeeSats: "500",
    changePolicyHash: bytes32("change-policy"),
    inputsCommitment: bytes32("inputs"),
    outputsCommitment: bytes32("outputs"),
    psbtPolicyHash: bytes32("psbt-policy"),
    attestationTimestamp: "1710000000",
    deadline: "1910000500",
    ...overrides
  };
}

function makeReleasePsbtFixture(config = makeWorkerConfig()) {
  const network = bitcoin.networks.testnet;
  const inputKey = ECPair.makeRandom({ network });
  const destinationKey = ECPair.makeRandom({ network });
  const inputPayment = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(inputKey.publicKey),
    network
  });
  const destinationPayment = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(destinationKey.publicKey),
    network
  });
  const destinationScriptPubKey = `0x${Buffer.from(destinationPayment.output).toString("hex")}`;
  const psbt = buildP2wpkhSpendPsbt({
    btcNetwork: config.bitcoin.btcNetwork,
    bitcoinNetwork: config.bitcoin.bitcoinNetwork,
    utxos: [{
      txid: "11".repeat(32),
      vout: 0,
      valueSats: "5500",
      scriptPubKeyHex: `0x${Buffer.from(inputPayment.output).toString("hex")}`
    }],
    destinationAddress: destinationPayment.address,
    amountSats: "5000",
    feeSats: "500"
  });
  const spendPlan = {
    kind: "NormalizedSpendPlanV1",
    schemaVersion: "1.0.0",
    ...extractNormalizedSpendPlanFromPsbt(psbt, config.bitcoin.bitcoinNetwork)
  };
  const commitments = spendPlanCommitments(spendPlan, config.redeems.changePolicyHash);
  return {
    destinationAddress: destinationPayment.address,
    destinationScriptPubKey,
    psbt,
    spendPlan,
    authorization: makeReleaseAuthorization({
      btcNetwork: config.bitcoin.btcNetwork,
      sourceEvmChainId: String(config.evm.chainId),
      amountSats: "5000",
      maxMinerFeeSats: "500",
      destinationScriptHash: keccak256(destinationScriptPubKey),
      changePolicyHash: config.redeems.changePolicyHash,
      ...commitments
    })
  };
}

function unsignedTxHexFromSpendPlan(spendPlan) {
  const tx = new bitcoin.Transaction();
  tx.version = Number(spendPlan.nVersion);
  tx.locktime = Number(spendPlan.nLockTime);
  for (const input of spendPlan.inputs) {
    tx.addInput(
      Buffer.from(input.btcTxId.replace(/^0x/i, ""), "hex").reverse(),
      Number(input.vout)
    );
  }
  for (const output of spendPlan.outputs) {
    tx.addOutput(
      Buffer.from(output.scriptPubKeyHex.replace(/^0x/i, ""), "hex"),
      BigInt(output.valueSats)
    );
  }
  return tx.toHex();
}

function makeLogger() {
  return {
    info: () => {},
    error: () => {}
  };
}

function makeApiConfig(httpOverrides = {}) {
  return {
    serviceName: "public-api-test",
    http: {
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 1024,
      depositPostLimitPerMinute: 2,
      depositGlobalLimitPerMinute: 10,
      depositRecipientLimitPerHour: 2,
      minRelayerBalanceEth: "0.005",
      statusCacheTtlMs: 5000,
      metricsEnabled: false,
      ...httpOverrides
    },
    evm: {
      chainId: 11155111,
      depositRegistry: "0x1111111111111111111111111111111111111111",
      mintGateway: "0x2222222222222222222222222222222222222222",
      burnGateway: "0x3333333333333333333333333333333333333333",
      wrappedBitcoin: "0x4444444444444444444444444444444444444444",
      chainlinkVerifier: "0x5555555555555555555555555555555555555555"
    },
    bitcoin: {
      bitcoinNetwork: "signet",
      btcNetwork: "3"
    },
    chainlink: {
      minConfirmations: 6
    },
    deposits: {
      minSats: "1000",
      maxSats: "100000",
      limit: 20
    },
    redeems: {
      maxSats: "5000",
      maxMinerFeeSats: "1000",
      limit: 20
    }
  };
}

async function fetchJsonForTest(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function assertNoForbiddenPublicKeys(value) {
  const forbidden = new Set([
    "intent",
    "nonce",
    "depositAddressHash",
    "mintAuthorization",
    "mintStructHash",
    "destinationScriptHash",
    "destinationScriptPubKey",
    "destinationAddress",
    "requestNonce",
    "blockHash",
    "psbt",
    "spendPlan",
    "releaseAuthorization",
    "releaseStructHash",
    "releaseRequestId",
    "bitcoinTxHex",
    "error",
    "internalStatus"
  ]);
  const visit = (item) => {
    if (!item || typeof item !== "object") {
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child);
      }
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      assert.equal(forbidden.has(key), false, `forbidden public key leaked: ${key}`);
      visit(child);
    }
  };
  visit(value);
}

test("public testnet config validates the Sepolia signet example", () => {
  const config = loadPublicTestnetConfig("config/public-testnet.sepolia-signet-chainlink.example.json");

  assert.equal(config.serviceName, "bitcoinbride-public-testnet-sepolia-signet-chainlink");
  assert.equal(config.http.depositPostLimitPerMinute, 12);
  assert.equal(config.http.depositGlobalLimitPerMinute, 60);
  assert.equal(config.http.depositRecipientLimitPerHour, 6);
  assert.equal(config.http.minRelayerBalanceEth, "0.005");
  assert.equal(config.http.metricsEnabled, false);
  assert.equal(config.deposits.authorizationTtlSeconds, 1200);
  assert.equal(config.deposits.maxSats, "100000");
  assert.equal(config.redeems.maxSats, "5000");
  assert.equal(config.redeems.maxMinerFeeSats, "1000");
  assert.equal(config.evm.chainId, 11155111);
  assert.equal(config.bitcoin.bitcoinNetwork, "signet");
  assert.equal(config.bitcoin.rpcTimeoutMs, 9000);
  assert.equal(config.bitcoin.rpcMaxRetries, 2);
  assert.equal(config.bitcoin.rpcRetryDelayMs, 250);
  assert.equal(config.bitcoin.custodyController, "chainlink-don");
  assert.equal(config.bitcoin.donCustodyAdapterUrl, "https://custody.example.com/release/prepare");
  assert.equal(config.bitcoin.donCustodyAdapterTimeoutMs, 9000);
  assert.equal(config.worker.rpcTimeoutMs, 15000);
  assert.equal(config.worker.rpcMaxRetries, 3);
  assert.equal(config.worker.rpcRetryDelayMs, 1000);

  const previousUser = process.env.BITCOIN_RPC_USER;
  const previousPassword = process.env.BITCOIN_RPC_PASSWORD;
  process.env.BITCOIN_RPC_USER = "user";
  process.env.BITCOIN_RPC_PASSWORD = "pass";
  const rpcOptions = bitcoinRpcOptions(config);
  if (previousUser === undefined) {
    delete process.env.BITCOIN_RPC_USER;
  } else {
    process.env.BITCOIN_RPC_USER = previousUser;
  }
  if (previousPassword === undefined) {
    delete process.env.BITCOIN_RPC_PASSWORD;
  } else {
    process.env.BITCOIN_RPC_PASSWORD = previousPassword;
  }
  assert.equal(rpcOptions.timeoutMs, 9000);
  assert.equal(rpcOptions.maxRetries, 2);
  assert.equal(rpcOptions.retryDelayMs, 250);
});

test("public testnet static guard fails closed outside Sepolia signet with bounded caps", () => {
  const config = loadPublicTestnetConfig("config/public-testnet.sepolia-signet-chainlink.example.json");

  assert.doesNotThrow(() => assertStaticPublicTestnetConfig(config));
  assert.throws(
    () => assertStaticPublicTestnetConfig({ ...config, bitcoin: { ...config.bitcoin, bitcoinNetwork: "mainnet" } }),
    /bitcoin\.bitcoinNetwork signet/
  );
  assert.throws(
    () => assertStaticPublicTestnetConfig({ ...config, evm: { ...config.evm, chainId: 1 } }),
    /Sepolia chainId/
  );
  assert.throws(
    () => assertStaticPublicTestnetConfig({ ...config, deposits: { ...config.deposits, maxSats: "18446744073709551615" } }),
    /deposits\.maxSats must be <=/
  );
  assert.throws(
    () => assertStaticPublicTestnetConfig({ ...config, bitcoin: { ...config.bitcoin, donCustodyAdapterUrl: null } }),
    /donCustodyAdapterUrl is required/
  );
});

test("public testnet Chainlink-only-risk guard requires locked contracts and renounced owners", async () => {
  const config = loadPublicTestnetConfig("config/public-testnet.sepolia-signet-chainlink.example.json");
  const zero = "0x0000000000000000000000000000000000000000";
  const relayer = "0x1111111111111111111111111111111111111111";
  const contracts = {
    wrappedBitcoin: {
      minterLocked: async () => true,
      lockedMinter: async () => config.evm.mintGateway,
      isMinter: async (address) => address === config.evm.mintGateway,
      owner: async () => zero
    },
    depositRegistry: {
      consumerLocked: async () => true,
      lockedConsumer: async () => config.evm.mintGateway,
      authorizedConsumers: async (address) => address === config.evm.mintGateway,
      owner: async () => zero
    },
    mintGateway: {
      owner: async () => zero
    },
    burnGateway: {
      owner: async () => zero
    },
    verifier: {
      owner: async () => zero,
      authorizedRequester: async (address) => address === relayer
    }
  };

  await assert.doesNotReject(() => assertChainlinkOnlyRiskRuntime({ config, contracts, relayerAddress: relayer }));
  await assert.rejects(
    () => assertChainlinkOnlyRiskRuntime({
      config,
      contracts: {
        ...contracts,
        wrappedBitcoin: {
          ...contracts.wrappedBitcoin,
          minterLocked: async () => false
        }
      },
      relayerAddress: relayer
    }),
    /WrappedBitcoin\.minterLocked mismatch/
  );
  await assert.rejects(
    () => assertChainlinkOnlyRiskRuntime({
      config,
      contracts: {
        ...contracts,
        verifier: {
          ...contracts.verifier,
          owner: async () => relayer
        }
      },
      relayerAddress: relayer
    }),
    /ChainlinkFunctionsVerifier\.owner mismatch/
  );
});

test("public testnet config validates timeout and retry knobs", (t) => {
  const valid = loadExampleConfigObject();
  valid.bitcoin.rpcTimeoutMs = 12000;
  valid.bitcoin.rpcMaxRetries = 0;
  valid.bitcoin.rpcRetryDelayMs = 0;
  valid.worker.rpcTimeoutMs = 11000;
  valid.worker.rpcMaxRetries = 3;
  valid.worker.rpcRetryDelayMs = 100;
  const temp = writeTempConfig(valid);
  t.after(temp.cleanup);

  const config = loadPublicTestnetConfig(temp.file);
  assert.equal(config.bitcoin.rpcTimeoutMs, 12000);
  assert.equal(config.bitcoin.rpcMaxRetries, 0);
  assert.equal(config.bitcoin.rpcRetryDelayMs, 0);
  assert.equal(config.worker.rpcTimeoutMs, 11000);
  assert.equal(config.worker.rpcMaxRetries, 3);
  assert.equal(config.worker.rpcRetryDelayMs, 100);

  for (const [section, key, value, message] of [
    ["bitcoin", "rpcTimeoutMs", 0, /bitcoin\.rpcTimeoutMs must be a positive integer/],
    ["bitcoin", "rpcMaxRetries", -1, /bitcoin\.rpcMaxRetries must be zero or greater/],
    ["bitcoin", "rpcRetryDelayMs", 1.5, /bitcoin\.rpcRetryDelayMs must be zero or greater/],
    ["worker", "rpcTimeoutMs", 0, /worker\.rpcTimeoutMs must be a positive integer/],
    ["worker", "rpcMaxRetries", -1, /worker\.rpcMaxRetries must be zero or greater/],
    ["worker", "rpcRetryDelayMs", 1.5, /worker\.rpcRetryDelayMs must be zero or greater/]
  ]) {
    const invalid = loadExampleConfigObject();
    invalid[section][key] = value;
    const invalidTemp = writeTempConfig(invalid);
    t.after(invalidTemp.cleanup);
    assert.throws(() => loadPublicTestnetConfig(invalidTemp.file), message);
  }
});

test("public views redact internal deposit and redeem artifacts", () => {
  const deposit = {
    depositId: bytes32("deposit"),
    status: "mint_requested",
    recipient: "0x1111111111111111111111111111111111111111",
    depositAddress: "tb1qdepositaddress",
    depositAddressHash: bytes32("deposit-address"),
    expectedSats: "1000",
    nonce: bytes32("nonce"),
    intent: makeDepositIntent(),
    mintAuthorization: { kind: "MintAuthorizationV1" },
    mintStructHash: bytes32("mint-struct"),
    error: "raw provider timeout with internal url",
    createdAt: 1,
    updatedAt: 2
  };
  const redeem = {
    ...makeRedeem(),
    status: "redeem_completed",
    destinationAddress: "tb1qdestination",
    psbt: { psbtBase64: "secret" },
    spendPlan: { inputs: [] },
    releaseAuthorization: { kind: "ReleaseAuthorizationV1" },
    releaseStructHash: bytes32("release-struct"),
    bitcoinTxHex: "deadbeef",
    error: "raw mempool rpc timeout",
    observedAt: 1,
    updatedAt: 2
  };

  const publicDeposit = toPublicDeposit(deposit);
  const publicRedeem = toPublicRedeem(redeem);

  assert.equal(publicDeposit.status, "external_authorization_requested");
  assert.equal(publicRedeem.status, "bitcoin_broadcast_retrying");
  assert.equal(publicRedeemStatus({ status: "btc_broadcast" }), "bitcoin_broadcast");
  assertNoForbiddenPublicKeys(publicDeposit);
  assertNoForbiddenPublicKeys(publicRedeem);
  assert.equal(publicDeposit.errorCategory, "external_service_unavailable");
  assert.equal(publicRedeem.errorCategory, "external_service_unavailable");
});

test("public cost limiter applies ip, global, and recipient windows", () => {
  const limiter = new PublicTestnetCostLimiter({
    ipLimitPerMinute: 2,
    globalLimitPerMinute: 3,
    recipientLimitPerHour: 2
  });
  const now = 1_000;

  assert.equal(limiter.allowDeposit({ ip: "1.1.1.1", recipient: "0xAa", now }), true);
  assert.equal(limiter.allowDeposit({ ip: "1.1.1.1", recipient: "0xBb", now }), true);
  assert.equal(limiter.allowDeposit({ ip: "1.1.1.1", recipient: "0xCc", now }), false);
  assert.equal(limiter.allowDeposit({ ip: "2.2.2.2", recipient: "0xDd", now }), false);

  const later = now + 60_001;
  assert.equal(limiter.allowDeposit({ ip: "2.2.2.2", recipient: "0xAa", now: later }), true);
  assert.equal(limiter.allowDeposit({ ip: "3.3.3.3", recipient: "0xaa", now: later }), false);
});

test("public API redacts activity, health, status, and metrics by default", async (t) => {
  const internalDeposit = {
    depositId: bytes32("deposit"),
    status: "mint_requested",
    recipient: "0x1111111111111111111111111111111111111111",
    depositAddress: "tb1qdepositaddress",
    depositAddressHash: bytes32("deposit-address"),
    expectedSats: "1000",
    nonce: bytes32("nonce"),
    intent: makeDepositIntent(),
    mintAuthorization: { kind: "MintAuthorizationV1" },
    mintStructHash: bytes32("mint-struct"),
    createdAt: 1,
    updatedAt: 2
  };
  const internalRedeem = {
    ...makeRedeem(),
    status: "release_requested",
    destinationAddress: "tb1qdestination",
    psbt: { psbtBase64: "secret" },
    spendPlan: { inputs: [] },
    releaseAuthorization: { kind: "ReleaseAuthorizationV1" },
    releaseStructHash: bytes32("release-struct"),
    observedAt: 1,
    updatedAt: 2
  };
  const store = {
    countDepositsByStatus: () => ({ mint_requested: 1 }),
    countRedeemsByStatus: () => ({ release_requested: 1 }),
    reconciliationStats: () => ({
      mintedDepositSats: "1000",
      observedBurnSats: "500",
      knownNetSupplySats: "500",
      bitcoinBroadcastSats: "0",
      outstandingRedeemSats: "500",
      staleRedeems: {},
      donMissingFinalizedTxs: 0,
      releaseArtifactsMissing: 0
    }),
    listCursors: () => [{ name: "secret", value: "100" }],
    listDeposits: () => [internalDeposit],
    getDeposit: () => internalDeposit,
    listRedeems: () => [internalRedeem],
    getRedeem: () => internalRedeem
  };
  const contracts = {
    provider: {
      getBlockNumber: async () => 123,
      getBalance: async () => parseEther("0.02")
    },
    relayer: { address: "0x9999999999999999999999999999999999999999" },
    wrappedBitcoin: { totalSupply: async () => 1000n }
  };
  const { server } = startPublicTestnetApiServer({
    config: makeApiConfig({ metricsEnabled: false }),
    store,
    bitcoinRpc: { call: async () => 456 },
    contracts,
    logger: makeLogger()
  });
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const health = await fetchJsonForTest(`http://127.0.0.1:${port}/healthz`);
  assert.deepEqual(health, { ok: true, service: "public-api-test" });

  const status = await fetchJsonForTest(`http://127.0.0.1:${port}/status`);
  assert.equal(status.relayer.fundingStatus, "funded");
  assert.equal(status.relayer.eth, undefined);
  assert.equal(status.relayer.address, undefined);
  assert.equal(status.cursors, undefined);
  assert.deepEqual(status.deposits, { external_authorization_requested: 1 });
  assert.deepEqual(status.redeems, { external_authorization_requested: 1 });

  const deposits = await fetchJsonForTest(`http://127.0.0.1:${port}/deposits`);
  const redeems = await fetchJsonForTest(`http://127.0.0.1:${port}/redeems`);
  assertNoForbiddenPublicKeys(deposits);
  assertNoForbiddenPublicKeys(redeems);

  const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(metrics.status, 404);
});

test("public API serves the frontend shell and assets", async (t) => {
  const { server } = startPublicTestnetApiServer({
    config: {
      serviceName: "frontend-test",
      http: {
        host: "127.0.0.1",
        port: 0,
        depositPostLimitPerMinute: 1,
        maxBodyBytes: 1024
      }
    },
    store: {},
    bitcoinRpc: {},
    contracts: {},
    logger: makeLogger()
  });
  t.after(() => server.close());

  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const index = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /text\/html/);
  assert.match(await index.text(), /FromBitcoin Testnet/);

  const script = await fetch(`http://127.0.0.1:${port}/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /application\/javascript/);
  assert.match(await script.text(), /createDeposit/);
});

test("public testnet store tracks deposit and redeem lifecycles", (t) => {
  const temp = tempDbPath();
  const store = new PublicTestnetStore(temp.dbPath);
  t.after(() => {
    store.close();
    temp.cleanup();
  });

  const intent = makeDepositIntent();
  const deposit = store.createDeposit({
    depositId: bytes32("deposit-id"),
    recipient: intent.recipient0x,
    depositAddress: "tb1qdepositaddress",
    depositAddressHash: intent.depositAddressHash,
    expectedSats: intent.expectedSats,
    nonce: intent.nonce,
    expiry: intent.expiry,
    intent,
    createIntentTxHash: bytes32("create-intent"),
    createIntentBlockNumber: 100
  });
  assert.equal(deposit.status, "intent_created");

  store.markDepositObserved({
    depositId: deposit.depositId,
    txid: "11".repeat(32),
    vout: 0,
    sats: "10000",
    confirmations: 6,
    observedBlockHeight: 1000
  });
  assert.equal(store.getDeposit(deposit.depositId).status, DEPOSIT_BTC_OBSERVED);
  assert.equal(store.listMintRequestEligible({ minConfirmations: 6 }).length, 1);

  store.markMintRequested({
    depositId: deposit.depositId,
    authorization: { kind: "MintAuthorizationV1", depositId: deposit.depositId },
    requestId: bytes32("mint-request"),
    requestTxHash: bytes32("mint-request-tx"),
    structHash: bytes32("mint-struct")
  });
  assert.equal(store.getDeposit(deposit.depositId).status, DEPOSIT_MINT_REQUESTED);
  assert.equal(store.listMintCallbackEligible().length, 1);

  store.markMinted({
    depositId: deposit.depositId,
    txHash: bytes32("mint-tx"),
    blockNumber: 101
  });
  assert.equal(store.getDeposit(deposit.depositId).status, DEPOSIT_MINTED);
  assert.deepEqual(store.countDepositsByStatus(), { minted: 1 });

  const redeemEvent = {
    redeemRequestHash: bytes32("redeem-request"),
    requester: "0x2222222222222222222222222222222222222222",
    txHash: bytes32("burn-tx"),
    blockNumber: 200,
    blockHash: bytes32("burn-block"),
    logIndex: 3,
    destinationScriptHash: bytes32("destination-script"),
    destinationScriptPubKey: "0x0014" + "33".repeat(20),
    requestNonce: "0",
    amountSats: "5000",
    maxMinerFeeSats: "500",
    deadline: "1910000500"
  };
  store.upsertRedeemObserved(redeemEvent);
  assert.equal(store.listRedeemPreparationEligible({ finalizedBlock: 200 }).length, 1);

  store.markRedeemPrepared({
    redeemRequestHash: redeemEvent.redeemRequestHash,
    destinationAddress: "tb1qdestination",
    psbt: { kind: "BitcoinPsbtV1", psbtBase64: "cHNidP8=" },
    spendPlan: { kind: "NormalizedSpendPlanV1" },
    authorization: { kind: "ReleaseAuthorizationV1" }
  });
  assert.equal(store.getRedeem(redeemEvent.redeemRequestHash).status, REDEEM_RELEASE_PREPARED);
  assert.equal(store.listReleaseRequestEligible().length, 1);

  store.markReleaseRequested({
    redeemRequestHash: redeemEvent.redeemRequestHash,
    requestId: bytes32("release-request"),
    requestTxHash: bytes32("release-request-tx"),
    structHash: bytes32("release-struct")
  });
  assert.equal(store.getRedeem(redeemEvent.redeemRequestHash).status, REDEEM_RELEASE_REQUESTED);
  assert.equal(store.listReleaseCallbackEligible().length, 1);

  store.markRedeemSubmitted({
    redeemRequestHash: redeemEvent.redeemRequestHash,
    txHash: bytes32("complete-redeem")
  });
  const submittedRedeem = store.getRedeem(redeemEvent.redeemRequestHash);
  assert.equal(submittedRedeem.status, REDEEM_REDEEM_SUBMITTED);
  assert.equal(submittedRedeem.completeRedeemTxHash, bytes32("complete-redeem"));
  assert.equal(submittedRedeem.completeRedeemBlockNumber, null);
  assert.equal(store.listReleaseCallbackEligible().length, 1);
  assert.equal(store.listBitcoinBroadcastEligible().length, 0);

  store.markRedeemCompleted({
    redeemRequestHash: redeemEvent.redeemRequestHash,
    txHash: bytes32("complete-redeem"),
    blockNumber: 201
  });
  assert.equal(store.getRedeem(redeemEvent.redeemRequestHash).status, REDEEM_REDEEM_COMPLETED);
  assert.equal(store.listBitcoinBroadcastEligible().length, 1);

  store.markBitcoinFinalized({
    redeemRequestHash: redeemEvent.redeemRequestHash,
    txHex: "deadbeef"
  });
  assert.equal(store.getRedeem(redeemEvent.redeemRequestHash).bitcoinTxHex, "deadbeef");

  store.markBitcoinBroadcast({
    redeemRequestHash: redeemEvent.redeemRequestHash,
    txid: "44".repeat(32),
    txHex: "deadbeef"
  });
  assert.equal(store.getRedeem(redeemEvent.redeemRequestHash).status, REDEEM_BTC_BROADCAST);
  assert.deepEqual(store.countRedeemsByStatus(), { btc_broadcast: 1 });
  assert.deepEqual(store.reconciliationStats({ now: 1910000600 }), {
    mintedDepositSats: "10000",
    observedBurnSats: "5000",
    knownNetSupplySats: "5000",
    bitcoinBroadcastSats: "5000",
    outstandingRedeemSats: "0",
    staleRedeems: {},
    donMissingFinalizedTxs: 0,
    releaseArtifactsMissing: 0
  });
});

test("public worker Bitcoin helpers preserve satoshi and signet script conversions", () => {
  assert.equal(btcAmountToSats(0.00009859), 9859n);
  assert.equal(btcAmountToSats("1.00000001"), 100000001n);

  const key = ECPair.makeRandom({ network: bitcoin.networks.testnet });
  const payment = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(key.publicKey),
    network: bitcoin.networks.testnet
  });
  const script = `0x${Buffer.from(payment.output).toString("hex")}`;

  assert.equal(destinationAddressFromScript(script, "signet"), payment.address);
  assert.doesNotThrow(() => assertAllowedDestinationScript(script));
  assert.doesNotThrow(() => assertAllowedDestinationScript("0x0020" + "11".repeat(32)));
  assert.doesNotThrow(() => assertAllowedDestinationScript("0x5120" + "22".repeat(32)));
  assert.throws(() => destinationAddressFromScript("0x76a914" + "33".repeat(20) + "88ac", "signet"), /unsupported BTC destination script/);
});

test("public worker redeem deadline helper uses strict expiry boundary", () => {
  assert.equal(redeemExpirationReason(makeRedeem({ deadline: "100" }), 100, "test stage"), null);
  assert.equal(
    redeemExpirationReason(makeRedeem({ deadline: "100" }), 101, "test stage"),
    "redeem deadline expired before test stage"
  );
  assert.equal(
    redeemExpirationReason(makeRedeem({ releaseAuthorization: { deadline: "100" } }), 101, "test stage"),
    "redeem deadline expired before test stage"
  );
  assert.equal(
    redeemExpirationReason(makeRedeem({ deadline: "200", releaseAuthorization: { deadline: "100" } }), 101, "test stage"),
    "release authorization deadline expired before test stage"
  );
});

test("public worker gates expired redeems before pre-completion external side effects", async () => {
  const config = makeWorkerConfig();
  const expiredRedeem = makeRedeem({ deadline: "100" });
  const futureDeadline = String(Math.floor(Date.now() / 1000) + 3600);
  const expiredAuthorizationDeadline = String(Math.floor(Date.now() / 1000) - 1);

  {
    let failed = null;
    let getBlockCalled = false;
    const result = await prepareRedeems({
      config,
      store: {
        listRedeemPreparationEligible: () => [expiredRedeem],
        markRedeemFailed: (hash, error, now) => {
          failed = { hash, error, now };
        },
        markRedeemError: () => assert.fail("expired redeem should not be marked as retryable error")
      },
      resources: {
        provider: {
          getBlockNumber: async () => 200,
          getBlock: async () => {
            getBlockCalled = true;
          }
        },
        bitcoinRpc: {
          call: async () => assert.fail("expired redeem should not fund a PSBT")
        }
      },
      logger: makeLogger()
    });
    assert.deepEqual(result, { checked: 1, prepared: 0 });
    assert.equal(getBlockCalled, false);
    assert.equal(failed.hash, expiredRedeem.redeemRequestHash);
    assert.equal(failed.error, "redeem deadline expired before redeem preparation");
  }

  {
    let failed = null;
    const result = await requestReleaseAuthorizations({
      config,
      store: {
        listReleaseRequestEligible: () => [expiredRedeem],
        markRedeemFailed: (hash, error, now) => {
          failed = { hash, error, now };
        },
        markRedeemError: () => assert.fail("expired redeem should not request Chainlink authorization")
      },
      resources: {
        sources: {
          release: "return true;"
        },
        contracts: {
          verifier: {}
        }
      },
      logger: makeLogger()
    });
    assert.deepEqual(result, { checked: 1, requested: 0 });
    assert.equal(failed.error, "redeem deadline expired before release authorization request");
  }

  {
    let failed = null;
    const result = await settleReleaseCallbacks({
      config,
      store: {
        listReleaseCallbackEligible: () => [makeRedeem({
          deadline: futureDeadline,
          releaseAuthorization: { deadline: expiredAuthorizationDeadline },
          releaseRequestId: bytes32("release-request")
        })],
        markRedeemFailed: (hash, error, now) => {
          failed = { hash, error, now };
        },
        markRedeemError: () => assert.fail("expired redeem should not be marked as retryable error")
      },
      resources: {
        contracts: {
          verifier: {
            pendingRequests: async () => assert.fail("expired redeem should not query verifier")
          },
          burnGateway: {}
        }
      },
      logger: makeLogger()
    });
    assert.deepEqual(result, { checked: 1, fulfilled: 0, completed: 0 });
    assert.equal(failed.error, "release authorization deadline expired before redeem completion");
  }

  assert.ok(expiredAuthorizationDeadline);
});

test("public worker marks over-limit redeems as terminal policy failures", async () => {
  const config = makeWorkerConfig({
    redeems: {
      ...makeWorkerConfig().redeems,
      maxSats: "5000",
      maxMinerFeeSats: "1000"
    }
  });
  const overLimitRedeem = makeRedeem({
    amountSats: "6000",
    maxMinerFeeSats: "500",
    deadline: String(Math.floor(Date.now() / 1000) + 3600)
  });
  let failed = null;

  const result = await prepareRedeems({
    config,
    store: {
      listRedeemPreparationEligible: () => [overLimitRedeem],
      markRedeemFailed: (hash, error, now) => {
        failed = { hash, error, now };
      },
      markRedeemError: () => assert.fail("over-limit redeem should not be retryable")
    },
    resources: {
      provider: {
        getBlockNumber: async () => 200,
        getBlock: async () => assert.fail("over-limit redeem should not fetch EVM block")
      },
      bitcoinRpc: {
        call: async () => assert.fail("over-limit redeem should not build a PSBT")
      }
    },
    logger: makeLogger()
  });

  assert.deepEqual(result, { checked: 1, prepared: 0 });
  assert.equal(failed.hash, overLimitRedeem.redeemRequestHash);
  assert.equal(failed.error, "redeem amount exceeds public testnet max 5000 sats");
});

test("public worker prepares DON-custody redeems without local wallet PSBT funding", async () => {
  const baseConfig = makeWorkerConfig();
  const config = makeWorkerConfig({
    bitcoin: {
      ...baseConfig.bitcoin,
      custodyController: "chainlink-don",
      treasuryAddress: "tb1qc3r85fhqlv7u933wsexj3ffcwlvtlzchxey3f6"
    }
  });
  const release = makeReleasePsbtFixture(config);
  const bitcoinTxHex = unsignedTxHexFromSpendPlan(release.spendPlan);
  const redeem = makeRedeem({
    deadline: String(Math.floor(Date.now() / 1000) + 3600),
    destinationScriptHash: keccak256(release.destinationScriptPubKey),
    destinationScriptPubKey: release.destinationScriptPubKey
  });
  let prepared = null;
  let custodyRequest = null;

  const result = await prepareRedeems({
    config,
    store: {
      listRedeemPreparationEligible: () => [redeem],
      markRedeemPrepared: (value) => {
        prepared = value;
      },
      markRedeemFailed: () => assert.fail("valid DON-custody redeem should not fail"),
      markRedeemError: () => assert.fail("valid DON-custody redeem should not be retryable")
    },
    resources: {
      provider: {
        getBlockNumber: async () => 200,
        getBlock: async () => ({ hash: redeem.blockHash })
      },
      bitcoinRpc: {
        call: async () => assert.fail("DON custody must not fund PSBTs through the local Bitcoin wallet")
      },
      donCustody: {
        prepareRelease: async ({ request }) => {
          custodyRequest = request;
          return {
            spendPlan: release.spendPlan,
            bitcoinTxHex
          };
        }
      }
    },
    logger: makeLogger()
  });

  assert.deepEqual(result, { checked: 1, prepared: 1 });
  assert.doesNotThrow(() => assertValid("donReleasePreparationRequest", custodyRequest));
  assert.equal(custodyRequest.kind, "DonReleasePreparationRequestV1");
  assert.equal(custodyRequest.redeemEvent.redeemRequestHash, redeem.redeemRequestHash);
  assert.equal(custodyRequest.destinationAddress, release.destinationAddress);
  assert.equal(prepared.redeemRequestHash, redeem.redeemRequestHash);
  assert.equal(prepared.destinationAddress, release.destinationAddress);
  assert.equal(prepared.psbt, null);
  assert.equal(prepared.bitcoinTxHex, bitcoinTxHex);
  assert.equal(prepared.spendPlan.feeSats, "500");
  assert.equal(prepared.authorization.inputsCommitment, release.authorization.inputsCommitment);
});

test("DON custody client rejects finalized txs that do not match the spend plan", () => {
  const config = makeWorkerConfig();
  const release = makeReleasePsbtFixture(config);
  const validHex = unsignedTxHexFromSpendPlan(release.spendPlan);
  assert.doesNotThrow(() => normalizeDonReleasePreparation({
    data: {
      kind: "DonReleasePreparationResponseV1",
      schemaVersion: "1.0.0",
      spendPlan: release.spendPlan,
      bitcoinTxHex: validHex
    }
  }));

  const tx = bitcoin.Transaction.fromHex(validHex);
  tx.outs[0].value = tx.outs[0].value - 1n;
  assert.throws(
    () => normalizeDonReleasePreparation({
      kind: "DonReleasePreparationResponseV1",
      schemaVersion: "1.0.0",
      spendPlan: release.spendPlan,
      bitcoinTxHex: tx.toHex()
    }),
    /output 0 value does not match spend plan/
  );
});

test("DON custody client validates requests before network calls and accepts Chainlink envelopes", async () => {
  const config = makeWorkerConfig({
    bitcoin: {
      ...makeWorkerConfig().bitcoin,
      treasuryAddress: "tb1qc3r85fhqlv7u933wsexj3ffcwlvtlzchxey3f6"
    }
  });
  const release = makeReleasePsbtFixture(config);
  const redeem = makeRedeem({
    destinationScriptHash: keccak256(release.destinationScriptPubKey),
    destinationScriptPubKey: release.destinationScriptPubKey
  });
  const request = buildDonCustodyReleaseRequest({
    config,
    redeem,
    bridgeConfig: {
      bridgeDomain: config.evm.bridgeDomain,
      btcNetwork: Number(config.bitcoin.btcNetwork),
      sourceEvmChainId: Number(config.evm.chainId)
    },
    destinationAddress: release.destinationAddress
  });
  const bitcoinTxHex = unsignedTxHexFromSpendPlan(release.spendPlan);
  let posted = null;
  const result = await requestDonReleasePreparation({
    url: "https://custody.example.com/release/prepare",
    timeoutMs: 1000,
    request,
    fetchImpl: async (url, options) => {
      posted = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({
          data: {
            kind: "DonReleasePreparationResponseV1",
            schemaVersion: "1.0.0",
            destinationAddress: release.destinationAddress,
            spendPlan: release.spendPlan,
            bitcoinTxHex,
            custodyReceipt: {
              signerSet: "chainlink-don"
            }
          }
        })
      };
    }
  });

  assert.equal(posted.url, "https://custody.example.com/release/prepare");
  assert.equal(posted.body.kind, "DonReleasePreparationRequestV1");
  assert.equal(result.destinationAddress, release.destinationAddress);
  assert.equal(result.bitcoinTxHex, bitcoinTxHex);
  assert.deepEqual(result.custodyReceipt, { signerSet: "chainlink-don" });

  let called = false;
  await assert.rejects(
    () => requestDonReleasePreparation({
      url: "https://custody.example.com/release/prepare",
      timeoutMs: 1000,
      request: { kind: "DonReleasePreparationRequestV1" },
      fetchImpl: async () => {
        called = true;
        throw new Error("fetch should not be called");
      }
    }),
    /donReleasePreparationRequest validation failed/
  );
  assert.equal(called, false);
});

test("public reconciliation fails closed when DON-custody rows lack finalized txs", () => {
  const { dbPath, cleanup } = tempDbPath();
  const store = new PublicTestnetStore(dbPath);
  try {
    const baseConfig = makeWorkerConfig();
    const config = makeWorkerConfig({
      bitcoin: {
        ...baseConfig.bitcoin,
        custodyController: "chainlink-don"
      }
    });
    const release = makeReleasePsbtFixture(config);
    const redeem = makeRedeem({
      deadline: String(Math.floor(Date.now() / 1000) + 3600),
      destinationScriptHash: keccak256(release.destinationScriptPubKey),
      destinationScriptPubKey: release.destinationScriptPubKey
    });
    store.upsertRedeemObserved(redeem);
    store.markRedeemPrepared({
      redeemRequestHash: redeem.redeemRequestHash,
      destinationAddress: release.destinationAddress,
      psbt: null,
      spendPlan: release.spendPlan,
      authorization: release.authorization
    });

    const report = buildPublicTestnetReconciliationReport({
      config,
      store,
      totalSupplySats: "0",
      now: Math.floor(Date.now() / 1000) + 7200,
      staleSeconds: 3600
    });
    assert.equal(report.ok, false);
    assert.equal(report.failures.some((failure) => failure.code === "don_finalized_tx_missing"), true);
    assert.equal(report.warnings.some((warning) => warning.code === "stale_redeems"), true);
  } finally {
    store.close();
    cleanup();
  }
});

test("public worker continuous loop survives transient cycle errors", async () => {
  const config = makeWorkerConfig({
    worker: {
      pollIntervalMs: 1,
      once: false
    }
  });
  const errors = [];
  let calls = 0;

  await runWorkerLoop({
    config,
    store: {},
    resources: {},
    logger: {
      info: () => {},
      error: (event, fields) => errors.push({ event, fields })
    },
    sleepFn: async () => {},
    shouldStop: () => calls >= 2,
    cycle: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("temporary Sepolia RPC timeout");
      }
    }
  });

  assert.equal(calls, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].event, "public_worker_cycle_failed");
  assert.equal(errors[0].fields.error, "temporary Sepolia RPC timeout");
});

test("public worker once mode surfaces cycle errors", async () => {
  const config = makeWorkerConfig({
    worker: {
      pollIntervalMs: 1,
      once: false
    }
  });

  await assert.rejects(
    () => runWorkerLoop({
      config,
      store: {},
      resources: {},
      logger: makeLogger(),
      once: true,
      sleepFn: async () => {},
      cycle: async () => {
        throw new Error("preflight failure");
      }
    }),
    /preflight failure/
  );
});

test("public worker persists submitted EVM completion and reconciles receipt", async () => {
  const config = makeWorkerConfig({
    worker: {
      rpcTimeoutMs: 5,
      rpcMaxRetries: 0,
      rpcRetryDelayMs: 0
    }
  });
  const txHash = bytes32("submitted-complete-redeem");
  let redeem = makeRedeem({
    status: REDEEM_RELEASE_REQUESTED,
    deadline: String(Math.floor(Date.now() / 1000) + 3600),
    releaseAuthorization: makeReleaseAuthorization(),
    releaseRequestId: bytes32("release-request")
  });
  let submitted = null;
  let completed = null;
  let error = null;
  let completeCalls = 0;
  let receiptCalls = 0;
  const store = {
    listReleaseCallbackEligible: () => [redeem],
    markRedeemSubmitted: ({ redeemRequestHash, txHash: submittedTxHash }) => {
      submitted = { redeemRequestHash, txHash: submittedTxHash };
      redeem = {
        ...redeem,
        status: REDEEM_REDEEM_SUBMITTED,
        completeRedeemTxHash: submittedTxHash
      };
    },
    markRedeemCompleted: ({ redeemRequestHash, txHash: completedTxHash, blockNumber }) => {
      completed = { redeemRequestHash, txHash: completedTxHash, blockNumber };
      redeem = {
        ...redeem,
        status: REDEEM_REDEEM_COMPLETED,
        completeRedeemTxHash: completedTxHash,
        completeRedeemBlockNumber: blockNumber
      };
    },
    markRedeemFailed: () => assert.fail("submitted completion should not be marked failed"),
    markRedeemError: (redeemRequestHash, failure) => {
      error = {
        redeemRequestHash,
        message: String(failure && failure.message ? failure.message : failure)
      };
    }
  };

  const first = await settleReleaseCallbacks({
    config,
    store,
    resources: {
      contracts: {
        verifier: {
          pendingRequests: async () => ({
            kind: 2,
            structHash: bytes32("release-struct"),
            requester: "0x3333333333333333333333333333333333333333",
            deadline: "1910000500",
            exists: true,
            fulfilled: true,
            approved: true
          })
        },
        burnGateway: {
          isRedeemIdConsumed: async () => false,
          completeRedeemWithAuthorization: async () => {
            completeCalls += 1;
            return {
              hash: txHash,
              wait: async () => new Promise(() => {})
            };
          }
        }
      }
    },
    logger: makeLogger()
  });

  assert.deepEqual(first, { checked: 1, fulfilled: 1, completed: 0 });
  assert.deepEqual(submitted, { redeemRequestHash: redeem.redeemRequestHash, txHash });
  assert.equal(error.message, "burnGateway.completeRedeemWithAuthorization.wait timed out after 5ms");
  assert.equal(completeCalls, 1);

  const second = await settleReleaseCallbacks({
    config,
    store,
    resources: {
      provider: {
        getTransactionReceipt: async (hash) => {
          receiptCalls += 1;
          assert.equal(hash, txHash);
          return {
            hash,
            status: 1,
            blockNumber: 321
          };
        }
      },
      contracts: {
        verifier: {
          pendingRequests: async () => assert.fail("submitted redeem should reconcile by receipt")
        },
        burnGateway: {
          completeRedeemWithAuthorization: async () => assert.fail("submitted redeem should not resubmit")
        }
      }
    },
    logger: makeLogger()
  });

  assert.deepEqual(second, { checked: 1, fulfilled: 0, completed: 1 });
  assert.equal(receiptCalls, 1);
  assert.equal(completeCalls, 1);
  assert.deepEqual(completed, {
    redeemRequestHash: redeem.redeemRequestHash,
    txHash,
    blockNumber: 321
  });
});

test("public worker reconciles externally consumed redeem ids from contract event", async () => {
  const config = makeWorkerConfig();
  const txHash = bytes32("externally-completed-redeem");
  const blockNumber = 654;
  const releaseAuthorization = makeReleaseAuthorization();
  const redeem = makeRedeem({
    status: REDEEM_RELEASE_REQUESTED,
    deadline: String(Math.floor(Date.now() / 1000) + 3600),
    releaseAuthorization,
    releaseRequestId: bytes32("release-request"),
    blockNumber: 200
  });
  let completed = null;
  let errors = [];

  const result = await settleReleaseCallbacks({
    config,
    store: {
      listReleaseCallbackEligible: () => [redeem],
      markRedeemCompleted: ({ redeemRequestHash, txHash: completedTxHash, blockNumber: completedBlock }) => {
        completed = { redeemRequestHash, txHash: completedTxHash, blockNumber: completedBlock };
      },
      markRedeemFailed: () => assert.fail("consumed redeem with event should not be marked failed"),
      markRedeemError: (redeemRequestHash, failure) => errors.push({ redeemRequestHash, failure })
    },
    resources: {
      contracts: {
        verifier: {
          pendingRequests: async () => ({
            kind: 2,
            structHash: bytes32("release-struct"),
            requester: "0x3333333333333333333333333333333333333333",
            deadline: "1910000500",
            exists: true,
            fulfilled: true,
            approved: true
          })
        },
        burnGateway: {
          isRedeemIdConsumed: async (redeemId) => {
            assert.equal(redeemId, releaseAuthorization.redeemId);
            return true;
          },
          filters: {
            RedeemConsumed: (redeemRequestHash, redeemId) => ({ redeemRequestHash, redeemId })
          },
          queryFilter: async (filter, fromBlock, toBlock) => {
            assert.deepEqual(filter, {
              redeemRequestHash: redeem.redeemRequestHash,
              redeemId: releaseAuthorization.redeemId
            });
            assert.equal(fromBlock, 200);
            assert.equal(toBlock, "latest");
            return [{ transactionHash: txHash, blockNumber }];
          },
          completeRedeemWithAuthorization: async () => assert.fail("consumed redeem should not resubmit completion")
        }
      }
    },
    logger: makeLogger()
  });

  assert.deepEqual(result, { checked: 1, fulfilled: 1, completed: 1 });
  assert.deepEqual(completed, {
    redeemRequestHash: redeem.redeemRequestHash,
    txHash,
    blockNumber
  });
  assert.deepEqual(errors, []);
});

test("public worker retries Bitcoin broadcast with the same finalized transaction hex", async () => {
  const config = makeWorkerConfig();
  const release = makeReleasePsbtFixture(config);
  const finalizedHex = "deadbeef";
  let redeem = makeRedeem({
    status: REDEEM_REDEEM_COMPLETED,
    deadline: String(Math.floor(Date.now() / 1000) + 3600),
    destinationScriptHash: keccak256(release.destinationScriptPubKey),
    destinationScriptPubKey: release.destinationScriptPubKey,
    releaseAuthorization: release.authorization,
    psbt: release.psbt,
    spendPlan: release.spendPlan,
    bitcoinTxHex: null
  });
  let finalizedCount = 0;
  let sendCount = 0;
  const sentHexes = [];
  let broadcast = null;
  let retryableError = null;
  const store = {
    listBitcoinBroadcastEligible: () => [redeem],
    markBitcoinFinalized: ({ redeemRequestHash, txHex }) => {
      assert.equal(redeemRequestHash, redeem.redeemRequestHash);
      redeem = { ...redeem, bitcoinTxHex: txHex };
    },
    markBitcoinBroadcast: ({ redeemRequestHash, txid, txHex }) => {
      broadcast = { redeemRequestHash, txid, txHex };
    },
    markRedeemError: (redeemRequestHash, failure) => {
      retryableError = {
        redeemRequestHash,
        message: String(failure && failure.message ? failure.message : failure)
      };
    }
  };
  const bitcoinRpc = {
    call: async (method, params) => {
      if (method === "walletprocesspsbt") {
        finalizedCount += 1;
        return { psbt: "processed-psbt" };
      }
      if (method === "finalizepsbt") {
        assert.deepEqual(params, ["processed-psbt", true]);
        return { complete: true, hex: finalizedHex };
      }
      if (method === "sendrawtransaction") {
        sendCount += 1;
        sentHexes.push(params[0]);
        if (sendCount === 1) {
          throw new Error("mempool temporarily unavailable");
        }
        return "44".repeat(32);
      }
      throw new Error(`unexpected Bitcoin RPC method ${method}`);
    }
  };

  const first = await broadcastBitcoinReleases({
    config,
    store,
    resources: { bitcoinRpc },
    logger: makeLogger()
  });
  assert.deepEqual(first, { checked: 1, broadcasted: 0 });
  assert.equal(retryableError.message, "mempool temporarily unavailable");
  assert.equal(redeem.bitcoinTxHex, finalizedHex);

  const second = await broadcastBitcoinReleases({
    config,
    store,
    resources: { bitcoinRpc },
    logger: makeLogger()
  });
  assert.deepEqual(second, { checked: 1, broadcasted: 1 });
  assert.equal(finalizedCount, 1);
  assert.deepEqual(sentHexes, [finalizedHex, finalizedHex]);
  assert.deepEqual(broadcast, {
    redeemRequestHash: redeem.redeemRequestHash,
    txid: "44".repeat(32),
    txHex: finalizedHex
  });
});

test("public worker does not locally sign when BTC custody is DON-controlled", async () => {
  const baseConfig = makeWorkerConfig();
  const config = {
    ...baseConfig,
    bitcoin: {
      ...baseConfig.bitcoin,
      custodyController: "chainlink-don"
    }
  };
  const release = makeReleasePsbtFixture(config);
  const redeem = makeRedeem({
    status: REDEEM_REDEEM_COMPLETED,
    destinationScriptHash: keccak256(release.destinationScriptPubKey),
    destinationScriptPubKey: release.destinationScriptPubKey,
    releaseAuthorization: release.authorization,
    psbt: release.psbt,
    spendPlan: release.spendPlan,
    bitcoinTxHex: null
  });
  let error = null;
  const store = {
    listBitcoinBroadcastEligible: () => [redeem],
    markBitcoinFinalized: () => assert.fail("DON-controlled custody must not finalize with local wallet"),
    markBitcoinBroadcast: () => assert.fail("missing DON-finalized tx must not broadcast"),
    markRedeemError: (redeemRequestHash, failure) => {
      error = {
        redeemRequestHash,
        message: String(failure && failure.message ? failure.message : failure)
      };
    }
  };
  const bitcoinRpc = {
    call: async (method) => {
      assert.notEqual(method, "walletprocesspsbt");
      assert.notEqual(method, "finalizepsbt");
      throw new Error(`unexpected Bitcoin RPC method ${method}`);
    }
  };

  const result = await broadcastBitcoinReleases({
    config,
    store,
    resources: { bitcoinRpc },
    logger: makeLogger()
  });

  assert.deepEqual(result, { checked: 1, broadcasted: 0 });
  assert.deepEqual(error, {
    redeemRequestHash: redeem.redeemRequestHash,
    message: "DON-controlled BTC custody requires a finalized Bitcoin transaction from the DON signer"
  });
});

test("public worker revalidates release PSBT against authorization before signing", async () => {
  const config = makeWorkerConfig();
  const release = makeReleasePsbtFixture(config);
  const validRedeem = makeRedeem({
    destinationScriptHash: keccak256(release.destinationScriptPubKey),
    destinationScriptPubKey: release.destinationScriptPubKey,
    releaseAuthorization: release.authorization,
    psbt: release.psbt,
    spendPlan: release.spendPlan
  });

  assert.doesNotThrow(() => assertReleasePsbtMatchesAuthorization({
    redeem: validRedeem,
    bitcoinNetwork: config.bitcoin.bitcoinNetwork
  }));

  assert.throws(
    () => assertReleasePsbtMatchesAuthorization({
      redeem: {
        ...validRedeem,
        releaseAuthorization: {
          ...validRedeem.releaseAuthorization,
          outputsCommitment: bytes32("wrong-outputs")
        }
      },
      bitcoinNetwork: config.bitcoin.bitcoinNetwork
    }),
    /outputsCommitment/
  );
});
