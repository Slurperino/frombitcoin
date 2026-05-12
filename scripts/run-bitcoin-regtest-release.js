const { Command } = require("commander");
const { keccak256, randomBytes, toUtf8Bytes } = require("ethers");
const {
  BitcoinCoreRpc,
  readRpcOptions
} = require("./lib/bitcoin-core-rpc");
const {
  broadcastRawTransaction,
  scriptPubKeyForAddress
} = require("./lib/bitcoin-core-psbt");
const {
  buildP2wpkhSpendPsbt,
  ECPair,
  extractNormalizedSpendPlanFromPsbt,
  networkForName,
  p2wpkhAddressFromWif
} = require("./lib/bitcoin-psbt");
const { spendPlanCommitments } = require("./lib/authorization-validator");
const { buildAttestation, redeemId } = require("./lib/bridge");
const {
  parsePrivateKeys,
  walletsFromPrivateKeys
} = require("./lib/attestation-provider");
const { releaseAttestationEnvelope } = require("./lib/attestation-ingest");
const { BtcSignerStore } = require("./lib/btc-signer-store");
const { signReleasePsbt } = require("./lib/btc-policy-signer");

function readSecret(options, field, envField, name) {
  if (options[field]) {
    return options[field];
  }

  if (options[envField]) {
    const value = process.env[options[envField]];
    if (!value) {
      throw new Error(`${options[envField]} is not set`);
    }
    return value;
  }

  throw new Error(`${name} or ${name}-env must be provided`);
}

async function ensureWallet({ rootRpc, walletName }) {
  if (!walletName) {
    return;
  }

  const loadedWallets = await rootRpc.call("listwallets");
  if (loadedWallets.includes(walletName)) {
    return;
  }

  try {
    await rootRpc.call("loadwallet", [walletName]);
  } catch {
    await rootRpc.call("createwallet", [walletName]);
  }
}

async function ensureRegtestFunds({ rootRpc, walletRpc, minimumBtc = 1 }) {
  const balance = Number(await walletRpc.call("getbalance"));
  if (balance >= minimumBtc) {
    return { mined: 0, balance };
  }

  const address = await walletRpc.call("getnewaddress", ["", "bech32"]);
  await rootRpc.call("generatetoaddress", [101, address]);
  return {
    mined: 101,
    balance: Number(await walletRpc.call("getbalance"))
  };
}

function scriptPubKeyHasAddress(scriptPubKey, address) {
  return scriptPubKey && (
    scriptPubKey.address === address ||
    (Array.isArray(scriptPubKey.addresses) && scriptPubKey.addresses.includes(address))
  );
}

function decodedOutputForAddress(decodedTransaction, address) {
  const output = decodedTransaction.vout.find((candidate) => {
    return scriptPubKeyHasAddress(candidate.scriptPubKey, address);
  });

  if (!output) {
    throw new Error("funding transaction does not contain signer address output");
  }

  return output;
}

async function fundSignerAddress({ rootRpc, walletRpc, signerAddress, amountSats }) {
  const txid = await walletRpc.call("sendtoaddress", [signerAddress, satsToBtc(amountSats)]);
  const minerAddress = await walletRpc.call("getnewaddress", ["", "bech32"]);
  await rootRpc.call("generatetoaddress", [1, minerAddress]);

  const walletTx = await walletRpc.call("gettransaction", [txid, true]);
  const decoded = walletTx.decoded || await rootRpc.call("decoderawtransaction", [walletTx.hex]);
  const output = decodedOutputForAddress(decoded, signerAddress);

  return {
    txid,
    vout: String(output.n),
    valueSats: String(Math.round(Number(output.value) * 100000000)),
    scriptPubKeyHex: `0x${output.scriptPubKey.hex}`
  };
}

function satsToBtc(sats) {
  const value = BigInt(sats);
  const whole = value / 100000000n;
  const fraction = value % 100000000n;
  return Number(`${whole}.${fraction.toString().padStart(8, "0")}`);
}

