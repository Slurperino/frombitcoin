const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { keccak256, toUtf8Bytes, hexlify, randomBytes, ZeroAddress } = require("ethers");

const {
  createFixture,
  makeDepositIntent,
  makeMintAuthorization,
  makeRedeemRequest,
  redeemRequestHash,
  signMintAuthorization,
  signReleaseAuthorization
} = require("../test_helpers/setup");
const { buildAttestation, redeemId } = require("../scripts/lib/bridge");
const { RedeemStore } = require("../scripts/lib/redeem-store");
const {
  authorizeFinalizedRedeems,
  scanRedeemRequests
} = require("../scripts/lib/evm-redeem-watcher");
const { attestAuthorizedRedeems } = require("../scripts/lib/attestation-provider");
const {
  ingestReleaseAttestation,
  releaseAttestationEnvelope
} = require("../scripts/lib/attestation-ingest");
const { relayAttestedRedeems } = require("../scripts/lib/release-relayer");

async function expectRevert(promise, expectedReason) {
  try {
    const result = await promise;
    if (result && typeof result.wait === "function") {
      await assert.rejects(result.wait());
      return;
    }
    assert.fail("Missing expected rejection");
  } catch (error) {
    if (!expectedReason) {
      return;
    }
    assert.match(error.message, new RegExp(expectedReason));
  }
}

test("mintWithAuthorization mints once and blocks deposit replay", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fixture.server.disconnect());

  const { alice, relayer, bridgeDomain, btcNetwork, minimumConfirmations, contracts } = fixture;
  const aliceAddress = await alice.getAddress();

  const now = Math.floor(Date.now() / 1000);
  const intent = makeDepositIntent({
    recipient0x: aliceAddress,
    minSats: 50_000,
    maxSats: 150_000,
    expiry: now + 3600
  });

  await (await contracts.registry.connect(alice).createDepositIntent(intent)).wait();

  const authorization = makeMintAuthorization({
    bridgeDomain,
    depositIntent: intent,
    recipient0x: aliceAddress,
    btcNetwork,
    sats: 100_000,
    confirmations: minimumConfirmations,
    expiry: now + 1800
  });

  const { attestation } = await signMintAuthorization(fixture, authorization);

  await (
    await contracts.mintGateway
      .connect(relayer)
      .mintWithAuthorization(intent, authorization, attestation)
  ).wait();

  assert.equal((await contracts.wrappedBitcoin.balanceOf(aliceAddress)).toString(), "100000");
  assert.equal(await contracts.registry.isDepositConsumed(authorization.depositId), true);

  await expectRevert(
    contracts.mintGateway.connect(relayer).mintWithAuthorization.staticCall(intent, authorization, attestation)
  );
  assert.equal((await contracts.wrappedBitcoin.balanceOf(aliceAddress)).toString(), "100000");
  assert.equal(await contracts.registry.isDepositConsumed(authorization.depositId), true);
});

test("mintWithAuthorization rejects mismatched or insufficient DON authorization", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fixture.server.disconnect());

  const { alice, relayer, bridgeDomain, btcNetwork, minimumConfirmations, contracts } = fixture;
  const aliceAddress = await alice.getAddress();

  const now = Math.floor(Date.now() / 1000);
  const intent = makeDepositIntent({
    recipient0x: aliceAddress,
    amountMode: 0,
    expectedSats: 75_000,
    minSats: 75_000,
    maxSats: 75_000,
    expiry: now + 3600
  });

  await (await contracts.registry.connect(alice).createDepositIntent(intent)).wait();

  const validAuthorization = makeMintAuthorization({
    bridgeDomain,
    depositIntent: intent,
    recipient0x: aliceAddress,
    btcNetwork,
    sats: 75_000,
    confirmations: minimumConfirmations,
    expiry: now + 1800
  });

  const { attestation } = await signMintAuthorization(fixture, validAuthorization);

  const badAuthorization = {
    ...validAuthorization,
    sats: 74_999
  };

  await expectRevert(
    contracts.mintGateway.connect(relayer).mintWithAuthorization.staticCall(intent, badAuthorization, attestation)
  );
  assert.equal((await contracts.wrappedBitcoin.balanceOf(aliceAddress)).toString(), "0");
  assert.equal(await contracts.registry.isDepositConsumed(validAuthorization.depositId), false);

  const lowConfirmationAuthorization = {
    ...validAuthorization,
    confirmations: minimumConfirmations - 1
  };
  const lowConfirmationAttestation = await signMintAuthorization(fixture, lowConfirmationAuthorization);

  await expectRevert(
    contracts.mintGateway
      .connect(relayer)
      .mintWithAuthorization.staticCall(intent, lowConfirmationAuthorization, lowConfirmationAttestation.attestation)
  );
  assert.equal((await contracts.wrappedBitcoin.balanceOf(aliceAddress)).toString(), "0");
  assert.equal(await contracts.registry.isDepositConsumed(validAuthorization.depositId), false);
});

