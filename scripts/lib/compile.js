const fs = require("fs");
const path = require("path");
const solc = require("solc");
const { BUILD_DIR, CONTRACTS_DIR, ROOT } = require("./paths");

function findSolidityFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findSolidityFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".sol")) {
      files.push(entryPath);
    }
  }

  return files;
}

function buildCompilerInput() {
  const sources = {};
  for (const absolutePath of findSolidityFiles(CONTRACTS_DIR)) {
    const relativePath = path.relative(ROOT, absolutePath).replaceAll(path.sep, "/");
    sources[relativePath] = { content: fs.readFileSync(absolutePath, "utf8") };
  }

  return {
    language: "Solidity",
    sources,
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"]
        }
      }
    }
  };
}

function compileContracts() {
  const input = buildCompilerInput();
  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors) {
    const fatalErrors = output.errors.filter((error) => error.severity === "error");
    if (fatalErrors.length > 0) {
      const message = fatalErrors.map((error) => error.formattedMessage).join("\n");
      throw new Error(message);
    }
  }

  const artifacts = {};
  for (const [sourceName, contracts] of Object.entries(output.contracts)) {
    for (const [contractName, artifact] of Object.entries(contracts)) {
      artifacts[contractName] = {
        sourceName,
        contractName,
        abi: artifact.abi,
        bytecode: `0x${artifact.evm.bytecode.object}`,
        deployedBytecode: `0x${artifact.evm.deployedBytecode.object}`
      };
    }
  }

  return artifacts;
}

function writeArtifacts(artifacts) {
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  for (const [contractName, artifact] of Object.entries(artifacts)) {
    fs.writeFileSync(
      path.join(BUILD_DIR, `${contractName}.json`),
      JSON.stringify(artifact, null, 2)
    );
  }
}

module.exports = {
  BUILD_DIR,
  ROOT,
  compileContracts,
  writeArtifacts
};