function makeReleaseAuthorization({
  bridgeDomain,
  btcNetwork,
  sourceEvmChainId,
  requester,
  destinationScriptPubKey,
  spendPlan,
  amountSats,
  maxMinerFeeSats,
  changePolicyHash,
  now,
  ttlSeconds
}) {
  const redeemRequestHash = keccak256(randomBytes(32));
  const burnTxHash = keccak256(randomBytes(32));
  const burnLogIndex = 0;
  const commitments = spendPlanCommitments(spendPlan, changePolicyHash);

  return {
    kind: "ReleaseAuthorizationV1",
    schemaVersion: "1.0.0",
    bridgeDomain,
    redeemRequestHash,
    redeemId: redeemId(bridgeDomain, burnTxHash, burnLogIndex, redeemRequestHash),
    btcNetwork: String(btcNetwork),
    sourceEvmChainId: String(sourceEvmChainId),
    burnTxHash,
    burnLogIndex: String(burnLogIndex),
    requester,
    destinationScriptHash: keccak256(destinationScriptPubKey),
    amountSats: String(amountSats),
    maxMinerFeeSats: String(maxMinerFeeSats),
    changePolicyHash,
    inputsCommitment: commitments.inputsCommitment,
    outputsCommitment: commitments.outputsCommitment,
    psbtPolicyHash: commitments.psbtPolicyHash,
    attestationTimestamp: String(now),
    deadline: String(now + Number(ttlSeconds))
  };
}

