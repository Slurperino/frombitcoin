const test = require("node:test");
const assert = require("node:assert/strict");
const ganache = require("ganache");
const {
  AbiCoder,
  BrowserProvider,
  Contract,
  NonceManager,
  Wallet,
  hexlify,
  keccak256,
  randomBytes,
  toUtf8Bytes
} = require("ethers");

const { compileContracts } = require("../scripts/lib/compile");
const { deployContract, redeemId, releaseStructHash } = require("../scripts/lib/bridge");

const abiCoder = AbiCoder.defaultAbiCoder();

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

async function createChainlinkFixture() {
  const server = ganache.provider({
    logging: { quiet: true },
    wallet: { totalAccounts: 5 }
  });
  const provider = new BrowserProvider(server);
  const accounts = Object.values(server.getInitialAccounts()).map((account) => new Wallet(account.secretKey, provider));
  const owner = new NonceManager(accounts[0]);
  const alice = new NonceManager(accounts[1]);
  const relayer = new NonceManager(accounts[2]);
  const artifacts = compileContracts();
  const bridgeDomain = keccak256(toUtf8Bytes("BitcoinBride:chainlink-functions-test"));
  const ownerAddress = await owner.getAddress();
  const relayerAddress = await relayer.getAddress();
  const btcNetwork = 1;

  const router = await deployContract(artifacts.MockFunctionsRouter, owner);
  const wrappedBitcoin = await deployContract(artifacts.WrappedBitcoin, owner, [
    ownerAddress,
    "BitcoinBride Wrapped BTC",
    "bbBTC",
    8
  ]);
  const verifier = await deployContract(artifacts.ChainlinkFunctionsVerifier, owner, [
    bridgeDomain,
    ownerAddress,
    await router.getAddress(),
    1,
    "0x66756e2d657468657265756d2d7365706f6c69612d3100000000000000000000",
    300000,
    [relayerAddress]
  ]);
  const registry = await deployContract(artifacts.DepositRegistry, owner, [
    bridgeDomain,
    ownerAddress
  ]);
  const mintGateway = await deployContract(artifacts.MintGateway, owner, [
    ownerAddress,
    await registry.getAddress(),
    await verifier.getAddress(),
    await wrappedBitcoin.getAddress(),
    btcNetwork,
    6,
    0,
    0
  ]);
  const burnGateway = await deployContract(artifacts.BurnGateway, owner, [
    ownerAddress,
    await wrappedBitcoin.getAddress(),
    await verifier.getAddress(),
    bridgeDomain,
    btcNetwork,
    31337,
    0,
    0
  ]);

  await (await wrappedBitcoin.connect(owner).setMinter(await mintGateway.getAddress(), true)).wait();
  await (await registry.connect(owner).setAuthorizedConsumer(await mintGateway.getAddress(), true)).wait();
  await (await wrappedBitcoin.connect(owner).setMinter(ownerAddress, true)).wait();

  return {
    server,
    provider,
    artifacts,
    owner,
    alice,
    relayer,
    bridgeDomain,
    btcNetwork,
    contracts: {
      router,
      wrappedBitcoin,
      verifier,
      registry,
      mintGateway,
      burnGateway
    }
  };
}

function parseLog(artifact, receipt, eventName) {
  const contract = new Contract("0x0000000000000000000000000000000000000001", artifact.abi);
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === eventName) {
        return { parsed, log };
      }
    } catch {
      // Ignore logs emitted by other contracts in the same transaction.
    }
  }

  throw new Error(`${eventName} event not found`);
}