test("mint policy rejects zero-sat ANY intents", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fixture.server.disconnect());

  const { alice, relayer, bridgeDomain, btcNetwork, minimumConfirmations, contracts } = fixture;
  const aliceAddress = await alice.getAddress();
  const now = Math.floor(Date.now() / 1000);
  const zeroMinimumIntent = makeDepositIntent({
    recipient0x: aliceAddress,
    minSats: 0,
    maxSats: 50_000,
    expiry: now + 3600
  });

  await expectRevert(
    contracts.registry.connect(alice).createDepositIntent.staticCall(zeroMinimumIntent),
    "InvalidDepositIntent"
  );

  const zeroSatsAuthorization = makeMintAuthorization({
    bridgeDomain,
    depositIntent: zeroMinimumIntent,
    recipient0x: aliceAddress,
    btcNetwork,
    sats: 0,
    confirmations: minimumConfirmations,
    expiry: now + 1800
  });
  const { attestation } = await signMintAuthorization(fixture, zeroSatsAuthorization);

  await expectRevert(
    contracts.mintGateway
      .connect(relayer)
      .mintWithAuthorization.staticCall(zeroMinimumIntent, zeroSatsAuthorization, attestation),
    "MintAmountOutOfRange"
  );
});

test("burn flow records redeem request and burns wrapped balance", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fixture.server.disconnect());

  const { owner, alice, contracts } = fixture;
  const aliceAddress = await alice.getAddress();
  const ownerAddress = await owner.getAddress();

  await (await contracts.wrappedBitcoin.connect(owner).setMinter(ownerAddress, true)).wait();
  await (await contracts.wrappedBitcoin.connect(owner).mint(aliceAddress, 150_000)).wait();
  await (await contracts.wrappedBitcoin.connect(alice).approve(await contracts.burnGateway.getAddress(), 150_000)).wait();

  const now = Math.floor(Date.now() / 1000);
  const destinationScriptPubKey = "0x0014" + "11".repeat(20);

  const tx = await contracts.burnGateway
    .connect(alice)
    .burn(destinationScriptPubKey, 100_000, 500, now + 3600);
  const receipt = await tx.wait();

  assert.equal((await contracts.wrappedBitcoin.balanceOf(aliceAddress)).toString(), "50000");

  const event = receipt.logs
    .map((log) => {
      try {
        return contracts.burnGateway.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === "RedeemRequested");

  assert.ok(event, "RedeemRequested event not found");

  const requestNonce = 0;
  const request = makeRedeemRequest({
    requester: aliceAddress,
    destinationScriptHash: keccak256(destinationScriptPubKey),
    amountSats: 100_000,
    maxMinerFeeSats: 500,
    deadline: now + 3600,
    requestNonce
  });

  const expectedRedeemRequestHash = redeemRequestHash(fixture.bridgeDomain, request);
  assert.equal(event.args.redeemRequestHash, expectedRedeemRequestHash);

  const stored = await contracts.burnGateway.getRedeemRequest(expectedRedeemRequestHash);
  assert.equal(stored[0].requester, aliceAddress);
  assert.equal(stored[0].amountSats.toString(), "100000");
  assert.equal(stored[1], 1n);
});

