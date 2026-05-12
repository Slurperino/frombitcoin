const fs = require("fs");
const path = require("path");
const { BUILD_DIR } = require("./paths");

const REQUIRED_ARTIFACTS = [
  "AttestationVerifier",
  "BurnGateway",
  "DepositRegistry",
  "MintGateway",
  "WrappedBitcoin"
];

function loadArtifact(contractName) {
  const artifactPath = path.join(BUILD_DIR, `${contractName}.json`);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`missing artifact: ${artifactPath}; run npm run build first or deploy with --compile`);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  if (!artifact.abi || !artifact.bytecode || artifact.bytecode === "0x") {
    throw new Error(`invalid artifact: ${artifactPath}`);
  }

  return artifact;
}

function loadArtifacts(contractNames = REQUIRED_ARTIFACTS) {
  const artifacts = {};
  for (const contractName of contractNames) {
    artifacts[contractName] = loadArtifact(contractName);
  }
  return artifacts;
}

module.exports = {
  REQUIRED_ARTIFACTS,
  loadArtifact,
  loadArtifacts
};
