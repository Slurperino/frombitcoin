const fs = require("fs");
const path = require("path");
const Ajv2020 = require("ajv/dist/2020");
const { ROOT } = require("./paths");
const {
  inputsCommitment,
  outputLeaf,
  outputsCommitment,
  psbtPolicyHash
} = require("./bridge");
const { keccak256 } = require("ethers");

const SCHEMA_DIR = path.join(ROOT, "schemas");

const SCHEMAS = {
  bitcoinPsbt: "bitcoin-psbt.schema.json",
  donReleasePreparationRequest: "don-release-preparation-request.schema.json",
  donReleasePreparationResponse: "don-release-preparation-response.schema.json",
  mintAuthorization: "mint-authorization.schema.json",
  releaseAuthorization: "release-authorization.schema.json",
  releaseAttestation: "release-attestation.schema.json",
  normalizedSpendPlan: "normalized-spend-plan.schema.json"
};

const MINT_AUTHORIZATION_FIELDS = [
  "bridgeDomain",
  "depositId",
  "recipient0x",
  "btcNetwork",
  "depositAddressHash",
  "btcTxId",
  "vout",
  "sats",
  "confirmations",
  "observedBlockHeight",
  "attestationTimestamp",
  "deadline"
];

const RELEASE_AUTHORIZATION_FIELDS = [
  "bridgeDomain",
  "redeemRequestHash",
  "redeemId",
  "btcNetwork",
  "sourceEvmChainId",
  "burnTxHash",
  "burnLogIndex",
  "requester",
  "destinationScriptHash",
  "amountSats",
  "maxMinerFeeSats",
  "changePolicyHash",
  "inputsCommitment",
  "outputsCommitment",
  "psbtPolicyHash",
  "attestationTimestamp",
  "deadline"
];

const RELEASE_ATTESTATION_FIELDS = [
  "redeemRequestHash",
  "signerSetDigest",
  "messageDigest",
  "attestation"
];

const BITCOIN_PSBT_FIELDS = [
  "btcNetwork",
  "psbtBase64"
];

const DON_RELEASE_PREPARATION_REQUEST_FIELDS = [
  "kind",
  "schemaVersion",
  "bridgeDomain",
  "btcNetwork",
  "sourceEvmChainId",
  "bitcoinNetwork",
  "treasuryAddress",
  "changePolicyHash",
  "redeemEvent",
  "destinationAddress"
];

const DON_RELEASE_PREPARATION_RESPONSE_FIELDS = [
  "kind",
  "schemaVersion",
  "destinationAddress",
  "spendPlan",
  "bitcoinTxHex",
  "custodyReceipt"
];

function loadSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, SCHEMAS[name]), "utf8"));
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true
});

const loadedSchemas = Object.fromEntries(
  Object.entries(SCHEMAS).map(([name, file]) => [name, loadSchema(name || file)])
);
for (const schema of Object.values(loadedSchemas)) {
  ajv.addSchema(schema);
}

const validators = {
  bitcoinPsbt: validatorFor("bitcoinPsbt"),
  donReleasePreparationRequest: validatorFor("donReleasePreparationRequest"),
  donReleasePreparationResponse: validatorFor("donReleasePreparationResponse"),
  mintAuthorization: validatorFor("mintAuthorization"),
  releaseAuthorization: validatorFor("releaseAuthorization"),
  releaseAttestation: validatorFor("releaseAttestation"),
  normalizedSpendPlan: validatorFor("normalizedSpendPlan")
};

function validatorFor(name) {
  const schema = loadedSchemas[name];
  return ajv.getSchema(schema.$id) || ajv.compile(schema);
}

function formatErrors(validate) {
  return ajv.errorsText(validate.errors, { separator: "; " });
}

function assertValid(schemaName, value) {
  const validate = validators[schemaName];
  if (!validate(value)) {
    throw new Error(`${schemaName} validation failed: ${formatErrors(validate)}`);
  }
}

function pickFields(value, fields) {
  const normalized = {};
  for (const field of fields) {
    normalized[field] = value[field];
  }
  return normalized;
}

