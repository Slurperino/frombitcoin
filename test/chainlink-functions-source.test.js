const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { AbiCoder, hexlify, keccak256, randomBytes, toUtf8Bytes } = require("ethers");

const { releaseStructHash } = require("../scripts/lib/bridge");

const abiCoder = AbiCoder.defaultAbiCoder();
const ROOT = path.join(__dirname, "..");

function loadSource(name) {
  return fs.readFileSync(path.join(ROOT, "chainlink/functions", name), "utf8");
}

async function runFunctionsSource(source, args, makeHttpRequest) {
  const runner = new Function("args", "Functions", `return (async () => {\n${source}\n})();`);
  return runner(args, { makeHttpRequest });
}

function txObservation({ txid, vout, value, address, blockHeight, blockHash }) {
  return {
    txid,
    status: {
      confirmed: true,
      block_height: blockHeight,
      block_hash: blockHash
    },
    vout: [
      {
        value: String(value),
        scriptpubkey: "0014" + "44".repeat(20),
        scriptpubkey_address: address
      }
    ].map((output, index) => (index === vout ? output : { ...output, value: "0" }))
  };
}

function releaseLogData({
  requestNonce,
  amountSats,
  maxMinerFeeSats,
  deadline,
  destinationScriptPubKey
}) {
  return abiCoder.encode(
    ["uint64", "uint64", "uint64", "uint64", "bytes"],
    [requestNonce, amountSats, maxMinerFeeSats, deadline, destinationScriptPubKey]
  );
}

test("mint Functions source binds depositAddressHash to the observed deposit address", async () => {
  const source = loadSource("mint-authorization.js");
  const depositAddress = "tb1qexampledepositaddress0000000000000000000";
  const txid = "11".repeat(32);
  const authorization = {
    bridgeDomain: hexlify(randomBytes(32)),
    depositId: hexlify(randomBytes(32)),
    recipient0x: "0x" + "22".repeat(20),
    btcNetwork: "3",
    depositAddressHash: keccak256(toUtf8Bytes(depositAddress)),
    btcTxId: `0x${txid}`,
    vout: "0",
    sats: "50000",
    confirmations: "6",
    observedBlockHeight: "105",
    attestationTimestamp: "1700000000",
    deadline: String(Math.floor(Date.now() / 1000) + 1800)
  };
  const mintStructHash = hexlify(randomBytes(32));

  const result = await runFunctionsSource(
    source,
    [
      "https://primary.example",
      "https://secondary.example",
      "6",
      JSON.stringify(authorization),
      depositAddress,
      mintStructHash
    ],
    async ({ url }) => {
      if (url.endsWith("/blocks/tip/height")) {
        return { data: 105 };
      }
      if (url.includes(`/tx/${txid}`)) {
        return {
          data: txObservation({
            txid,
            vout: 0,
            value: "50000",
            address: depositAddress,
            blockHeight: 100,
            blockHash: "aa".repeat(32)
          })
        };
      }
      throw new Error(`unexpected URL ${url}`);
    }
  );

  assert.equal(hexlify(result), abiCoder.encode(["uint8", "bytes32"], [1, mintStructHash]));

  const mismatchedAuthorization = {
    ...authorization,
    depositAddressHash: keccak256(toUtf8Bytes("different-address"))
  };
  await assert.rejects(
    runFunctionsSource(
      source,
      [
        "https://primary.example",
        "https://secondary.example",
        "6",
        JSON.stringify(mismatchedAuthorization),
        depositAddress,
        mintStructHash
      ],
      async ({ url }) => {
        if (url.endsWith("/blocks/tip/height")) {
          return { data: 105 };
        }
        if (url.includes(`/tx/${txid}`)) {
          return {
            data: txObservation({
              txid,
              vout: 0,
              value: "50000",
              address: depositAddress,
              blockHeight: 100,
              blockHash: "aa".repeat(32)
            })
          };
        }
        throw new Error(`unexpected URL ${url}`);
      }
    ),
    /depositAddressHash mismatch/
  );
});