test("burn rejects unsupported BTC destination scripts before burning", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fixture.server.disconnect());

  const { owner, alice, contracts } = fixture;
  const aliceAddress = await alice.getAddress();
  const ownerAddress = await owner.getAddress();

  await (await contracts.wrappedBitcoin.connect(owner).setMinter(ownerAddress, true)).wait();
  await (await contracts.wrappedBitcoin.connect(owner).mint(aliceAddress, 50_000)).wait();
  await (await contracts.wrappedBitcoin.connect(alice).approve(await contracts.burnGateway.getAddress(), 50_000)).wait();

  const now = Math.floor(Date.now() / 1000);
  const p2pkhScriptPubKey = "0x76a914" + "11".repeat(20) + "88ac";
  await expectRevert(
    contracts.burnGateway.connect(alice).burn.staticCall(p2pkhScriptPubKey, 10_000, 500, now + 3600),
    "InvalidDestinationScript"
  );

  assert.equal((await contracts.wrappedBitcoin.balanceOf(aliceAddress)).toString(), "50000");
  await (await contracts.burnGateway.connect(alice).burn("0x5120" + "22".repeat(32), 10_000, 500, now + 3600)).wait();
  assert.equal((await contracts.wrappedBitcoin.balanceOf(aliceAddress)).toString(), "40000");
});

test("release authorization digest can be attested against signer quorum", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fixture.server.disconnect());

  const { alice, contracts, bridgeDomain, btcNetwork } = fixture;
  const requester = await alice.getAddress();
  const destinationScriptHash = keccak256("0x5120" + "22".repeat(32));
  const burnTxHash = hexlify(randomBytes(32));
  const redeemRequestHashValue = redeemRequestHash(bridgeDomain, {
    requester,
    destinationScriptHash,
    amountSats: 80_000,
    maxMinerFeeSats: 400,
    deadline: Math.floor(Date.now() / 1000) + 1800,
    requestNonce: 7
  });

  const releaseAuthorization = {
    bridgeDomain,
    redeemRequestHash: redeemRequestHashValue,
    redeemId: redeemId(bridgeDomain, burnTxHash, 7, redeemRequestHashValue),
    btcNetwork,
    sourceEvmChainId: 31337,
    burnTxHash,
    burnLogIndex: 7,
    requester,
    destinationScriptHash,
    amountSats: 80_000,
    maxMinerFeeSats: 400,
    changePolicyHash: keccak256(toUtf8Bytes("change-policy-v1")),
    inputsCommitment: keccak256("0x1234"),
    outputsCommitment: keccak256("0x5678"),
    psbtPolicyHash: keccak256("0x90ab"),
    attestationTimestamp: Math.floor(Date.now() / 1000),
    deadline: Math.floor(Date.now() / 1000) + 1200
  };

  const { attestation } = await signReleaseAuthorization(fixture, releaseAuthorization);

  await contracts.verifier.verifyReleaseAuthorization(releaseAuthorization, attestation);
});

