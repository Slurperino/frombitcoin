const bitcoin = require("bitcoinjs-lib");
const { ECPairFactory } = require("ecpair");
const ecc = require("tiny-secp256k1");
const { keccak256, toUtf8Bytes } = require("ethers");
const { toBitcoinPsbt, toNormalizedSpendPlan } = require("./authorization-validator");

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

function networkForName(name) {
  if (name === "mainnet" || name === "bitcoin") {
    return bitcoin.networks.bitcoin;
  }
  if (name === "testnet" || name === "testnet3" || name === "testnet4" || name === "signet") {
    return bitcoin.networks.testnet;
  }
  if (name === "regtest") {
    return bitcoin.networks.regtest;
  }
  throw new Error("bitcoin network must be mainnet, testnet, testnet3, testnet4, signet, or regtest");
}

function parsePsbtArtifact(value, networkName) {
  const artifact = toBitcoinPsbt(value);
  return {
    artifact,
    psbt: bitcoin.Psbt.fromBase64(artifact.psbtBase64, { network: networkForName(networkName) })
  };
}

function psbtInputUtxo(input, txInput) {
  if (input.witnessUtxo) {
    return {
      script: Buffer.from(input.witnessUtxo.script),
      value: BigInt(input.witnessUtxo.value)
    };
  }

  if (input.nonWitnessUtxo) {
    const previousTx = bitcoin.Transaction.fromBuffer(Buffer.from(input.nonWitnessUtxo));
    const output = previousTx.outs[txInput.index];
    if (!output) {
      throw new Error("nonWitnessUtxo is missing referenced output");
    }

    return {
      script: Buffer.from(output.script),
      value: BigInt(output.value)
    };
  }

  throw new Error("PSBT input is missing witnessUtxo or nonWitnessUtxo");
}

function txidFromInputHash(hash) {
  return `0x${Buffer.from(hash).reverse().toString("hex")}`;
}

