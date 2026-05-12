const { compileContracts, writeArtifacts } = require("./lib/compile");

function main() {
  const artifacts = compileContracts();
  writeArtifacts(artifacts);
  console.log(`compiled ${Object.keys(artifacts).length} contracts`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
