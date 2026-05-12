const fs = require("fs");
const { spawnSync } = require("child_process");
const { loadDonReleaseAdapterConfig } = require("./lib/don-release-adapter");
const { loadPublicTestnetConfig } = require("./lib/public-testnet-config");
const { loadRedeemServiceConfig } = require("./lib/service-runtime");

const NODE_CHECK_FILES = [
  "scripts/redeem-service.js",
  "scripts/audit-production.js",
  "scripts/lib/service-runtime.js",
  "scripts/lib/attestation-ingest.js",
  "scripts/lib/release-relayer.js",
  "scripts/lib/bitcoin-psbt.js",
  "scripts/lib/bitcoin-core-rpc.js",
  "scripts/lib/bitcoin-core-psbt.js",
  "scripts/lib/don-release-adapter.js",
  "scripts/lib/don-release-verifier.js",
  "scripts/lib/don-custody-client.js",
  "scripts/lib/redeem-event-source.js",
  "scripts/lib/btc-policy-signer.js",
  "scripts/lib/btc-signer-store.js",
  "scripts/lib/chainlink-functions-request.js",
  "scripts/lib/public-testnet-chainlink.js",
  "scripts/lib/public-testnet-config.js",
  "scripts/lib/public-testnet-reconciliation.js",
  "scripts/lib/public-testnet-store.js",
  "scripts/public-testnet-api.js",
  "scripts/public-testnet-worker.js",
  "scripts/public-testnet-reconcile.js",
  "scripts/sign-release-psbt.js",
  "scripts/verify-don-release.js",
  "scripts/fetch-redeem-event.js",
  "scripts/build-bitcoin-psbt.js",
  "scripts/broadcast-bitcoin-tx.js",
  "scripts/configure-chainlink-functions.js",
  "scripts/request-chainlink-mint.js",
  "scripts/request-chainlink-release.js",
  "scripts/encode-chainlink-attestation.js",
  "scripts/don-release-adapter.js",
  "scripts/run-bitcoin-regtest-release.js"
];

const CHAINLINK_FUNCTIONS_SOURCE_FILES = [
  "chainlink/functions/mint-authorization.js",
  "chainlink/functions/release-authorization.js"
];

const REDEEM_CONFIG_FILES = [
  "config/redeem-service.example.json",
  "config/redeem-watcher.testnet.example.json",
  "config/redeem-attester-local.testnet.example.json",
  "config/redeem-relayer.testnet.example.json",
  "config/redeem-watcher.sepolia-signet.example.json",
  "config/redeem-relayer.sepolia-signet.example.json",
  "config/redeem-watcher.sepolia-signet-chainlink.example.json",
  "config/redeem-relayer.sepolia-signet-chainlink.example.json"
];

const DON_ADAPTER_CONFIG_FILES = [
  "config/don-release-adapter.example.json",
  "config/don-release-adapter.sepolia-signet.example.json",
  "config/don-release-adapter.sepolia-signet-chainlink.example.json"
];

const PUBLIC_TESTNET_CONFIG_FILES = [
  "config/public-testnet.sepolia-signet-chainlink.example.json",
  "config/public-testnet.sepolia-signet-chainlink.docker.example.json"
];

const REQUIRED_FILES = [
  "Dockerfile",
  ".dockerignore",
  "public/index.html",
  "public/styles.css",
  "public/app.js",
  "public/favicon.svg",
  "schemas/don-release-preparation-request.schema.json",
  "schemas/don-release-preparation-response.schema.json",
  "ops/env/redeem-service.env.example",
  "ops/docker/compose.testnet.example.yml",
  "ops/docker/compose.sepolia-signet-chainlink.example.yml",
  "ops/caddy/Caddyfile.chainlink-adapter.example",
  "ops/systemd/bitcoinbride-redeem-watcher.service",
  "ops/systemd/bitcoinbride-redeem-attester-local.service",
  "ops/systemd/bitcoinbride-redeem-relayer.service",
  "ops/systemd/bitcoinbride-don-release-adapter.service",
  "ops/systemd/bitcoinbride-public-testnet-api.service",
  "ops/systemd/bitcoinbride-public-testnet-worker.service",
  "ops/systemd/bitcoinbride-public-testnet-reconcile.service",
  "ops/systemd/bitcoinbride-public-testnet-reconcile.timer",
  "docs/testnet-operations-runbook.md",
  "docs/chainlink-functions-testnet-runbook.md",
  "docs/don-custody-interface-v1.md",
  "docs/public-testnet-runbook.md"
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertFile(path) {
  assert(fs.existsSync(path), `${path} is missing`);
  return fs.readFileSync(path, "utf8");
}

for (const file of NODE_CHECK_FILES) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`${file} failed node --check`);
  }
}

