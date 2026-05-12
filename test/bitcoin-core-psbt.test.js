const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const bitcoin = require("bitcoinjs-lib");
const {
  BitcoinCoreRpc,
  walletRpcUrl
} = require("../scripts/lib/bitcoin-core-rpc");
const {
  buildWalletFundedPsbt,
  broadcastRawTransaction,
  scriptPubKeyForAddress
} = require("../scripts/lib/bitcoin-core-psbt");
const { ECPair, networkForName } = require("../scripts/lib/bitcoin-psbt");

function makePsbtForAddress(address) {
  const network = bitcoin.networks.regtest;
  const signerKey = ECPair.makeRandom({ network });
  const signerPayment = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(signerKey.publicKey),
    network
  });
  const psbt = new bitcoin.Psbt({ network });
  psbt.setVersion(2);
  psbt.setLocktime(0);
  psbt.addInput({
    hash: Buffer.alloc(32, 3),
    index: 0,
    witnessUtxo: {
      script: signerPayment.output,
      value: 90_000n
    }
  });
  psbt.addOutput({
    address,
    value: 80_000n
  });
  psbt.addOutput({
    script: signerPayment.output,
    value: 9_500n
  });
  return psbt.toBase64();
}

function startMockRpc(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      body
    });

    try {
      const result = handler(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result, error: null, id: body.id }));
    } catch (error) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        result: null,
        error: { code: -1, message: error.message },
        id: body.id
      }));
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        requests,
        url: `http://127.0.0.1:${server.address().port}`
      });
    });
  });
}

test("Bitcoin Core wallet PSBT builder derives spend plan from RPC PSBT", async (t) => {
  const destinationKey = ECPair.makeRandom({ network: bitcoin.networks.regtest });
  const destinationAddress = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(destinationKey.publicKey),
    network: bitcoin.networks.regtest
  }).address;
  const psbt = makePsbtForAddress(destinationAddress);

  const mock = await startMockRpc((body) => {
    assert.equal(body.method, "walletcreatefundedpsbt");
    assert.equal(body.params[1][0][destinationAddress], 0.0008);
    return {
      psbt,
      fee: 0.000005,
      changepos: 1
    };
  });
  t.after(() => mock.server.close());

  const rpc = new BitcoinCoreRpc({
    rpcUrl: mock.url,
    rpcUser: "user",
    rpcPassword: "pass",
    wallet: "treasury"
  });
  const result = await buildWalletFundedPsbt({
    rpc,
    btcNetwork: "2",
    bitcoinNetwork: "regtest",
    destinationAddress,
    amountSats: "80000",
    locktime: 0
  });

  assert.equal(mock.requests[0].url, "/wallet/treasury");
  assert.match(mock.requests[0].authorization, /^Basic /);
  assert.equal(result.psbt.psbtBase64, psbt);
  assert.equal(result.spendPlan.btcNetwork, "2");
  assert.equal(result.spendPlan.feeSats, "500");
  assert.equal(result.destinationScriptPubKey, scriptPubKeyForAddress(destinationAddress, "regtest"));
  assert.equal(result.changePosition, 1);
  assert.match(result.unsignedPsbtDigest, /^0x[a-fA-F0-9]{64}$/);
});

test("Bitcoin Core broadcaster submits signed transaction hex", async (t) => {
  const mock = await startMockRpc((body) => {
    assert.equal(body.method, "sendrawtransaction");
    assert.deepEqual(body.params, ["deadbeef", 0.1]);
    return "00".repeat(32);
  });
  t.after(() => mock.server.close());

  const rpc = new BitcoinCoreRpc({
    rpcUrl: mock.url,
    rpcUser: "user",
    rpcPassword: "pass"
  });
  const result = await broadcastRawTransaction({
    rpc,
    txHex: "deadbeef",
    maxFeeRate: 0.1
  });

  assert.equal(result.txid, "00".repeat(32));
  assert.equal(walletRpcUrl("http://127.0.0.1:18443/", "treasury wallet"), "http://127.0.0.1:18443/wallet/treasury%20wallet");
});

test("Bitcoin Core RPC retries transient fetch failures with one logical id", async () => {
  const bodies = [];
  let attempts = 0;
  const rpc = new BitcoinCoreRpc({
    rpcUrl: "http://127.0.0.1:18443",
    rpcUser: "user",
    rpcPassword: "pass",
    maxRetries: 1,
    retryDelayMs: 0,
    fetchImpl: async (url, init) => {
      attempts += 1;
      bodies.push(JSON.parse(init.body));
      if (attempts === 1) {
        throw new Error("socket hang up");
      }
      return {
        ok: true,
        json: async () => ({ result: "ok", error: null, id: bodies[0].id })
      };
    }
  });

  assert.equal(await rpc.call("getblockcount"), "ok");
  assert.equal(attempts, 2);
  assert.equal(bodies[0].id, bodies[1].id);
  assert.equal((await rpc.call("getblockhash", [1])), "ok");
  assert.equal(bodies[2].id, bodies[0].id + 1);
});

test("Bitcoin Core RPC aborts timed-out requests", async () => {
  let observedSignal = null;
  const rpc = new BitcoinCoreRpc({
    rpcUrl: "http://127.0.0.1:18443",
    rpcUser: "user",
    rpcPassword: "pass",
    timeoutMs: 5,
    maxRetries: 0,
    fetchImpl: async (url, init) => {
      observedSignal = init.signal;
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    }
  });

  await assert.rejects(rpc.call("getblockcount"), /Bitcoin Core RPC getblockcount timed out after 5ms/);
  assert.equal(observedSignal.aborted, true);
});

test("Bitcoin Core RPC does not retry JSON-RPC application errors", async () => {
  let attempts = 0;
  const rpc = new BitcoinCoreRpc({
    rpcUrl: "http://127.0.0.1:18443",
    rpcUser: "user",
    rpcPassword: "pass",
    maxRetries: 2,
    retryDelayMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      return {
        ok: true,
        json: async () => ({ result: null, error: { message: "boom" }, id: 1 })
      };
    }
  });

  await assert.rejects(rpc.call("getblockcount"), /Bitcoin Core RPC getblockcount failed: boom/);
  assert.equal(attempts, 1);
});

test("signet and testnet4 use Bitcoin testnet address parameters", () => {
  assert.equal(networkForName("signet").bech32, bitcoin.networks.testnet.bech32);
  assert.equal(networkForName("testnet4").bech32, bitcoin.networks.testnet.bech32);
});
