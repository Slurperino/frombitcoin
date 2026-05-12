const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const bitcoin = require("bitcoinjs-lib");
const { Wallet, keccak256, toUtf8Bytes } = require("ethers");
const { buildAttestation } = require("../scripts/lib/bridge");
const { spendPlanCommitments } = require("../scripts/lib/authorization-validator");
const {
  buildP2wpkhSpendPsbt,
  ECPair,
  extractNormalizedSpendPlanFromPsbt,
  p2wpkhAddressFromWif,
  signPsbtWithWif
} = require("../scripts/lib/bitcoin-psbt");
const { releaseAttestationEnvelope } = require("../scripts/lib/attestation-ingest");
const { BtcSignerStore } = require("../scripts/lib/btc-signer-store");
const { signReleasePsbt } = require("../scripts/lib/btc-policy-signer");

function makeRegtestPsbt({ signerKey, destinationScript, destinationValue = 80_000n, changeValue = 9_500n }) {
  const network = bitcoin.networks.regtest;
  const signerPayment = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(signerKey.publicKey),
    network
  });
  const psbt = new bitcoin.Psbt({ network });
  psbt.setVersion(2);
  psbt.setLocktime(0);
  psbt.addInput({
    hash: Buffer.alloc(32, 1),
    index: 0,
    witnessUtxo: {
      script: signerPayment.output,
      value: 90_000n
    }
  });
  psbt.addOutput({
    script: Buffer.from(destinationScript.slice(2), "hex"),
    value: destinationValue
  });
  psbt.addOutput({
    script: signerPayment.output,
    value: changeValue
  });

  return {
    kind: "BitcoinPsbtV1",
    schemaVersion: "1.0.0",
    btcNetwork: "2",
    psbtBase64: psbt.toBase64()
  };
}

function makeReleaseAuthorization({ spendPlan, bridgeDomain, redeemRequestHash, destinationScript }) {
  const changePolicyHash = keccak256(toUtf8Bytes("regtest-change-policy-v1"));
  const commitments = spendPlanCommitments({
    kind: "NormalizedSpendPlanV1",
    schemaVersion: "1.0.0",
    ...spendPlan
  }, changePolicyHash);

  return {
    kind: "ReleaseAuthorizationV1",
    schemaVersion: "1.0.0",
    bridgeDomain,
    redeemRequestHash,
    redeemId: keccak256(toUtf8Bytes("regtest-redeem-id")),
    btcNetwork: "2",
    sourceEvmChainId: "31337",
    burnTxHash: "0x" + "44".repeat(32),
    burnLogIndex: "7",
    requester: "0x1111111111111111111111111111111111111111",
    destinationScriptHash: keccak256(destinationScript),
    amountSats: "80000",
    maxMinerFeeSats: "600",
    changePolicyHash,
    inputsCommitment: commitments.inputsCommitment,
    outputsCommitment: commitments.outputsCommitment,
    psbtPolicyHash: commitments.psbtPolicyHash,
    attestationTimestamp: "1710000000",
    deadline: "2710001200"
  };
}

test("local P2WPKH PSBT builder creates a signer-verifiable exact spend plan", () => {
  const network = bitcoin.networks.regtest;
  const signerKey = ECPair.makeRandom({ network });
  const destinationKey = ECPair.makeRandom({ network });
  const destinationAddress = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(destinationKey.publicKey),
    network
  }).address;
  const signerAddress = p2wpkhAddressFromWif(signerKey.toWIF(), "regtest");
  const signerScript = bitcoin.address.toOutputScript(signerAddress, network);

  const psbtArtifact = buildP2wpkhSpendPsbt({
    btcNetwork: "2",
    bitcoinNetwork: "regtest",
    utxos: [{
      txid: `0x${"11".repeat(32)}`,
      vout: "1",
      valueSats: "90000",
      scriptPubKeyHex: `0x${Buffer.from(signerScript).toString("hex")}`
    }],
    destinationAddress,
    amountSats: "80000",
    feeSats: "500",
    changeAddress: signerAddress
  });
  const spendPlan = extractNormalizedSpendPlanFromPsbt(psbtArtifact, "regtest");
  const signed = signPsbtWithWif({
    psbtArtifact,
    networkName: "regtest",
    wif: signerKey.toWIF()
  });

  assert.equal(spendPlan.btcNetwork, "2");
  assert.equal(spendPlan.inputs.length, 1);
  assert.equal(spendPlan.inputs[0].vout, "1");
  assert.equal(spendPlan.outputs.map((output) => output.valueSats).join(","), "80000,9500");
  assert.equal(spendPlan.feeSats, "500");
  assert.match(signed.txHex, /^[0-9a-f]+$/);
  assert.match(signed.txid, /^[0-9a-f]{64}$/);
});