for (const file of CHAINLINK_FUNCTIONS_SOURCE_FILES) {
  const source = fs.readFileSync(file, "utf8");
  const wrappedSource = `async function __chainlinkFunctionsSource__() {\n${source}\n}\n`;
  const result = spawnSync(process.execPath, ["--check"], {
    encoding: "utf8",
    input: wrappedSource
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`${file} failed wrapped node --check`);
  }
}

for (const file of REDEEM_CONFIG_FILES) {
  loadRedeemServiceConfig(file);
}

for (const file of DON_ADAPTER_CONFIG_FILES) {
  const config = loadDonReleaseAdapterConfig(file);
  assert(config.http.port === 8790, `${file} must use checked-in adapter default port 8790`);
}

for (const file of PUBLIC_TESTNET_CONFIG_FILES) {
  loadPublicTestnetConfig(file);
}

for (const file of REQUIRED_FILES) {
  assertFile(file);
}

const watcherUnit = assertFile("ops/systemd/bitcoinbride-redeem-watcher.service");
assert(watcherUnit.includes("--role watcher"), "watcher unit must run watcher role");
assert(watcherUnit.includes("ReadWritePaths=/var/lib/bitcoinbride"), "watcher unit must allow data directory writes");

const attesterUnit = assertFile("ops/systemd/bitcoinbride-redeem-attester-local.service");
assert(attesterUnit.includes("--role attester"), "attester unit must run attester role");
assert(attesterUnit.includes("EnvironmentFile=/etc/bitcoinbride/redeem-service.env"), "attester unit must load env file");

const relayerUnit = assertFile("ops/systemd/bitcoinbride-redeem-relayer.service");
assert(relayerUnit.includes("--role relayer"), "relayer unit must run relayer role");
assert(relayerUnit.includes("EnvironmentFile=/etc/bitcoinbride/redeem-service.env"), "relayer unit must load env file");

const donAdapterUnit = assertFile("ops/systemd/bitcoinbride-don-release-adapter.service");
assert(donAdapterUnit.includes("service:don-release-adapter"), "DON adapter unit must run DON release adapter");
assert(donAdapterUnit.includes("ReadWritePaths=/var/lib/bitcoinbride"), "DON adapter unit must allow data directory writes");

const publicApiUnit = assertFile("ops/systemd/bitcoinbride-public-testnet-api.service");
assert(publicApiUnit.includes("service:public-testnet-api"), "public API unit must run public testnet API");
assert(publicApiUnit.includes("EnvironmentFile=/etc/bitcoinbride/redeem-service.env"), "public API unit must load env file");

const publicWorkerUnit = assertFile("ops/systemd/bitcoinbride-public-testnet-worker.service");
assert(publicWorkerUnit.includes("service:public-testnet-worker"), "public worker unit must run public testnet worker");
assert(publicWorkerUnit.includes("ReadWritePaths=/var/lib/bitcoinbride"), "public worker unit must allow data directory writes");

const publicReconcileUnit = assertFile("ops/systemd/bitcoinbride-public-testnet-reconcile.service");
assert(publicReconcileUnit.includes("reconcile:public-testnet"), "public reconcile unit must run public testnet reconciliation");
assert(publicReconcileUnit.includes("--fail-on-warning"), "public reconcile unit must fail on reconciliation warnings");

const compose = assertFile("ops/docker/compose.testnet.example.yml");
for (const service of ["redeem-watcher", "redeem-attester-local", "redeem-relayer", "don-release-adapter"]) {
  assert(compose.includes(`${service}:`), `compose file must include ${service}`);
}
assert(compose.includes("BITCOINBRIDE_HEALTH_HOST: 0.0.0.0"), "compose file must expose container health servers");
assert(compose.includes("redeem-data:"), "compose file must declare durable redeem-data volume");
assert(compose.includes("127.0.0.1:8790:8790"), "compose file must publish DON adapter on default port 8790");

