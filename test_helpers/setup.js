const ganache = require("ganache");
const { BrowserProvider, NonceManager, Wallet, hexlify, randomBytes, keccak256, toUtf8Bytes } = require("ethers");
const { compileContracts } = require("../scripts/lib/compile");
const {
  buildAttestation,
  deployContract,
  depositId,
  redeemRequestHash,
  sortWalletsByAddress
} = require("../scripts/lib/bridge");

async function createFixture() {
  const server = ganache.provider({
    logging: { quiet: true },
    wallet: { totalAccounts: 10 }
  });

  const provider = new BrowserProvider(server);
  const initialAccounts = server.getInitialAccounts();
  const baseWallets = Object.values(initialAccounts).map((account) => new Wallet(account.secretKey, provider));

  const owner = new NonceManager(baseWallets[0]);
  const alice = new NonceManager(baseWallets[1]);
  const relayer = new NonceManager(baseWallets[2]);
  const donSignerA = baseWallets[3];
  const donSignerB = baseWallets[4];
  const donSignerC = baseWallets[5];
  const spareDonSignerA = baseWallets[6];
  const spareDonSignerB = baseWallets[7];
  const spareDonSignerC = baseWallets[8];

  const donWallets = sortWalletsByAddress([donSignerA, donSignerB, donSignerC]);
  const artifacts = compileContracts();
  const bridgeDomain = keccak256(toUtf8Bytes("BitcoinBride:test"));
  const btcNetwork = 1;
  const minimumConfirmations = 6;
  const threshold = 2;

  const wrappedBitcoin = await deployContract(artifacts.WrappedBitcoin, owner, [
    await owner.getAddress(),
    "BitcoinBride Wrapped BTC",
    "bbBTC",
    8
  ]);

  const verifier = await deployContract(artifacts.AttestationVerifier, owner, [
    bridgeDomain,
    await owner.getAddress(),
    donWallets.map((signer) => signer.address),
    threshold
  ]);

  const registry = await deployContract(artifacts.DepositRegistry, owner, [
    bridgeDomain,
    await owner.getAddress()
  ]);

  const mintGateway = await deployContract(artifacts.MintGateway, owner, [
    await owner.getAddress(),
    await registry.getAddress(),
    await verifier.getAddress(),
    await wrappedBitcoin.getAddress(),
    btcNetwork,
    minimumConfirmations,
    0,
    0
  ]);

  const burnGateway = await deployContract(artifacts.BurnGateway, owner, [
    await owner.getAddress(),
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

  return {
    provider,
    server,
    artifacts,
    bridgeDomain,
    btcNetwork,
    minimumConfirmations,
    threshold,
    owner,
    alice,
    relayer,
    donWallets,
    spareDonWallets: sortWalletsByAddress([spareDonSignerA, spareDonSignerB, spareDonSignerC]),
    contracts: {
      wrappedBitcoin,
      verifier,
      registry,
      mintGateway,
      burnGateway
    }
  };
}

function makeDepositIntent(overrides = {}) {
  return {
    recipient0x: overrides.recipient0x,
    depositAddressHash:
      overrides.depositAddressHash ?? keccak256(toUtf8Bytes(`btc-deposit-${hexlify(randomBytes(8))}`)),
    amountMode: overrides.amountMode ?? 1,
    expectedSats: overrides.expectedSats ?? 0,
    minSats: overrides.minSats ?? 50_000,
    maxSats: overrides.maxSats ?? 200_000,
    nonce: overrides.nonce ?? hexlify(randomBytes(32)),
    expiry: overrides.expiry
  };
}

function makeMintAuthorization({ bridgeDomain, depositIntent, recipient0x, btcNetwork, sats, confirmations, expiry }) {
  const normalizedIntent = {
    ...depositIntent,
    recipient0x
  };

  return {
    bridgeDomain,
    depositId: depositId(bridgeDomain, normalizedIntent),
    recipient0x,
    btcNetwork,
    depositAddressHash: normalizedIntent.depositAddressHash,
    btcTxId: hexlify(randomBytes(32)),
    vout: 1,
    sats,
    confirmations,
    observedBlockHeight: 840_000,
    attestationTimestamp: Math.floor(Date.now() / 1000),
    deadline: expiry
  };
}

function makeRedeemRequest({ requester, destinationScriptHash, amountSats, maxMinerFeeSats, deadline, requestNonce }) {
  return {
    requester,
    destinationScriptHash,
    amountSats,
    maxMinerFeeSats,
    deadline,
    requestNonce
  };
}

async function signMintAuthorization(fixture, authorization) {
  return buildAttestation({
    bridgeDomain: fixture.bridgeDomain,
    authorization,
    kind: "mint",
    signerWallets: fixture.donWallets,
    threshold: fixture.threshold
  });
}

async function signReleaseAuthorization(fixture, authorization) {
  return buildAttestation({
    bridgeDomain: fixture.bridgeDomain,
    authorization,
    kind: "release",
    signerWallets: fixture.donWallets,
    threshold: fixture.threshold
  });
}

module.exports = {
  createFixture,
  makeDepositIntent,
  makeMintAuthorization,
  makeRedeemRequest,
  redeemRequestHash,
  signMintAuthorization,
  signReleaseAuthorization
};