test("local BTC policy signer signs only exact DON-authorized PSBT", async (t) => {
  const signerKey = ECPair.makeRandom({ network: bitcoin.networks.regtest });
  const destinationKey = ECPair.makeRandom({ network: bitcoin.networks.regtest });
  const destinationPayment = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(destinationKey.publicKey),
    network: bitcoin.networks.regtest
  });
  const destinationScript = `0x${Buffer.from(destinationPayment.output).toString("hex")}`;
  const psbtArtifact = makeRegtestPsbt({ signerKey, destinationScript });
  const spendPlan = extractNormalizedSpendPlanFromPsbt(psbtArtifact, "regtest");
  const bridgeDomain = keccak256(toUtf8Bytes("BitcoinBride:regtest"));
  const redeemRequestHash = keccak256(toUtf8Bytes("regtest-redeem-request"));
  const authorization = makeReleaseAuthorization({
    spendPlan,
    bridgeDomain,
    redeemRequestHash,
    destinationScript
  });

  const donWallets = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
  const threshold = 2;
  const signedAuthorization = await buildAttestation({
    bridgeDomain,
    authorization,
    kind: "release",
    signerWallets: donWallets,
    threshold
  });
  const attestation = releaseAttestationEnvelope({
    redeemRequestHash,
    signed: signedAuthorization
  });

  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bitcoinbride-btc-signer-"));
  const store = new BtcSignerStore(path.join(dbDir, "signer.sqlite"));
  t.after(() => store.close());

  const dryRun = signReleasePsbt({
    store,
    authorization,
    attestation,
    psbtArtifact,
    bitcoinNetwork: "regtest",
    signerAddresses: donWallets.map((wallet) => wallet.address),
    threshold,
    expectedBridgeDomain: bridgeDomain,
    expectedBtcNetwork: "2",
    dryRun: true,
    now: 1710000100
  });
  assert.equal(dryRun.status, "reserved");

  const result = signReleasePsbt({
    store,
    authorization,
    attestation,
    psbtArtifact,
    bitcoinNetwork: "regtest",
    signerAddresses: donWallets.map((wallet) => wallet.address),
    threshold,
    expectedBridgeDomain: bridgeDomain,
    expectedBtcNetwork: "2",
    wif: signerKey.toWIF(),
    now: 1710000100
  });

  assert.equal(result.status, "signed");
  assert.equal(result.signed.signedInputIndexes.length, 1);
  assert.match(result.signed.txHex, /^[0-9a-f]+$/);
  assert.match(result.signed.txid, /^[0-9a-f]{64}$/);

  const stored = store.getDecision(authorization.redeemId);
  assert.equal(stored.status, "signed");
  assert.equal(stored.txid, result.signed.txid);

  const replay = signReleasePsbt({
    store,
    authorization,
    attestation,
    psbtArtifact,
    bitcoinNetwork: "regtest",
    signerAddresses: donWallets.map((wallet) => wallet.address),
    threshold,
    expectedBridgeDomain: bridgeDomain,
    expectedBtcNetwork: "2",
    wif: signerKey.toWIF(),
    now: 1710000100
  });
  assert.equal(replay.status, "already_signed");

  const driftedPsbt = makeRegtestPsbt({
    signerKey,
    destinationScript,
    destinationValue: 79_999n,
    changeValue: 9_501n
  });

  assert.throws(
    () => signReleasePsbt({
      store,
      authorization,
      attestation,
      psbtArtifact: driftedPsbt,
      bitcoinNetwork: "regtest",
      signerAddresses: donWallets.map((wallet) => wallet.address),
      threshold,
      expectedBridgeDomain: bridgeDomain,
      expectedBtcNetwork: "2",
      wif: signerKey.toWIF(),
      now: 1710000100
    }),
    /outputsCommitment|conflicting signer reservation/
  );
});
