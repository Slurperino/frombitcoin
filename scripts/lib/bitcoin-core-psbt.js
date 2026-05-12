const bitcoin = require("bitcoinjs-lib");
const {
  extractNormalizedSpendPlanFromPsbt,
  networkForName,
  spendPlanDigest,
  unsignedPsbtDigest
} = require("./bitcoin-psbt");

function satsToBtc(sats) {
  const value = BigInt(sats);
  const whole = value / 100000000n;
  const fraction = value % 100000000n;
  return Number(`${whole}.${fraction.toString().padStart(8, "0")}`);
}

function scriptPubKeyForAddress(address, networkName) {
  const output = bitcoin.address.toOutputScript(address, networkForName(networkName));
  return `0x${Buffer.from(output).toString("hex")}`;
}

function normalizeFundedPsbtResult(result) {
  if (typeof result === "string") {
    return {
      psbt: result,
      fee: null,
      changepos: null
    };
  }

  return {
    psbt: result.psbt,
    fee: result.fee ?? null,
    changepos: result.changepos ?? null
  };
}

async function buildWalletFundedPsbt({
  rpc,
  btcNetwork,
  bitcoinNetwork,
  destinationAddress,
  amountSats,
  locktime = 0,
  feeRateBtcKvB,
  changeAddress,
  minConf,
  lockUnspents,
  replaceable
}) {
  const options = {};
  if (feeRateBtcKvB !== undefined) {
    options.fee_rate = Number(feeRateBtcKvB);
  }
  if (changeAddress !== undefined) {
    options.changeAddress = changeAddress;
  }
  if (minConf !== undefined) {
    options.minconf = Number(minConf);
  }
  if (lockUnspents !== undefined) {
    options.lockUnspents = Boolean(lockUnspents);
  }
  if (replaceable !== undefined) {
    options.replaceable = Boolean(replaceable);
  }

  const output = {};
  output[destinationAddress] = satsToBtc(amountSats);

  const result = normalizeFundedPsbtResult(await rpc.call("walletcreatefundedpsbt", [
    [],
    [output],
    Number(locktime),
    options,
    false
  ]));

  const psbtArtifact = {
    kind: "BitcoinPsbtV1",
    schemaVersion: "1.0.0",
    btcNetwork: String(btcNetwork),
    psbtBase64: result.psbt
  };
  const spendPlan = extractNormalizedSpendPlanFromPsbt(psbtArtifact, bitcoinNetwork);
  const destinationScriptPubKey = scriptPubKeyForAddress(destinationAddress, bitcoinNetwork);

  return {
    psbt: psbtArtifact,
    spendPlan: {
      kind: "NormalizedSpendPlanV1",
      schemaVersion: "1.0.0",
      ...spendPlan
    },
    destinationScriptPubKey,
    changePosition: result.changepos,
    bitcoinCoreFeeBtc: result.fee,
    spendPlanDigest: spendPlanDigest(spendPlan),
    unsignedPsbtDigest: unsignedPsbtDigest(psbtArtifact, bitcoinNetwork)
  };
}

async function broadcastRawTransaction({ rpc, txHex, maxFeeRate }) {
  const params = maxFeeRate === undefined ? [txHex] : [txHex, Number(maxFeeRate)];
  const txid = await rpc.call("sendrawtransaction", params);
  return { txid };
}

module.exports = {
  broadcastRawTransaction,
  buildWalletFundedPsbt,
  satsToBtc,
  scriptPubKeyForAddress
};