const chainlinkCompose = assertFile("ops/docker/compose.sepolia-signet-chainlink.example.yml");
assert(chainlinkCompose.includes("don-release-adapter:"), "Chainlink compose must include DON release adapter");
assert(chainlinkCompose.includes("public-testnet-api:"), "Chainlink compose must include public API");
assert(chainlinkCompose.includes("public-testnet-worker:"), "Chainlink compose must include public worker");
assert(chainlinkCompose.includes("public-testnet-reconcile:"), "Chainlink compose must include public reconciliation profile");
assert(chainlinkCompose.includes("caddy:"), "Chainlink compose must include HTTPS reverse proxy");
assert(chainlinkCompose.includes("443:443"), "Chainlink compose must publish HTTPS");
assert(chainlinkCompose.includes("BITCOINBRIDE_ADAPTER_PORT: 8790"), "Chainlink compose must set default adapter port 8790");
assert(chainlinkCompose.includes("- \"8790\""), "Chainlink compose must expose default adapter port 8790");

const caddyfile = assertFile("ops/caddy/Caddyfile.chainlink-adapter.example");
assert(caddyfile.includes("/release/preflight"), "Caddyfile must expose release preflight");
assert(caddyfile.includes("don-release-adapter:8790"), "Caddyfile must proxy to DON release adapter");
assert(caddyfile.includes("public-testnet-api:8880"), "Caddyfile must proxy to public API");

const dockerfile = assertFile("Dockerfile");
assert(dockerfile.includes("node:22"), "Dockerfile must use Node 22 or newer");
assert(dockerfile.includes("npm prune --omit=dev"), "Dockerfile must prune dev dependencies");
assert(dockerfile.includes("COPY chainlink ./chainlink"), "Dockerfile must include Chainlink Functions sources");
assert(dockerfile.includes("COPY public ./public"), "Dockerfile must include public frontend assets");
assert(dockerfile.includes("COPY scripts ./scripts"), "Dockerfile must include runtime scripts");
assert(dockerfile.includes("COPY config ./config"), "Dockerfile must include public example configs");
assert(dockerfile.includes("CMD [\"npm\", \"run\", \"service:redeems\", \"--\", \"--help\"]"), "Dockerfile default CMD must not require an unmounted /config file");

const dockerignore = assertFile(".dockerignore");
for (const pattern of [
  ".git",
  "*.local.json",
  "ops/runs/",
  "*.log",
  "*.pid",
  ".DS_Store",
  "._*",
  ".codex-rlm/",
  ".turbo-context/"
]) {
  assert(dockerignore.includes(pattern), `.dockerignore must exclude ${pattern}`);
}

const gitignore = assertFile(".gitignore");
for (const pattern of ["ops/runs/", "*.log", "*.pid", ".DS_Store", "._*", ".codex-rlm/", ".turbo-context/"]) {
  assert(gitignore.includes(pattern), `.gitignore must exclude ${pattern}`);
}

const publicRunbook = assertFile("docs/public-testnet-runbook.md");
assert(publicRunbook.includes("checked-in adapter default is `8790`"), "public testnet runbook must document adapter default port 8790");
assert(publicRunbook.includes("public-testnet override; default examples and Caddy use `8790`"), "public testnet runbook must label 8791 as an explicit override");

const hetznerRunbook = assertFile("docs/hetzner-public-testnet-runbook.md");
assert(hetznerRunbook.includes("Checked-in adapter default: `8790`"), "Hetzner runbook must document adapter default port 8790");
assert(hetznerRunbook.includes("public-testnet override; default examples and Caddy use `8790`"), "Hetzner runbook must label 8791 as an explicit override");

console.log(JSON.stringify({
  checkedNodeFiles: NODE_CHECK_FILES.length,
  checkedFunctionsSources: CHAINLINK_FUNCTIONS_SOURCE_FILES.length,
  checkedRedeemConfigs: REDEEM_CONFIG_FILES.length,
  checkedDonAdapterConfigs: DON_ADAPTER_CONFIG_FILES.length,
  checkedPublicTestnetConfigs: PUBLIC_TESTNET_CONFIG_FILES.length,
  checkedOpsFiles: REQUIRED_FILES.length
}));
