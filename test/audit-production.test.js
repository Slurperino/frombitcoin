const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isDevOnlyVulnerability,
  topLevelPackageName
} = require("../scripts/audit-production");

test("production audit helper identifies top-level packages from nested node_modules paths", () => {
  assert.equal(topLevelPackageName("node_modules/ganache/node_modules/ajv"), "ganache");
  assert.equal(topLevelPackageName("node_modules/@scope/pkg/node_modules/dep"), "@scope/pkg");
  assert.equal(topLevelPackageName("build/output.json"), null);
});

test("production audit helper suppresses only vulnerabilities wholly under dev dependencies", () => {
  const devDependencies = new Set(["ganache"]);
  assert.equal(
    isDevOnlyVulnerability({ nodes: ["node_modules/ganache/node_modules/ajv"] }, devDependencies),
    true
  );
  assert.equal(
    isDevOnlyVulnerability({
      nodes: [
        "node_modules/ganache/node_modules/ajv",
        "node_modules/ajv/node_modules/fast-uri"
      ]
    }, devDependencies),
    false
  );
});