test("redeem completion requires DON release authorization", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fixture.server.disconnect());

  const { owner, alice, relayer, contracts, bridgeDomain, btcNetwork } = fixture;
  const aliceAddress = await alice.getAddress();
  const ownerAddress = await owner.getAddress();

  await (await contracts.wrappedBitcoin.connect(owner).setMinter(ownerAddress, true)).wait();
  await (await contracts.wrappedBitcoin.connect(owner).mint(aliceAddress, 90_000)).wait();
  await (await contracts.wrappedBitcoin.connect(alice).approve(await contracts.burnGateway.getAddress(), 90_000)).wait();

  const now = Math.floor(Date.now() / 1000);
  const destinationScriptPubKey = "0x0014" + "66".repeat(20);
  const burnTx = await contracts.burnGateway
    .connect(alice)
    .burn(destinationScriptPubKey, 80_000, 600, now + 3600);
  const burnReceipt = await burnTx.wait();

  const redeemLog = burnReceipt.logs
    .map((log) => {
      try {
        return { log, parsed: contracts.burnGateway.interface.parseLog(log) };
      } catch {
        return null;
      }
    })
    .find((entry) => entry && entry.parsed && entry.parsed.name === "RedeemRequested");
  assert.ok(redeemLog, "RedeemRequested event not found");

  const redeemRequestHashValue = redeemLog.parsed.args.redeemRequestHash;
  const burnLogIndex = Number(redeemLog.log.index ?? 0);
  const redeemIdValue = redeemId(bridgeDomain, burnReceipt.hash, burnLogIndex, redeemRequestHashValue);

  const releaseAuthorization = {
    bridgeDomain,
    redeemRequestHash: redeemRequestHashValue,
    redeemId: redeemIdValue,
    btcNetwork,
    sourceEvmChainId: 31337,
    burnTxHash: burnReceipt.hash,
    burnLogIndex,
    requester: aliceAddress,
    destinationScriptHash: keccak256(destinationScriptPubKey),
    amountSats: 80_000,
    maxMinerFeeSats: 600,
    changePolicyHash: keccak256(toUtf8Bytes("change-policy-v1")),
    inputsCommitment: keccak256("0x1234"),
    outputsCommitment: keccak256("0x5678"),
    psbtPolicyHash: keccak256("0x90ab"),
    attestationTimestamp: now,
    deadline: now + 1200
  };

  const badAuthorization = {
    ...releaseAuthorization,
    amountSats: 79_999
  };
  const badSignedAuthorization = await signReleaseAuthorization(fixture, badAuthorization);
  await expectRevert(
    contracts.burnGateway
      .connect(relayer)
      .completeRedeemWithAuthorization.staticCall(badAuthorization, badSignedAuthorization.attestation)
  );

  const badRedeemIdAuthorization = {
    ...releaseAuthorization,
    redeemId: redeemId(bridgeDomain, hexlify(randomBytes(32)), burnLogIndex, redeemRequestHashValue)
  };
  const badRedeemIdSignedAuthorization = await signReleaseAuthorization(fixture, badRedeemIdAuthorization);
  await expectRevert(
    contracts.burnGateway
      .connect(relayer)
      .completeRedeemWithAuthorization.staticCall(
        badRedeemIdAuthorization,
        badRedeemIdSignedAuthorization.attestation
      ),
    "ReleaseAuthorizationMismatch"
  );

  await expectRevert(contracts.burnGateway.connect(owner).setRedeemState.staticCall(redeemRequestHashValue, 2));

  const { attestation } = await signReleaseAuthorization(fixture, releaseAuthorization);
  await (
    await contracts.burnGateway
      .connect(relayer)
      .completeRedeemWithAuthorization(releaseAuthorization, attestation)
  ).wait();

  const stored = await contracts.burnGateway.getRedeemRequest(redeemRequestHashValue);
  assert.equal(stored[1], 2n);
  assert.equal(await contracts.burnGateway.isRedeemIdConsumed(redeemIdValue), true);

  await expectRevert(
    contracts.burnGateway
      .connect(relayer)
      .completeRedeemWithAuthorization.staticCall(releaseAuthorization, attestation)
  );
});