async function main() {
  const program = new Command();

  program
    .requiredOption("--rpc-url <url>", "Bitcoin Core regtest RPC URL, e.g. http://127.0.0.1:18443")
    .option("--rpc-user <user>", "Bitcoin Core RPC username")
    .option("--rpc-password <password>", "Bitcoin Core RPC password")
    .option("--rpc-cookie <path>", "Bitcoin Core .cookie path")
    .option("--wallet <name>", "Bitcoin Core funding wallet name", "treasury")
    .option("--btc-network <number>", "bridge btcNetwork id", "2")
    .option("--source-evm-chain-id <number>", "source EVM chain id", "31337")
    .option("--bridge-domain <bytes32>", "bridge domain; generated when omitted")
    .option("--requester <address>", "requester address for synthetic release auth", "0x1111111111111111111111111111111111111111")
    .option("--amount-sats <sats>", "destination amount", "80000")
    .option("--fee-sats <sats>", "exact fee for local signer PSBT", "500")
    .option("--funding-sats <sats>", "amount sent to the local signer UTXO", "90000")
    .option("--max-miner-fee-sats <sats>", "authorization max miner fee", "600")
    .option("--change-policy-hash <bytes32>", "change policy hash", keccak256(toUtf8Bytes("regtest-change-policy-v1")))
    .option("--authorization-ttl-seconds <seconds>", "release authorization TTL", "1200")
    .option("--don-private-keys <hexes>", "comma-separated local/test DON signer private keys")
    .option("--don-private-keys-env <name>", "environment variable containing local/test DON signer private keys", "DON_PRIVATE_KEYS")
    .option("--threshold <number>", "DON attestation threshold", "2")
    .option("--btc-signer-wif <wif>", "local BTC signer WIF; generated when omitted")
    .option("--db <path>", "BTC signer replay DB", "./btc-signer-regtest.sqlite")
    .option("--broadcast", "broadcast the signed transaction", false)
    .option("--mine-confirmation", "mine one confirmation after broadcast", false);

  program.parse(process.argv);
  const options = program.opts();

  const rootRpc = new BitcoinCoreRpc({
    ...readRpcOptions(options),
    wallet: undefined
  });
  await ensureWallet({ rootRpc, walletName: options.wallet });
  const walletRpc = new BitcoinCoreRpc(readRpcOptions(options));
  const funding = await ensureRegtestFunds({ rootRpc, walletRpc });

  const signerWif = options.btcSignerWif || ECPair.makeRandom({
    network: networkForName("regtest")
  }).toWIF();
  const signerAddress = p2wpkhAddressFromWif(signerWif, "regtest");
  const destinationAddress = await walletRpc.call("getnewaddress", ["", "bech32"]);
  const fundedUtxo = await fundSignerAddress({
    rootRpc,
    walletRpc,
    signerAddress,
    amountSats: options.fundingSats
  });

  const psbtArtifact = buildP2wpkhSpendPsbt({
    btcNetwork: options.btcNetwork,
    bitcoinNetwork: "regtest",
    utxos: [fundedUtxo],
    destinationAddress,
    amountSats: options.amountSats,
    feeSats: options.feeSats,
    changeAddress: signerAddress
  });
  const spendPlan = {
    kind: "NormalizedSpendPlanV1",
    schemaVersion: "1.0.0",
    ...extractNormalizedSpendPlanFromPsbt(psbtArtifact, "regtest")
  };
  const destinationScriptPubKey = scriptPubKeyForAddress(destinationAddress, "regtest");
  const now = Math.floor(Date.now() / 1000);
  const bridgeDomain = options.bridgeDomain || keccak256(toUtf8Bytes(`BitcoinBride:regtest:${now}`));
  const authorization = makeReleaseAuthorization({
    bridgeDomain,
    btcNetwork: options.btcNetwork,
    sourceEvmChainId: options.sourceEvmChainId,
    requester: options.requester,
    destinationScriptPubKey,
    spendPlan,
    amountSats: options.amountSats,
    maxMinerFeeSats: options.maxMinerFeeSats,
    changePolicyHash: options.changePolicyHash,
    now,
    ttlSeconds: options.authorizationTtlSeconds
  });

  const donPrivateKeys = readSecret(options, "donPrivateKeys", "donPrivateKeysEnv", "don-private-keys");
  const signerWallets = walletsFromPrivateKeys(parsePrivateKeys(donPrivateKeys));
  const signedAuthorization = await buildAttestation({
    bridgeDomain,
    authorization,
    kind: "release",
    signerWallets,
    threshold: Number(options.threshold)
  });
  const attestation = releaseAttestationEnvelope({
    redeemRequestHash: authorization.redeemRequestHash,
    signed: signedAuthorization
  });

  const store = new BtcSignerStore(options.db);
  let signed;
  try {
    signed = signReleasePsbt({
      store,
      authorization,
      attestation,
      psbtArtifact,
      bitcoinNetwork: "regtest",
      signerAddresses: signerWallets.map((wallet) => wallet.address),
      threshold: Number(options.threshold),
      expectedBridgeDomain: bridgeDomain,
      expectedBtcNetwork: options.btcNetwork,
      wif: signerWif,
      now
    });
  } finally {
    store.close();
  }

  let broadcast = null;
  if (options.broadcast) {
    broadcast = await broadcastRawTransaction({
      rpc: rootRpc,
      txHex: signed.signed.txHex
    });
    if (options.mineConfirmation) {
      const minerAddress = await walletRpc.call("getnewaddress", ["", "bech32"]);
      await rootRpc.call("generatetoaddress", [1, minerAddress]);
    }
  }

  console.log(JSON.stringify(
    {
      funding,
      signerAddress,
      destinationAddress,
      fundedUtxo,
      psbt: psbtArtifact,
      spendPlan,
      destinationScriptPubKey,
      authorization,
      attestation,
      signerWif: options.btcSignerWif ? "<provided>" : signerWif,
      signed: {
        status: signed.status,
        redeemId: signed.policy.contractAuthorization.redeemId,
        txid: signed.signed.txid,
        txHex: signed.signed.txHex,
        signedPsbtBase64: signed.signed.signedPsbtBase64
      },
      broadcast
    },
    null,
    2
  ));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