test("release Functions source validates finality policy and expected struct hash", async () => {
  const source = loadSource("release-authorization.js");
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    bridgeDomain: hexlify(randomBytes(32)),
    redeemRequestHash: hexlify(randomBytes(32)),
    redeemId: hexlify(randomBytes(32)),
    btcNetwork: "3",
    sourceEvmChainId: "11155111",
    burnTxHash: hexlify(randomBytes(32)),
    burnLogIndex: "7",
    requester: "0x" + "33".repeat(20),
    destinationScriptHash: hexlify(randomBytes(32)),
    amountSats: "80000",
    maxMinerFeeSats: "500",
    changePolicyHash: hexlify(randomBytes(32)),
    inputsCommitment: hexlify(randomBytes(32)),
    outputsCommitment: hexlify(randomBytes(32)),
    psbtPolicyHash: hexlify(randomBytes(32)),
    attestationTimestamp: String(now),
    deadline: String(now + 1200)
  };
  const contractAuthorization = {
    ...authorization,
    btcNetwork: 3,
    sourceEvmChainId: 11155111,
    burnLogIndex: 7,
    amountSats: 80000,
    maxMinerFeeSats: 500,
    attestationTimestamp: now,
    deadline: now + 1200
  };
  const expectedStructHash = releaseStructHash(contractAuthorization);
  const spendPlan = {
    btcNetwork: "3",
    inputs: [],
    outputs: [],
    feeSats: "500",
    nVersion: "2",
    nLockTime: "0",
    sighashType: "1"
  };
  const event = {
    address: "0x" + "44".repeat(20),
    topics: [
      "0x7ac0a81dedaae7e40426a8a3e125effb9301759ac22c1699db5aad9f04ed8abc",
      authorization.redeemRequestHash,
      `0x${"0".repeat(24)}${authorization.requester.slice(2)}`,
      authorization.destinationScriptHash
    ],
    data: releaseLogData({
      requestNonce: 3,
      amountSats: 80000,
      maxMinerFeeSats: 500,
      deadline: now + 3600,
      destinationScriptPubKey: "0x0014" + "55".repeat(20)
    }),
    blockNumber: "0x64",
    blockHash: "0x" + "66".repeat(32),
    transactionHash: authorization.burnTxHash,
    logIndex: "0x7"
  };

  for (const invalidFinality of ["0", "-1", "1.5"]) {
    await assert.rejects(
      runFunctionsSource(
        source,
        [
          "https://adapter.example",
          "https://primary-rpc.example",
          "https://secondary-rpc.example",
          event.address,
          invalidFinality,
          JSON.stringify(authorization),
          JSON.stringify(spendPlan),
          expectedStructHash
        ],
        async () => ({ data: null })
      ),
      /invalid finality policy/
    );
  }

  async function makeHttpRequest({ url, data }) {
    if (data && data.method === "eth_getTransactionReceipt") {
      return { data: { result: { logs: [event] } } };
    }
    if (data && data.method === "eth_blockNumber") {
      return { data: { result: "0x70" } };
    }
    if (url === "https://adapter.example") {
      return {
        data: {
          statusCode: 200,
          data: {
            signable: true,
            releaseStructHash: expectedStructHash
          }
        }
      };
    }
    throw new Error(`unexpected request ${url}`);
  }

  const result = await runFunctionsSource(
    source,
    [
      "https://adapter.example",
      "https://primary-rpc.example",
      "https://secondary-rpc.example",
      event.address,
      "6",
      JSON.stringify(authorization),
      JSON.stringify(spendPlan),
      expectedStructHash
    ],
    makeHttpRequest
  );
  assert.equal(hexlify(result), abiCoder.encode(["uint8", "bytes32"], [2, expectedStructHash]));

  await assert.rejects(
    runFunctionsSource(
      source,
      [
        "https://adapter.example",
        "https://primary-rpc.example",
        "https://secondary-rpc.example",
        event.address,
        "6",
        JSON.stringify(authorization),
        JSON.stringify(spendPlan),
        hexlify(randomBytes(32))
      ],
      makeHttpRequest
    ),
    /releaseStructHash mismatch/
  );
});

test("request-chainlink-release rejects invalid finality before building request data", () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts/request-chainlink-release.js"),
      "--rpc-url", "http://127.0.0.1:8545",
      "--private-key", "0x" + "11".repeat(32),
      "--verifier", "0x" + "22".repeat(20),
      "--adapter-url", "https://adapter.example",
      "--primary-rpc-url", "https://primary-rpc.example",
      "--secondary-rpc-url", "https://secondary-rpc.example",
      "--burn-gateway", "0x" + "33".repeat(20),
      "--authorization", path.join(ROOT, "does-not-need-to-exist.json"),
      "--spend-plan", path.join(ROOT, "does-not-need-to-exist.json"),
      "--finality-blocks", "0",
      "--dry-run"
    ],
    { encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--finality-blocks must be a positive safe integer/);
});