test("EVM redeem watcher persists finalized burns and builds release authorization", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fixture.server.disconnect());

  const { owner, alice, relayer, contracts } = fixture;
  const aliceAddress = await alice.getAddress();
  const ownerAddress = await owner.getAddress();

  await (await contracts.wrappedBitcoin.connect(owner).setMinter(ownerAddress, true)).wait();
  await (await contracts.wrappedBitcoin.connect(owner).mint(aliceAddress, 90_000)).wait();
  await (await contracts.wrappedBitcoin.connect(alice).approve(await contracts.burnGateway.getAddress(), 90_000)).wait();

  const now = Math.floor(Date.now() / 1000);
  const destinationScriptPubKey = "0x0014" + "77".repeat(20);
  const burnTx = await contracts.burnGateway
    .connect(alice)
    .burn(destinationScriptPubKey, 80_000, 600, now + 3600);
  const burnReceipt = await burnTx.wait();

  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bitcoinbride-redeems-"));
  const store = new RedeemStore(path.join(dbDir, "redeems.sqlite"));
  t.after(() => store.close());

  const events = await scanRedeemRequests({
    burnGateway: contracts.burnGateway,
    store,
    fromBlock: burnReceipt.blockNumber,
    toBlock: burnReceipt.blockNumber
  });

  assert.equal(events.length, 1);
  const storedEvent = store.getRedeemEvent(events[0].redeemRequestHash);
  assert.equal(storedEvent.txHash, burnReceipt.hash);
  assert.equal(storedEvent.status, "observed");

  const changePolicyHash = keccak256(toUtf8Bytes("change-policy-v1"));
  const spendPlan = {
    kind: "NormalizedSpendPlanV1",
    schemaVersion: "1.0.0",
    btcNetwork: "1",
    inputs: [
      {
        btcTxId: "0x" + "88".repeat(32),
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
        scriptPubKeyHex: "0x0014" + "99".repeat(20),
        valueSats: "9500"
      }
    ],
    feeSats: "500",
    nVersion: "2",
    nLockTime: "0",
    sighashType: "1"
  };

  const authorizations = await authorizeFinalizedRedeems({
    provider: fixture.provider,
    burnGateway: contracts.burnGateway,
    store,
    finalityBlocks: 0,
    spendPlan,
    changePolicyHash,
    ttlSeconds: 1200,
    latestBlockNumber: burnReceipt.blockNumber,
    now
  });

  assert.equal(authorizations.length, 1);
  const authorization = authorizations[0];
  assert.equal(authorization.redeemRequestHash, events[0].redeemRequestHash);
  assert.equal(authorization.destinationScriptHash, keccak256(destinationScriptPubKey));

  const authorizedEvent = store.getRedeemEvent(authorization.redeemRequestHash);
  assert.equal(authorizedEvent.status, "authorized");
  assert.equal(authorizedEvent.releaseAuthorization.redeemId, authorization.redeemId);

  const relayBeforeAttestation = await relayAttestedRedeems({
    burnGateway: contracts.burnGateway.connect(relayer),
    store,
    now
  });
  assert.equal(relayBeforeAttestation.length, 0);

  const attestations = await attestAuthorizedRedeems({
    store,
    signerWallets: fixture.donWallets,
    threshold: fixture.threshold,
    now
  });

  assert.equal(attestations.length, 1);
  assert.equal(attestations[0].redeemRequestHash, authorization.redeemRequestHash);

  const attestedEvent = store.getRedeemEvent(authorization.redeemRequestHash);
  assert.equal(attestedEvent.status, "attested");
  assert.equal(attestedEvent.messageDigest, attestations[0].messageDigest);
  assert.ok(attestedEvent.attestation);

  const ingested = ingestReleaseAttestation({
    store,
    envelope: releaseAttestationEnvelope({
      redeemRequestHash: authorization.redeemRequestHash,
      signed: {
        signerSetDigest: attestedEvent.signerSetDigest,
        messageDigest: attestedEvent.messageDigest,
        attestation: attestedEvent.attestation
      }
    }),
    signerAddresses: fixture.donWallets.map((wallet) => wallet.address),
    threshold: fixture.threshold,
    now
  });

  assert.equal(ingested.redeemRequestHash, authorization.redeemRequestHash);
  assert.equal(ingested.messageDigest, attestations[0].messageDigest);

  const relayed = await relayAttestedRedeems({
    burnGateway: contracts.burnGateway.connect(relayer),
    store,
    now
  });

  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].redeemRequestHash, authorization.redeemRequestHash);
  assert.equal(relayed[0].status, "consumed");

  const stored = await contracts.burnGateway.getRedeemRequest(authorization.redeemRequestHash);
  assert.equal(stored[1], 2n);

  const consumedEvent = store.getRedeemEvent(authorization.redeemRequestHash);
  assert.equal(consumedEvent.status, "consumed");
  assert.equal(consumedEvent.relayTxHash, relayed[0].txHash);
  assert.equal(consumedEvent.relayBlockNumber, relayed[0].blockNumber);

  const repeatedRelay = await relayAttestedRedeems({
    burnGateway: contracts.burnGateway.connect(relayer),
    store,
    now
  });
  assert.equal(repeatedRelay.length, 0);
});

