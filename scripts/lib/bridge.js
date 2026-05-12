const { AbiCoder, ContractFactory, Interface, keccak256, getBytes } = require("ethers");

const AUTHORIZATION_CONTEXT_HASH = keccak256(Buffer.from("BitcoinBride.Authorization.V1"));

const abiCoder = AbiCoder.defaultAbiCoder();

const MINT_AUTHORIZATION_TYPES = [
  "tuple(bytes32 bridgeDomain,bytes32 depositId,address recipient0x,uint32 btcNetwork,bytes32 depositAddressHash,bytes32 btcTxId,uint32 vout,uint64 sats,uint32 confirmations,uint64 observedBlockHeight,uint64 attestationTimestamp,uint64 deadline)"
];

const RELEASE_AUTHORIZATION_TYPES = [
  "tuple(bytes32 bridgeDomain,bytes32 redeemRequestHash,bytes32 redeemId,uint32 btcNetwork,uint64 sourceEvmChainId,bytes32 burnTxHash,uint32 burnLogIndex,address requester,bytes32 destinationScriptHash,uint64 amountSats,uint64 maxMinerFeeSats,bytes32 changePolicyHash,bytes32 inputsCommitment,bytes32 outputsCommitment,bytes32 psbtPolicyHash,uint64 attestationTimestamp,uint64 deadline)"
];

const DEPOSIT_INTENT_TYPES = [
  "bytes32",
  "tuple(address recipient0x,bytes32 depositAddressHash,uint8 amountMode,uint64 expectedSats,uint64 minSats,uint64 maxSats,bytes32 nonce,uint64 expiry)"
];

const REDEEM_REQUEST_TYPES = [
  "bytes32",
  "tuple(address requester,bytes32 destinationScriptHash,uint64 amountSats,uint64 maxMinerFeeSats,uint64 deadline,uint64 requestNonce)"
];

const INPUT_LEAF_TYPES = ["bytes32", "uint32", "uint64", "bytes32"];
const OUTPUT_LEAF_TYPES = ["bytes", "uint64"];
const PSBT_POLICY_TYPES = ["uint64", "int32", "uint64", "uint32", "bytes32"];

function sortWalletsByAddress(wallets) {
  return [...wallets].sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
}

function signerSetDigest(signers, threshold) {
  return keccak256(abiCoder.encode(["address[]", "uint256"], [signers, BigInt(threshold)]));
}

function mintStructHash(authorization) {
  return keccak256(abiCoder.encode(MINT_AUTHORIZATION_TYPES, [authorization]));
}

function releaseStructHash(authorization) {
  return keccak256(abiCoder.encode(RELEASE_AUTHORIZATION_TYPES, [authorization]));
}

function depositId(bridgeDomain, intent) {
  return keccak256(abiCoder.encode(DEPOSIT_INTENT_TYPES, [bridgeDomain, intent]));
}

function redeemRequestHash(bridgeDomain, request) {
  return keccak256(abiCoder.encode(REDEEM_REQUEST_TYPES, [bridgeDomain, request]));
}

function redeemId(bridgeDomain, burnTxHash, burnLogIndex, redeemRequestHashValue) {
  return keccak256(
    abiCoder.encode(
      ["bytes32", "bytes32", "uint32", "bytes32"],
      [bridgeDomain, burnTxHash, burnLogIndex, redeemRequestHashValue]
    )
  );
}

function inputLeaf(input) {
  return keccak256(
    abiCoder.encode(
      INPUT_LEAF_TYPES,
      [input.btcTxId, input.vout, input.valueSats, input.scriptTemplateId]
    )
  );
}

function outputLeaf(output) {
  return keccak256(
    abiCoder.encode(
      OUTPUT_LEAF_TYPES,
      [output.scriptPubKeyHex, output.valueSats]
    )
  );
}

function inputsCommitment(inputs) {
  return keccak256(abiCoder.encode(["bytes32[]"], [inputs.map(inputLeaf)]));
}

function outputsCommitment(outputs) {
  return keccak256(abiCoder.encode(["bytes32[]"], [outputs.map(outputLeaf)]));
}

function psbtPolicyHash(spendPlan, changePolicyHash) {
  return keccak256(
    abiCoder.encode(
      PSBT_POLICY_TYPES,
      [
        spendPlan.feeSats,
        spendPlan.nVersion,
        spendPlan.nLockTime,
        spendPlan.sighashType,
        changePolicyHash
      ]
    )
  );
}

function authorizationDigest(bridgeDomain, structHash, signerDigest) {
  return keccak256(
    abiCoder.encode(
      ["bytes32", "bytes32", "bytes32", "bytes32"],
      [AUTHORIZATION_CONTEXT_HASH, bridgeDomain, structHash, signerDigest]
    )
  );
}

async function buildAttestation({ bridgeDomain, authorization, kind, signerWallets, threshold }) {
  const orderedWallets = sortWalletsByAddress(signerWallets);
  const digest = signerSetDigest(
    orderedWallets.map((wallet) => wallet.address),
    threshold
  );

  const structHash = kind === "mint" ? mintStructHash(authorization) : releaseStructHash(authorization);
  const messageDigest = authorizationDigest(bridgeDomain, structHash, digest);

  const signatures = [];
  for (const wallet of orderedWallets.slice(0, threshold)) {
    signatures.push(await wallet.signMessage(getBytes(messageDigest)));
  }

  return {
    signerSetDigest: digest,
    signatures,
    attestation: abiCoder.encode(["bytes32", "bytes[]"], [digest, signatures]),
    structHash,
    messageDigest
  };
}

async function deployContract(artifact, signer, args = []) {
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

function interfaceFor(artifact) {
  return new Interface(artifact.abi);
}

function bytes32FromText(text) {
  return keccak256(Buffer.from(text));
}

function bytes32FromHexLike(bytesLike) {
  return keccak256(getBytes(bytesLike));
}

module.exports = {
  AUTHORIZATION_CONTEXT_HASH,
  authorizationDigest,
  buildAttestation,
  bytes32FromHexLike,
  bytes32FromText,
  deployContract,
  depositId,
  redeemId,
  inputLeaf,
  inputsCommitment,
  interfaceFor,
  mintStructHash,
  outputLeaf,
  outputsCommitment,
  psbtPolicyHash,
  redeemRequestHash,
  releaseStructHash,
  signerSetDigest,
  sortWalletsByAddress
};
