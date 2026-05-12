#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { Command } = require("commander");
const { openSqliteDatabase } = require("./lib/sqlite");

const DEFAULT_PREFIX = "public-testnet";
const DEFAULT_RETENTION_DAYS = 14;

function backupPublicTestnetDatabase({
  dbPath,
  outDir,
  prefix = DEFAULT_PREFIX,
  retentionDays = DEFAULT_RETENTION_DAYS,
  now = new Date()
}) {
  if (!dbPath) {
    throw new Error("dbPath is required");
  }
  if (!outDir) {
    throw new Error("outDir is required");
  }

  fs.mkdirSync(outDir, { recursive: true, mode: 0o750 });
  const timestamp = timestampForFilename(now);
  const backupPath = path.join(outDir, `${prefix}-${timestamp}.sqlite`);
  const manifestPath = `${backupPath}.json`;
  if (fs.existsSync(backupPath)) {
    throw new Error(`backup already exists: ${backupPath}`);
  }

  const db = openSqliteDatabase(dbPath);
  try {
    db.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);
  } finally {
    db.close();
  }
  fs.chmodSync(backupPath, 0o640);

  const manifest = {
    createdAt: now.toISOString(),
    source: dbPath,
    backup: backupPath,
    sizeBytes: fs.statSync(backupPath).size,
    retentionDays: Number(retentionDays)
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o640 });
  pruneOldBackups({ outDir, prefix, retentionDays, now });
  return manifest;
}

function pruneOldBackups({ outDir, prefix, retentionDays, now = new Date() }) {
  const retentionMs = Number(retentionDays) * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
    return [];
  }

  const cutoff = now.getTime() - retentionMs;
  const removed = [];
  const backupPattern = new RegExp(`^${escapeRegExp(prefix)}-\\d{8}T\\d{6}Z\\.sqlite(?:\\.json)?$`);
  for (const name of fs.readdirSync(outDir)) {
    if (!backupPattern.test(name)) {
      continue;
    }
    const file = path.join(outDir, name);
    const stat = fs.statSync(file);
    if (stat.mtimeMs < cutoff) {
      fs.rmSync(file, { force: true });
      removed.push(file);
    }
  }
  return removed;
}

function quoteSqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function timestampForFilename(date) {
  return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function main() {
  const program = new Command();
  program
    .requiredOption("--db <path>", "SQLite database path")
    .requiredOption("--out-dir <path>", "backup output directory")
    .option("--prefix <name>", "backup filename prefix", DEFAULT_PREFIX)
    .option("--retention-days <number>", "delete backups older than this many days", String(DEFAULT_RETENTION_DAYS));
  program.parse(process.argv);

  const options = program.opts();
  try {
    const manifest = backupPublicTestnetDatabase({
      dbPath: options.db,
      outDir: options.outDir,
      prefix: options.prefix,
      retentionDays: Number(options.retentionDays)
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...manifest })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error.message
    })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  backupPublicTestnetDatabase,
  pruneOldBackups,
  timestampForFilename
};