test("owner-only controls and pause gates are enforced", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fixture.server.disconnect());

  const { owner, alice, relayer, bridgeDomain, btcNetwork, minimumConfirmations, contracts } = fixture;
  const aliceAddress = await alice.getAddress();

  await expectRevert(contracts.mintGateway.connect(alice).setMintPaused.staticCall(true));
  await expectRevert(contracts.burnGateway.connect(alice).setBurnPaused.staticCall(true));
  await expectRevert(contracts.mintGateway.connect(alice).setMintLimit.staticCall(1, 1));
  await expectRevert(contracts.mintGateway.connect(owner).setMinimumConfirmations.staticCall(0), "InvalidMinimumConfirmations");
  assert.equal(await contracts.mintGateway.minimumConfirmations(), BigInt(minimumConfirmations));
  await expectRevert(contracts.burnGateway.connect(alice).setRedeemLimit.staticCall(1, 1));
  await expectRevert(contracts.registry.connect(alice).setAuthorizedConsumer.staticCall(await alice.getAddress(), true));
  await expectRevert(contracts.wrappedBitcoin.connect(alice).setMinter.staticCall(await alice.getAddress(), true));

  const now = Math.floor(Date.now() / 1000);
  const intent = makeDepositIntent({
    recipient0x: aliceAddress,
    minSats: 10_000,
    maxSats: 50_000,
    expiry: now + 3600
  });

  await (await contracts.registry.connect(alice).createDepositIntent(intent)).wait();

  const authorization = makeMintAuthorization({
    bridgeDomain,
    depositIntent: intent,
    recipient0x: aliceAddress,
    btcNetwork,
    sats: 25_000,
    confirmations: minimumConfirmations,
    expiry: now + 1800
  });

  const { attestation } = await signMintAuthorization(fixture, authorization);

  await (await contracts.mintGateway.connect(owner).setMintPaused(true)).wait();
  await expectRevert(
    contracts.mintGateway.connect(relayer).mintWithAuthorization.staticCall(intent, authorization, attestation)
  );
  assert.equal((await contracts.wrappedBitcoin.balanceOf(aliceAddress)).toString(), "0");

  await (await contracts.mintGateway.connect(owner).setMintPaused(false)).wait();
  await (await contracts.mintGateway.connect(relayer).mintWithAuthorization(intent, authorization, attestation)).wait();
  assert.equal((await contracts.wrappedBitcoin.balanceOf(aliceAddress)).toString(), "25000");

  await (await contracts.wrappedBitcoin.connect(alice).approve(await contracts.burnGateway.getAddress(), 25_000)).wait();
  await (await contracts.burnGateway.connect(owner).setBurnPaused(true)).wait();
  await expectRevert(
    contracts.burnGateway.connect(alice).burn.staticCall("0x0014" + "33".repeat(20), 10_000, 500, now + 3600)
  );

  await (await contracts.burnGateway.connect(owner).setBurnPaused(false)).wait();
  await (await contracts.burnGateway.connect(alice).burn("0x0014" + "33".repeat(20), 10_000, 500, now + 3600)).wait();
  assert.equal((await contracts.wrappedBitcoin.balanceOf(aliceAddress)).toString(), "15000");
});

test("ownership transfer requires pending owner acceptance", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fixture.server.disconnect());

  const { owner, alice, relayer, contracts } = fixture;
  const ownerAddress = await owner.getAddress();
  const aliceAddress = await alice.getAddress();

  assert.equal(await contracts.mintGateway.owner(), ownerAddress);
  assert.equal(await contracts.mintGateway.pendingOwner(), ZeroAddress);

  await (await contracts.mintGateway.connect(owner).transferOwnership(aliceAddress)).wait();
  assert.equal(await contracts.mintGateway.owner(), ownerAddress);
  assert.equal(await contracts.mintGateway.pendingOwner(), aliceAddress);

  await expectRevert(contracts.mintGateway.connect(alice).setMintPaused.staticCall(true));
  await expectRevert(contracts.mintGateway.connect(relayer).acceptOwnership.staticCall());

  await (await contracts.mintGateway.connect(owner).cancelOwnershipTransfer()).wait();
  assert.equal(await contracts.mintGateway.pendingOwner(), ZeroAddress);
  await expectRevert(contracts.mintGateway.connect(alice).acceptOwnership.staticCall());

  await (await contracts.mintGateway.connect(owner).transferOwnership(aliceAddress)).wait();
  await (await contracts.mintGateway.connect(alice).acceptOwnership()).wait();

  assert.equal(await contracts.mintGateway.owner(), aliceAddress);
  assert.equal(await contracts.mintGateway.pendingOwner(), ZeroAddress);

  await expectRevert(contracts.mintGateway.connect(owner).setMintPaused.staticCall(true));
  await (await contracts.mintGateway.connect(alice).setMintPaused(true)).wait();
  assert.equal(await contracts.mintGateway.mintPaused(), true);
});