test("Chainlink Functions verifier gates release completion on router-approved authorization", async (t) => {
  const fixture = await createChainlinkFixture();
  t.after(async () => fixture.server.disconnect());

  const { alice, relayer, bridgeDomain, btcNetwork, contracts, artifacts } = fixture;
  const aliceAddress = await alice.getAddress();
  const burnGatewayAddress = await contracts.burnGateway.getAddress();

  await (await contracts.wrappedBitcoin.connect(fixture.owner).mint(aliceAddress, 100000)).wait();
  await (await contracts.wrappedBitcoin.connect(alice).approve(burnGatewayAddress, 100000)).wait();

  const destinationScriptPubKey = "0x0014" + "22".repeat(20);
  const burnReceipt = await (
    await contracts.burnGateway.connect(alice).burn(
      destinationScriptPubKey,
      80000,
      500,
      Math.floor(Date.now() / 1000) + 3600
    )
  ).wait();
  const redeemLog = parseLog(artifacts.BurnGateway, burnReceipt, "RedeemRequested");
  const redeemRequestHash = redeemLog.parsed.args.redeemRequestHash;
  const burnLogIndex = Number(redeemLog.log.index);

  const authorization = {
    bridgeDomain,
    redeemRequestHash,
    redeemId: redeemId(bridgeDomain, burnReceipt.hash, burnLogIndex, redeemRequestHash),
    btcNetwork,
    sourceEvmChainId: 31337,
    burnTxHash: burnReceipt.hash,
    burnLogIndex,
    requester: aliceAddress,
    destinationScriptHash: keccak256(destinationScriptPubKey),
    amountSats: 80000,
    maxMinerFeeSats: 500,
    changePolicyHash: hexlify(randomBytes(32)),
    inputsCommitment: hexlify(randomBytes(32)),
    outputsCommitment: hexlify(randomBytes(32)),
    psbtPolicyHash: hexlify(randomBytes(32)),
    attestationTimestamp: Math.floor(Date.now() / 1000),
    deadline: Math.floor(Date.now() / 1000) + 1800
  };

  const requestReceipt = await (
    await contracts.verifier.connect(relayer).requestReleaseAuthorization("0x1234", authorization)
  ).wait();
  const requestLog = parseLog(artifacts.ChainlinkFunctionsVerifier, requestReceipt, "ChainlinkAuthorizationRequested");
  const requestId = requestLog.parsed.args.requestId;
  const attestation = abiCoder.encode(["bytes32"], [requestId]);

  await expectRevert(
    contracts.burnGateway.connect(relayer).completeRedeemWithAuthorization.staticCall(authorization, attestation),
    "ChainlinkRequestFailed|326397e9"
  );

  const response = abiCoder.encode(["uint8", "bytes32"], [2, releaseStructHash(authorization)]);
  await (await contracts.router.fulfill(requestId, response, "0x")).wait();

  await (
    await contracts.burnGateway.connect(relayer).completeRedeemWithAuthorization(authorization, attestation)
  ).wait();

  assert.equal(await contracts.burnGateway.isRedeemIdConsumed(authorization.redeemId), true);
});

test("Chainlink Functions verifier rejects unauthorized requesters and mismatched fulfillments", async (t) => {
  const fixture = await createChainlinkFixture();
  t.after(async () => fixture.server.disconnect());

  const { alice, relayer, bridgeDomain, btcNetwork, contracts, artifacts } = fixture;
  const aliceAddress = await alice.getAddress();
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    bridgeDomain,
    depositId: hexlify(randomBytes(32)),
    recipient0x: aliceAddress,
    btcNetwork,
    depositAddressHash: hexlify(randomBytes(32)),
    btcTxId: hexlify(randomBytes(32)),
    vout: 0,
    sats: 100000,
    confirmations: 6,
    observedBlockHeight: 840000,
    attestationTimestamp: now,
    deadline: now + 1800
  };

  await expectRevert(
    contracts.verifier.connect(alice).requestMintAuthorization.staticCall("0x1234", authorization),
    "UnauthorizedRequester"
  );

  const requestReceipt = await (
    await contracts.verifier.connect(relayer).requestMintAuthorization("0x1234", authorization)
  ).wait();
  const requestLog = parseLog(artifacts.ChainlinkFunctionsVerifier, requestReceipt, "ChainlinkAuthorizationRequested");
  const requestId = requestLog.parsed.args.requestId;

  const wrongResponse = abiCoder.encode(["uint8", "bytes32"], [1, hexlify(randomBytes(32))]);
  await (await contracts.router.fulfill(requestId, wrongResponse, "0x")).wait();

  const attestation = abiCoder.encode(["bytes32"], [requestId]);
  await expectRevert(
    contracts.verifier.verifyMintAuthorization.staticCall(authorization, attestation),
    "ChainlinkRequestFailed"
  );
});

test("Chainlink Functions verifier records malformed fulfillments as rejected", async (t) => {
  const fixture = await createChainlinkFixture();
  t.after(async () => fixture.server.disconnect());

  const { alice, relayer, bridgeDomain, btcNetwork, contracts, artifacts } = fixture;
  const aliceAddress = await alice.getAddress();
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    bridgeDomain,
    depositId: hexlify(randomBytes(32)),
    recipient0x: aliceAddress,
    btcNetwork,
    depositAddressHash: hexlify(randomBytes(32)),
    btcTxId: hexlify(randomBytes(32)),
    vout: 0,
    sats: 100000,
    confirmations: 6,
    observedBlockHeight: 840000,
    attestationTimestamp: now,
    deadline: now + 1800
  };

  const requestReceipt = await (
    await contracts.verifier.connect(relayer).requestMintAuthorization("0x1234", authorization)
  ).wait();
  const requestLog = parseLog(artifacts.ChainlinkFunctionsVerifier, requestReceipt, "ChainlinkAuthorizationRequested");
  const requestId = requestLog.parsed.args.requestId;

  await (await contracts.router.fulfill(requestId, "0x12", "0x")).wait();

  const pending = await contracts.verifier.pendingRequests(requestId);
  assert.equal(pending.fulfilled, true);
  assert.equal(pending.approved, false);

  const attestation = abiCoder.encode(["bytes32"], [requestId]);
  await expectRevert(
    contracts.verifier.verifyMintAuthorization.staticCall(authorization, attestation),
    "ChainlinkRequestFailed"
  );
});