function toMintAuthorization(value) {
  assertValid("mintAuthorization", value);
  return pickFields(value, MINT_AUTHORIZATION_FIELDS);
}

function toBitcoinPsbt(value) {
  assertValid("bitcoinPsbt", value);
  return pickFields(value, BITCOIN_PSBT_FIELDS);
}

function toDonReleasePreparationRequest(value) {
  assertValid("donReleasePreparationRequest", value);
  return pickFields(value, DON_RELEASE_PREPARATION_REQUEST_FIELDS);
}

function toDonReleasePreparationResponse(value) {
  assertValid("donReleasePreparationResponse", value);
  return pickFields(value, DON_RELEASE_PREPARATION_RESPONSE_FIELDS);
}

function toReleaseAuthorization(value) {
  assertValid("releaseAuthorization", value);
  return pickFields(value, RELEASE_AUTHORIZATION_FIELDS);
}

function toReleaseAttestation(value) {
  assertValid("releaseAttestation", value);
  return pickFields(value, RELEASE_ATTESTATION_FIELDS);
}

function toNormalizedSpendPlan(value) {
  assertValid("normalizedSpendPlan", value);
  return {
    btcNetwork: value.btcNetwork,
    inputs: value.inputs,
    outputs: value.outputs,
    feeSats: value.feeSats,
    nVersion: value.nVersion,
    nLockTime: value.nLockTime,
    sighashType: value.sighashType
  };
}

function spendPlanCommitments(spendPlan, changePolicyHash) {
  const normalizedSpendPlan = toNormalizedSpendPlan(spendPlan);
  return {
    inputsCommitment: inputsCommitment(normalizedSpendPlan.inputs),
    outputsCommitment: outputsCommitment(normalizedSpendPlan.outputs),
    psbtPolicyHash: psbtPolicyHash(normalizedSpendPlan, changePolicyHash)
  };
}

function verifyReleaseSpendPlan(releaseAuthorizationValue, spendPlanValue) {
  const authorization = toReleaseAuthorization(releaseAuthorizationValue);
  const normalizedSpendPlan = toNormalizedSpendPlan(spendPlanValue);
  const commitments = spendPlanCommitments(spendPlanValue, authorization.changePolicyHash);

  if (BigInt(normalizedSpendPlan.btcNetwork) !== BigInt(authorization.btcNetwork)) {
    throw new Error("spend plan btcNetwork does not match release authorization btcNetwork");
  }

  if (authorization.inputsCommitment !== commitments.inputsCommitment) {
    throw new Error("release authorization inputsCommitment does not match spend plan");
  }

  if (authorization.outputsCommitment !== commitments.outputsCommitment) {
    throw new Error("release authorization outputsCommitment does not match spend plan");
  }

  if (authorization.psbtPolicyHash !== commitments.psbtPolicyHash) {
    throw new Error("release authorization psbtPolicyHash does not match spend plan");
  }

  if (BigInt(spendPlanValue.feeSats) > BigInt(authorization.maxMinerFeeSats)) {
    throw new Error("spend plan fee exceeds release authorization maxMinerFeeSats");
  }

  const destinationOutput = normalizedSpendPlan.outputs.find((output) => {
    return (
      keccak256(output.scriptPubKeyHex) === authorization.destinationScriptHash &&
      BigInt(output.valueSats) === BigInt(authorization.amountSats)
    );
  });

  if (!destinationOutput) {
    throw new Error("spend plan destination output does not match release authorization");
  }

  return {
    authorization,
    commitments,
    destinationOutput,
    destinationOutputLeaf: outputLeaf(destinationOutput)
  };
}

module.exports = {
  assertValid,
  spendPlanCommitments,
  toBitcoinPsbt,
  toDonReleasePreparationRequest,
  toDonReleasePreparationResponse,
  toMintAuthorization,
  toNormalizedSpendPlan,
  toReleaseAttestation,
  toReleaseAuthorization,
  verifyReleaseSpendPlan
};
