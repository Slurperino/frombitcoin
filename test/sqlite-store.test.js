const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { BtcSignerStore } = require("../scripts/lib/btc-signer-store");
const { PublicTestnetStore } = require("../scripts/lib/public-testnet-store");
const { RedeemStore } = require("../scripts/lib/redeem-store");
const { DEFAULT_SQLITE_BUSY_TIMEOUT_MS } = require("../scripts/lib/sqlite");

test("SQLite stores configure a busy timeout before operational use", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bitcoinbride-sqlite-stores-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const stores = [
    new PublicTestnetStore(path.join(dir, "public.sqlite")),
    new RedeemStore(path.join(dir, "redeems.sqlite")),
    new BtcSignerStore(path.join(dir, "signer.sqlite"))
  ];
  t.after(() => stores.forEach((store) => store.close()));

  for (const store of stores) {
    const row = store.db.prepare("PRAGMA busy_timeout").get();
    assert.equal(row.timeout, DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
  }
});

test("SQLite store busy timeout can be overridden for contention tests", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bitcoinbride-sqlite-timeout-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = new PublicTestnetStore(path.join(dir, "public.sqlite"), { busyTimeoutMs: 250 });
  t.after(() => store.close());

  const row = store.db.prepare("PRAGMA busy_timeout").get();
  assert.equal(row.timeout, 250);
});
