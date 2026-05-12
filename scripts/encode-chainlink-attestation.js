const { Command } = require("commander");
const { AbiCoder, isHexString } = require("ethers");

const abiCoder = AbiCoder.defaultAbiCoder();

const program = new Command();
program.requiredOption("--request-id <bytes32>", "Chainlink Functions request id");
program.parse(process.argv);

const { requestId } = program.opts();
if (!isHexString(requestId, 32)) {
  console.error("--request-id must be bytes32 hex");
  process.exitCode = 1;
} else {
  console.log(abiCoder.encode(["bytes32"], [requestId]));
}