test("lockdown pins token minter and registry consumer across ownership renounce", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fixture.server.disconnect());

  const { owner, alice, contracts } = fixture;
  const ownerAddress = await owner.getAddress();
  const aliceAddress = await alice.getAddress();

  await (await contracts.wrappedBitcoin.connect(owner).setMinter(ownerAddress, true)).wait();
  await (await contracts.wrappedBitcoin.connect(owner).setMinter(aliceAddress, true)).wait();
  await (await contracts.wrappedBitcoin.connect(owner).lockMinter(ownerAddress)).wait();

  assert.equal(await contracts.wrappedBitcoin.minterLocked(), true);
  assert.equal(await contracts.wrappedBitcoin.lockedMinter(), ownerAddress);
  await expectRevert(
    contracts.wrappedBitcoin.connect(alice).mint.staticCall(aliceAddress, 1),
    "NotMinter"
  );
  await expectRevert(
    contracts.wrappedBitcoin.connect(owner).setMinter.staticCall(aliceAddress, false),
    "MinterConfigurationLocked"
  );

  await (await contracts.wrappedBitcoin.connect(owner).renounceOwnership()).wait();
  assert.equal(await contracts.wrappedBitcoin.owner(), ZeroAddress);
  await expectRevert(contracts.wrappedBitcoin.connect(owner).setMinter.staticCall(aliceAddress, true));
  await (await contracts.wrappedBitcoin.connect(owner).mint(aliceAddress, 1)).wait();
  assert.equal((await contracts.wrappedBitcoin.balanceOf(aliceAddress)).toString(), "1");

  const now = Math.floor(Date.now() / 1000);
  const intent = makeDepositIntent({
    recipient0x: aliceAddress,
    minSats: 1_000,
    maxSats: 2_000,
    expiry: now + 3600
  });
  const depositId = await contracts.registry.computeDepositId(intent);

  await (await contracts.registry.connect(owner).setAuthorizedConsumer(aliceAddress, true)).wait();
  await (await contracts.registry.connect(owner).lockAuthorizedConsumer(ownerAddress)).wait();
  assert.equal(await contracts.registry.consumerLocked(), true);
  assert.equal(await contracts.registry.lockedConsumer(), ownerAddress);
  await expectRevert(
    contracts.registry.connect(alice).consumeDeposit.staticCall(depositId, hexlify(randomBytes(32)), 0, 1_500),
    "Unauthorized"
  );
  await expectRevert(
    contracts.registry.connect(owner).setAuthorizedConsumer.staticCall(aliceAddress, false),
    "ConsumerConfigurationLocked"
  );

  await (await contracts.registry.connect(owner).renounceOwnership()).wait();
  assert.equal(await contracts.registry.owner(), ZeroAddress);
  await expectRevert(contracts.registry.connect(owner).setAuthorizedConsumer.staticCall(aliceAddress, true));
  await (await contracts.registry.connect(alice).createDepositIntent(intent)).wait();
  await (
    await contracts.registry.connect(owner).consumeDeposit(depositId, hexlify(randomBytes(32)), 0, 1_500)
  ).wait();
  assert.equal(await contracts.registry.isDepositConsumed(depositId), true);
});

test("mint and redeem rate limits are enforced and reset on reconfiguration", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fixture.server.disconnect());

  const { owner, alice, relayer, bridgeDomain, btcNetwork, minimumConfirmations, contracts } = fixture;
  const aliceAddress = await alice.getAddress();
  const now = Math.floor(Date.now() / 1000);

  await (await contracts.mintGateway.connect(owner).setMintLimit(40_000, 3600)).wait();

  const firstIntent = makeDepositIntent({
    recipient0x: aliceAddress,
    minSats: 25_000,
    maxSats: 25_000,
    expiry: now + 3600
  });
  await (await contracts.registry.connect(alice).createDepositIntent(firstIntent)).wait();

  const firstAuthorization = makeMintAuthorization({
    bridgeDomain,
    depositIntent: firstIntent,
    recipient0x: aliceAddress,
    btcNetwork,
    sats: 25_000,
    confirmations: minimumConfirmations,
    expiry: now + 1800
  });
  const firstSignedAuthorization = await signMintAuthorization(fixture, firstAuthorization);

  await (
    await contracts.mintGateway
      .connect(relayer)
      .mintWithAuthorization(firstIntent, firstAuthorization, firstSignedAuthorization.attestation)
  ).wait();

  const secondIntent = makeDepositIntent({
    recipient0x: aliceAddress,
    minSats: 20_000,
    maxSats: 20_000,
    expiry: now + 3600
  });
  await (await contracts.registry.connect(alice).createDepositIntent(secondIntent)).wait();

  const secondAuthorization = makeMintAuthorization({
    bridgeDomain,
    depositIntent: secondIntent,
    recipient0x: aliceAddress,
    btcNetwork,
    sats: 20_000,
    confirmations: minimumConfirmations,
    expiry: now + 1800
  });
  const secondSignedAuthorization = await signMintAuthorization(fixture, secondAuthorization);

  await expectRevert(
    contracts.mintGateway
      .connect(relayer)
      .mintWithAuthorization.staticCall(secondIntent, secondAuthorization, secondSignedAuthorization.attestation)
  );
  assert.equal((await contracts.wrappedBitcoin.balanceOf(aliceAddress)).toString(), "25000");
  assert.equal(await contracts.registry.isDepositConsumed(secondAuthorization.depositId), false);

  await (await contracts.mintGateway.connect(owner).setMintLimit(100_000, 3600)).wait();
  await (
    await contracts.mintGateway
      .connect(relayer)
      .mintWithAuthorization(secondIntent, secondAuthorization, secondSignedAuthorization.attestation)
  ).wait();
  assert.equal((await contracts.wrappedBitcoin.balanceOf(aliceAddress)).toString(), "45000");

  await (await contracts.wrappedBitcoin.connect(alice).approve(await contracts.burnGateway.getAddress(), 45_000)).wait();
  await (await contracts.burnGateway.connect(owner).setRedeemLimit(40_000, 3600)).wait();

  await (
    await contracts.burnGateway.connect(alice).burn("0x0014" + "44".repeat(20), 25_000, 500, now + 3600)
  ).wait();

  await expectRevert(
    contracts.burnGateway.connect(alice).burn.staticCall("0x0014" + "55".repeat(20), 20_000, 500, now + 3600)
  );
  assert.equal((await contracts.wrappedBitcoin.balanceOf(aliceAddress)).toString(), "20000");

  await (await contracts.burnGateway.connect(owner).setRedeemLimit(100_000, 3600)).wait();
  await (
    await contracts.burnGateway.connect(alice).burn("0x0014" + "55".repeat(20), 20_000, 500, now + 3600)
  ).wait();
  assert.equal((await contracts.wrappedBitcoin.balanceOf(aliceAddress)).toString(), "0");
});

