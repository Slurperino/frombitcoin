const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getAddress } = require("ethers");

const SCRIPT_PATH = path.join(__dirname, "..", "scripts", "configure-chainlink-functions.js");
const ROOT = path.join(__dirname, "..");
const BASE_ARGS = [
  "--dry-run",
  "--rpc-url",
  "http://127.0.0.1:8545",
  "--private-key",
  "0x" + "11".repeat(32),
  "--verifier",
  "0x1000000000000000000000000000000000000001",
  "--subscription-id",
  "1",
  "--don-id",
  "testnet-don",
  "--callback-gas-limit",
  "300000"
];

function runConfigure(args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...BASE_ARGS, ...args], {
    cwd: ROOT,
    encoding: "utf8"
  });
}

test("configure-chainlink-functions rejects authorize/revoke requester conflicts", () => {
  const requester = "0x1234567890abcdef1234567890abcdef12345678";
  const result = runConfigure([
    "--authorize-requesters",
    requester,
    "--revoke-requesters",
    getAddress(requester)
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requester cannot be both authorized and revoked/);
});

test("configure-chainlink-functions dry-run accepts non-conflicting requester updates", () => {
  const authorizeRequester = getAddress("0x1234567890abcdef1234567890abcdef12345678");
  const revokeRequester = getAddress("0x2234567890abcdef1234567890abcdef12345678");
  const result = runConfigure([
    "--authorize-requesters",
    authorizeRequester,
    "--revoke-requesters",
    revokeRequester
  ]);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.dryRun, true);
  assert.deepEqual(output.target.authorizeRequesters, [authorizeRequester]);
  assert.deepEqual(output.target.revokeRequesters, [revokeRequester]);
});
