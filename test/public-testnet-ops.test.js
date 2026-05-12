const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { backupPublicTestnetDatabase } = require("../scripts/backup-public-testnet-db");
const {
  runPublicTestnetHealthcheck,
  runPublicTestnetHealthcheckWithRetries,
  scanForbiddenPublicKeys
} = require("../scripts/public-testnet-healthcheck");

const BURN_GATEWAY = "0x6eFA4C217171B8B0eb856F48403928D9ad27ac96";

test("public testnet healthcheck accepts the launch endpoint contract", async (t) => {
  const server = await startServer((req, res) => {
    if (req.url === "/healthz") {
      return writeJson(res, 200, { ok: true });
    }
    if (req.url === "/status") {
      return writeJson(res, 200, {
        ok: true,
        mode: "public_testnet",
        network: {
          evmChainId: 11155111,
          bitcoinNetwork: "signet"
        },
        contracts: {
          burnGateway: BURN_GATEWAY
        },
        relayer: {
          fundingStatus: "funded",
          balanceBucketEth: "<0.01"
        }
      });
    }
    if (req.url === "/deposits?limit=5") {
      return writeJson(res, 200, { deposits: [{ depositId: "0x" + "11".repeat(32), status: "mint_confirmed" }] });
    }
    if (req.url === "/redeems?limit=5") {
      return writeJson(res, 200, { redeems: [{ redeemRequestHash: "0x" + "22".repeat(32), status: "bitcoin_broadcast" }] });
    }
    if (req.url === "/metrics") {
      return writeText(res, 404, "not found");
    }
    if (req.url === "/") {
      return writeText(res, 200, "<!doctype html><strong>TESTNET ONLY</strong>");
    }
    writeText(res, 404, "not found");
  });
  t.after(() => server.close());

  const result = await runPublicTestnetHealthcheck({
    baseUrl: server.url,
    adapterUrl: server.url,
    expectedBurnGateway: BURN_GATEWAY,
    maxResponseMs: 1000
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((check) => check.path), [
    "/healthz",
    "/status",
    "/deposits?limit=5",
    "/redeems?limit=5",
    "/metrics",
    "/",
    "adapter:/healthz"
  ]);
});

test("public testnet healthcheck fails if public activity leaks internals", () => {
  const hits = scanForbiddenPublicKeys({
    deposits: [
      {
        depositId: "0x" + "11".repeat(32),
        nonce: "0x" + "22".repeat(32)
      }
    ]
  });

  assert.deepEqual(hits, ["$.deposits.0.nonce"]);
});

test("public testnet healthcheck retries transient startup responses", async (t) => {
  let healthRequests = 0;
  const server = await startServer((req, res) => {
    if (req.url === "/healthz") {
      healthRequests += 1;
      if (healthRequests === 1) {
        return writeText(res, 502, "<!DOCTYPE html>");
      }
      return writeJson(res, 200, { ok: true });
    }
    if (req.url === "/status") {
      return writeJson(res, 200, {
        ok: true,
        mode: "public_testnet",
        network: {
          evmChainId: 11155111,
          bitcoinNetwork: "signet"
        },
        contracts: {
          burnGateway: BURN_GATEWAY
        },
        relayer: {
          fundingStatus: "funded"
        }
      });
    }
    if (req.url === "/deposits?limit=5") {
      return writeJson(res, 200, { deposits: [] });
    }
    if (req.url === "/redeems?limit=5") {
      return writeJson(res, 200, { redeems: [] });
    }
    if (req.url === "/metrics") {
      return writeText(res, 404, "not found");
    }
    if (req.url === "/") {
      return writeText(res, 200, "TESTNET ONLY");
    }
    writeText(res, 404, "not found");
  });
  t.after(() => server.close());

  const result = await runPublicTestnetHealthcheckWithRetries({
    baseUrl: server.url,
    expectedBurnGateway: BURN_GATEWAY,
    attempts: 2,
    retryDelayMs: 1,
    maxResponseMs: 1000
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
});

test("public testnet backup creates an online SQLite copy and manifest", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bitcoinbride-public-backup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const dbPath = path.join(dir, "public-testnet.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO smoke (value) VALUES (?)").run("ok");
  db.close();

  const outDir = path.join(dir, "backups");
  const manifest = backupPublicTestnetDatabase({
    dbPath,
    outDir,
    now: new Date("2026-05-08T03:17:00Z")
  });

  assert.equal(path.basename(manifest.backup), "public-testnet-20260508T031700Z.sqlite");
  assert.equal(fs.existsSync(manifest.backup), true);
  assert.equal(fs.existsSync(`${manifest.backup}.json`), true);

  const backup = new DatabaseSync(manifest.backup);
  try {
    const row = backup.prepare("SELECT value FROM smoke WHERE id = 1").get();
    assert.equal(row.value, "ok");
  } finally {
    backup.close();
  }
});

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.url = `http://127.0.0.1:${port}`;
      resolve(server);
    });
  });
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function writeText(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(body);
}