function bytesHex(bytes) {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function scriptTemplateId(script) {
  return keccak256(bytesHex(script));
}

function sighashTypeFromPsbt(psbt) {
  const explicitTypes = psbt.data.inputs
    .map((input) => input.sighashType)
    .filter((value) => value !== undefined);

  if (explicitTypes.length === 0) {
    return "1";
  }

  const first = explicitTypes[0];
  if (explicitTypes.some((value) => value !== first)) {
    throw new Error("PSBT inputs contain mixed sighash types");
  }

  return String(first);
}

function extractNormalizedSpendPlanFromPsbt(psbtArtifact, networkName) {
  const { artifact, psbt } = parsePsbtArtifact(psbtArtifact, networkName);
  const inputs = [];
  let totalInputSats = 0n;

  for (let i = 0; i < psbt.txInputs.length; i += 1) {
    const txInput = psbt.txInputs[i];
    const input = psbt.data.inputs[i];
    const utxo = psbtInputUtxo(input, txInput);
    totalInputSats += utxo.value;
    inputs.push({
      btcTxId: txidFromInputHash(txInput.hash),
      vout: String(txInput.index),
      valueSats: String(utxo.value),
      scriptTemplateId: scriptTemplateId(utxo.script)
    });
  }

  const outputs = psbt.txOutputs.map((output) => ({
    scriptPubKeyHex: bytesHex(output.script),
    valueSats: String(output.value)
  }));
  const totalOutputSats = outputs.reduce((sum, output) => sum + BigInt(output.valueSats), 0n);
  const feeSats = totalInputSats - totalOutputSats;
  if (feeSats < 0n) {
    throw new Error("PSBT spends more sats than its referenced inputs");
  }

  return toNormalizedSpendPlan({
    kind: "NormalizedSpendPlanV1",
    schemaVersion: "1.0.0",
    btcNetwork: artifact.btcNetwork,
    inputs,
    outputs,
    feeSats: String(feeSats),
    nVersion: String(psbt.version),
    nLockTime: String(psbt.locktime),
    sighashType: sighashTypeFromPsbt(psbt)
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => {
      return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
    }).join(",")}}`;
  }

  return JSON.stringify(value);
}

function spendPlanDigest(spendPlan) {
  const artifact = spendPlan.kind
    ? spendPlan
    : {
        kind: "NormalizedSpendPlanV1",
        schemaVersion: "1.0.0",
        ...spendPlan
      };
  return keccak256(toUtf8Bytes(canonicalJson(toNormalizedSpendPlan(artifact))));
}

function unsignedPsbtDigest(psbtArtifact, networkName) {
  const spendPlan = extractNormalizedSpendPlanFromPsbt(psbtArtifact, networkName);
  return spendPlanDigest(spendPlan);
}

function signerFromWif(wif, networkName) {
  return ECPair.fromWIF(wif, networkForName(networkName));
}

function p2wpkhPaymentFromWif(wif, networkName) {
  const signer = signerFromWif(wif, networkName);
  return bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(signer.publicKey),
    network: networkForName(networkName)
  });
}

function p2wpkhAddressFromWif(wif, networkName) {
  return p2wpkhPaymentFromWif(wif, networkName).address;
}

function txidForPsbtInput(txid) {
  if (typeof txid !== "string") {
    return txid;
  }

  const normalized = txid.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("UTXO txid must be 32 bytes hex");
  }
  return normalized;
}

function buildP2wpkhSpendPsbt({
  btcNetwork,
  bitcoinNetwork,
  utxos,
  destinationAddress,
  amountSats,
  feeSats,
  changeAddress,
  locktime = 0,
  version = 2
}) {
  const network = networkForName(bitcoinNetwork);
  const amount = BigInt(amountSats);
  const fee = BigInt(feeSats);
  const psbt = new bitcoin.Psbt({ network });
  psbt.setVersion(Number(version));
  psbt.setLocktime(Number(locktime));

  let totalInputSats = 0n;
  for (const utxo of utxos) {
    const value = BigInt(utxo.valueSats);
    totalInputSats += value;
    psbt.addInput({
      hash: txidForPsbtInput(utxo.txid),
      index: Number(utxo.vout),
      witnessUtxo: {
        script: Buffer.from(utxo.scriptPubKeyHex.replace(/^0x/, ""), "hex"),
        value
      }
    });
  }

  if (totalInputSats < amount + fee) {
    throw new Error("insufficient UTXO value for amount plus fee");
  }

  psbt.addOutput({
    address: destinationAddress,
    value: amount
  });

  const changeSats = totalInputSats - amount - fee;
  if (changeSats > 0n) {
    if (!changeAddress) {
      throw new Error("changeAddress is required when PSBT has change");
    }
    psbt.addOutput({
      address: changeAddress,
      value: changeSats
    });
  }

  return {
    kind: "BitcoinPsbtV1",
    schemaVersion: "1.0.0",
    btcNetwork: String(btcNetwork),
    psbtBase64: psbt.toBase64()
  };
}

function signPsbtWithWif({ psbtArtifact, networkName, wif, finalize = true }) {
  const { artifact, psbt } = parsePsbtArtifact(psbtArtifact, networkName);
  const signer = signerFromWif(wif, networkName);
  const signedInputIndexes = [];

  for (let i = 0; i < psbt.inputCount; i += 1) {
    try {
      psbt.signInput(i, signer);
      signedInputIndexes.push(i);
    } catch (error) {
      if (!/Can not sign|Cannot sign|not sign/i.test(error.message)) {
        throw error;
      }
    }
  }

  if (signedInputIndexes.length !== psbt.inputCount) {
    throw new Error("local BTC key could not sign every PSBT input");
  }

  const signatureValidator = (pubkey, msghash, signature) => {
    return ECPair.fromPublicKey(pubkey).verify(msghash, signature);
  };
  if (!psbt.validateSignaturesOfAllInputs(signatureValidator)) {
    throw new Error("PSBT signature validation failed");
  }

  let txHex = null;
  let txid = null;
  if (finalize) {
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    txHex = tx.toHex();
    txid = tx.getId();
  }

  return {
    btcNetwork: artifact.btcNetwork,
    signedInputIndexes,
    signedPsbtBase64: psbt.toBase64(),
    txHex,
    txid
  };
}

module.exports = {
  ECPair,
  buildP2wpkhSpendPsbt,
  canonicalJson,
  extractNormalizedSpendPlanFromPsbt,
  networkForName,
  p2wpkhAddressFromWif,
  p2wpkhPaymentFromWif,
  signPsbtWithWif,
  signerFromWif,
  spendPlanDigest,
  unsignedPsbtDigest
};