test("signer threshold and rotation invalidate stale attestations", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fixture.server.disconnect());

  const { owner, alice, contracts, bridgeDomain, btcNetwork, minimumConfirmations, threshold } = fixture;
  const aliceAddress = await alice.getAddress();
  const now = Math.floor(Date.now() / 1000);

  const intent = makeDepositIntent({
    recipient0x: aliceAddress,
    minSats: 20_000,
    maxSats: 80_000,
    expiry: now + 3600
  });
  const authorization = makeMintAuthorization({
    bridgeDomain,
    depositIntent: intent,
    recipient0x: aliceAddress,
    btcNetwork,
    sats: 50_000,
    confirmations: minimumConfirmations,
    expiry: now + 1800
  });

  const oldAttestation = await signMintAuthorization(fixture, authorization);
  await contracts.verifier.verifyMintAuthorization(authorization, oldAttestation.attestation);

  const insufficientAttestation = await buildAttestation({
    bridgeDomain,
    authorization,
    kind: "mint",
    signerWallets: fixture.donWallets,
    threshold: 1
  });
  await expectRevert(contracts.verifier.verifyMintAuthorization(authorization, insufficientAttestation.attestation));

  await (
    await contracts.verifier
      .connect(owner)
      .setSignerSet(fixture.spareDonWallets.map((wallet) => wallet.address), threshold)
  ).wait();

  await expectRevert(contracts.verifier.verifyMintAuthorization(authorization, oldAttestation.attestation));

  const newAttestation = await buildAttestation({
    bridgeDomain,
    authorization,
    kind: "mint",
    signerWallets: fixture.spareDonWallets,
    threshold
  });
  await contracts.verifier.verifyMintAuthorization(authorization, newAttestation.attestation);
});

test("deposit registry rejects direct consumption by non-consumers", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fixture.server.disconnect());

  const { alice, contracts } = fixture;
  const aliceAddress = await alice.getAddress();
  const now = Math.floor(Date.now() / 1000);
  const intent = makeDepositIntent({
    recipient0x: aliceAddress,
    minSats: 1_000,
    maxSats: 2_000,
    expiry: now + 3600
  });

  const depositId = await contracts.registry.computeDepositId(intent);
  await (await contracts.registry.connect(alice).createDepositIntent(intent)).wait();

  await expectRevert(
    contracts.registry
      .connect(alice)
      .consumeDeposit.staticCall(depositId, hexlify(randomBytes(32)), 0, 1_500)
  );

  assert.equal(await contracts.registry.isDepositConsumed(depositId), false);
});
