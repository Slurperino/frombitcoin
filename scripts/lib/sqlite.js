const { DatabaseSync } = require("node:sqlite");

const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 10_000;

function openSqliteDatabase(dbPath, {
  busyTimeoutMs = DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  foreignKeys = false
} = {}) {
  const db = new DatabaseSync(dbPath);
  configureSqliteDatabase(db, { busyTimeoutMs, foreignKeys });
  return db;
}

function configureSqliteDatabase(db, {
  busyTimeoutMs = DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  foreignKeys = false
} = {}) {
  const timeout = normalizeBusyTimeoutMs(busyTimeoutMs);
  db.exec(`PRAGMA busy_timeout = ${timeout}`);
  db.exec("PRAGMA journal_mode = WAL");
  if (foreignKeys) {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function normalizeBusyTimeoutMs(value) {
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 0) {
    throw new Error("SQLite busy timeout must be a non-negative integer number of milliseconds");
  }
  return timeout;
}

module.exports = {
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  configureSqliteDatabase,
  openSqliteDatabase
};
