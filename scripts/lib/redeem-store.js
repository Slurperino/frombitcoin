const { openSqliteDatabase } = require("./sqlite");

const STATUS_OBSERVED = "observed";
const STATUS_AUTHORIZED = "authorized";
const STATUS_ATTESTATION_REQUESTED = "attestation_requested";
const STATUS_ATTESTED = "attested";
const STATUS_RELAYED = "relayed";
const STATUS_CONSUMED = "consumed";
const STATUS_FAILED = "failed";

class RedeemStore {
  constructor(dbPath, options = {}) {
    this.db = openSqliteDatabase(dbPath, { ...options, foreignKeys: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS redeem_events (
        redeem_request_hash TEXT PRIMARY KEY,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        requester TEXT NOT NULL,
        destination_script_hash TEXT NOT NULL,
        request_nonce TEXT NOT NULL,
        amount_sats TEXT NOT NULL,
        max_miner_fee_sats TEXT NOT NULL,
        deadline TEXT NOT NULL,
        destination_script_pubkey TEXT NOT NULL,
        status TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        finalized_at INTEGER,
        release_authorization_json TEXT,
        attestation_requested_at INTEGER,
        attestation TEXT,
        signer_set_digest TEXT,
        message_digest TEXT,
        attested_at INTEGER,
        relay_tx_hash TEXT,
        relay_block_number INTEGER,
        completed_at INTEGER,
        error TEXT,
        UNIQUE(tx_hash, log_index)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS service_cursors (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this._migrate();
  }

  _migrate() {
    const columns = new Set(this.db.prepare("PRAGMA table_info(redeem_events)").all().map((column) => column.name));
    const migrations = [
      ["attestation", "ALTER TABLE redeem_events ADD COLUMN attestation TEXT"],
      ["attestation_requested_at", "ALTER TABLE redeem_events ADD COLUMN attestation_requested_at INTEGER"],
      ["signer_set_digest", "ALTER TABLE redeem_events ADD COLUMN signer_set_digest TEXT"],
      ["message_digest", "ALTER TABLE redeem_events ADD COLUMN message_digest TEXT"],
      ["attested_at", "ALTER TABLE redeem_events ADD COLUMN attested_at INTEGER"],
      ["relay_tx_hash", "ALTER TABLE redeem_events ADD COLUMN relay_tx_hash TEXT"],
      ["relay_block_number", "ALTER TABLE redeem_events ADD COLUMN relay_block_number INTEGER"],
      ["completed_at", "ALTER TABLE redeem_events ADD COLUMN completed_at INTEGER"]
    ];

    for (const [column, sql] of migrations) {
      if (!columns.has(column)) {
        this.db.exec(sql);
      }
    }
  }

  close() {
    this.db.close();
  }

  upsertRedeemEvent(event) {
    this.db.prepare(`
      INSERT INTO redeem_events (
        redeem_request_hash,
        block_number,
        block_hash,
        tx_hash,
        log_index,
        requester,
        destination_script_hash,
        request_nonce,
        amount_sats,
        max_miner_fee_sats,
        deadline,
        destination_script_pubkey,
        status,
        observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(redeem_request_hash) DO UPDATE SET
        block_number = excluded.block_number,
        block_hash = excluded.block_hash,
        tx_hash = excluded.tx_hash,
        log_index = excluded.log_index,
        requester = excluded.requester,
        destination_script_hash = excluded.destination_script_hash,
        request_nonce = excluded.request_nonce,
        amount_sats = excluded.amount_sats,
        max_miner_fee_sats = excluded.max_miner_fee_sats,
        deadline = excluded.deadline,
        destination_script_pubkey = excluded.destination_script_pubkey
    `).run(
      event.redeemRequestHash,
      event.blockNumber,
      event.blockHash,
      event.txHash,
      event.logIndex,
      event.requester,
      event.destinationScriptHash,
      event.requestNonce,
      event.amountSats,
      event.maxMinerFeeSats,
      event.deadline,
      event.destinationScriptPubKey,
      STATUS_OBSERVED,
      event.observedAt ?? Math.floor(Date.now() / 1000)
    );
  }

  getRedeemEvent(redeemRequestHash) {
    return rowToEvent(this.db.prepare(`
      SELECT * FROM redeem_events WHERE redeem_request_hash = ?
    `).get(redeemRequestHash));
  }

  listEvents() {
    return this.db.prepare(`
      SELECT * FROM redeem_events ORDER BY block_number ASC, log_index ASC
    `).all().map(rowToEvent);
  }

  countEventsByStatus() {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM redeem_events
      GROUP BY status
      ORDER BY status ASC
    `).all();

    const counts = {};
    for (const row of rows) {
      counts[row.status] = Number(row.count);
    }
    return counts;
  }

  listAuthorized(limit = 100) {
    return this.listAttestationEligible(limit);
  }

  listAttestationEligible(limit = 100) {
    return this.db.prepare(`
      SELECT * FROM redeem_events
      WHERE status IN (?, ?) AND release_authorization_json IS NOT NULL
      ORDER BY COALESCE(attestation_requested_at, finalized_at) ASC, block_number ASC, log_index ASC
      LIMIT ?
    `).all(STATUS_AUTHORIZED, STATUS_ATTESTATION_REQUESTED, limit).map(rowToEvent);
  }

  listRelayEligible(limit = 100) {
    return this.db.prepare(`
      SELECT * FROM redeem_events
      WHERE status IN (?, ?) AND attestation IS NOT NULL AND release_authorization_json IS NOT NULL
      ORDER BY COALESCE(attested_at, finalized_at) ASC, block_number ASC, log_index ASC
      LIMIT ?
    `).all(STATUS_ATTESTED, STATUS_RELAYED, limit).map(rowToEvent);
  }

  listFinalityEligible(latestBlockNumber, finalityBlocks) {
    const finalizedBlockNumber = latestBlockNumber - finalityBlocks;
    return this.db.prepare(`
      SELECT * FROM redeem_events
      WHERE status = ? AND block_number <= ?
      ORDER BY block_number ASC, log_index ASC
    `).all(STATUS_OBSERVED, finalizedBlockNumber).map(rowToEvent);
  }

  markAuthorized(redeemRequestHash, releaseAuthorization, finalizedAt) {
    this.db.prepare(`
      UPDATE redeem_events
      SET status = ?,
          finalized_at = ?,
          release_authorization_json = ?,
          attestation_requested_at = NULL,
          attestation = NULL,
          signer_set_digest = NULL,
          message_digest = NULL,
          attested_at = NULL,
          relay_tx_hash = NULL,
          relay_block_number = NULL,
          completed_at = NULL,
          error = NULL
      WHERE redeem_request_hash = ?
    `).run(
      STATUS_AUTHORIZED,
      finalizedAt,
      JSON.stringify(releaseAuthorization),
      redeemRequestHash
    );
  }

  markAttestationRequested(redeemRequestHash, requestedAt = Math.floor(Date.now() / 1000)) {
    this.db.prepare(`
      UPDATE redeem_events
      SET status = ?, attestation_requested_at = ?, error = NULL
      WHERE redeem_request_hash = ?
    `).run(
      STATUS_ATTESTATION_REQUESTED,
      requestedAt,
      redeemRequestHash
    );
  }

  markAttested(
    redeemRequestHash,
    { attestation, signerSetDigest, messageDigest },
    attestedAt = Math.floor(Date.now() / 1000)
  ) {
    this.db.prepare(`
      UPDATE redeem_events
      SET status = ?,
          attestation = ?,
          signer_set_digest = ?,
          message_digest = ?,
          attested_at = ?,
          error = NULL
      WHERE redeem_request_hash = ?
    `).run(
      STATUS_ATTESTED,
      attestation,
      signerSetDigest,
      messageDigest,
      attestedAt,
      redeemRequestHash
    );
  }

  markRelayed(redeemRequestHash, txHash) {
    this.db.prepare(`
      UPDATE redeem_events
      SET status = ?, relay_tx_hash = ?, error = NULL
      WHERE redeem_request_hash = ?
    `).run(
      STATUS_RELAYED,
      txHash,
      redeemRequestHash
    );
  }

  markRelayFailed(redeemRequestHash, error) {
    this.db.prepare(`
      UPDATE redeem_events
      SET status = ?, relay_tx_hash = NULL, error = ?
      WHERE redeem_request_hash = ?
    `).run(
      STATUS_ATTESTED,
      String(error && error.message ? error.message : error),
      redeemRequestHash
    );
  }

  markConsumed(redeemRequestHash, receipt, completedAt = Math.floor(Date.now() / 1000)) {
    this.db.prepare(`
      UPDATE redeem_events
      SET status = ?, relay_block_number = ?, completed_at = ?, error = NULL
      WHERE redeem_request_hash = ?
    `).run(
      STATUS_CONSUMED,
      Number(receipt.blockNumber),
      completedAt,
      redeemRequestHash
    );
  }

  markAlreadyConsumed(redeemRequestHash, completedAt = Math.floor(Date.now() / 1000)) {
    this.db.prepare(`
      UPDATE redeem_events
      SET status = ?, completed_at = ?, error = NULL
      WHERE redeem_request_hash = ?
    `).run(
      STATUS_CONSUMED,
      completedAt,
      redeemRequestHash
    );
  }

  markError(redeemRequestHash, error) {
    this.db.prepare(`
      UPDATE redeem_events
      SET error = ?
      WHERE redeem_request_hash = ?
    `).run(String(error && error.message ? error.message : error), redeemRequestHash);
  }

  markFailed(redeemRequestHash, error) {
    this.db.prepare(`
      UPDATE redeem_events
      SET status = ?, error = ?
      WHERE redeem_request_hash = ?
    `).run(STATUS_FAILED, String(error && error.message ? error.message : error), redeemRequestHash);
  }

  getCursor(name) {
    const row = this.db.prepare(`
      SELECT value FROM service_cursors WHERE name = ?
    `).get(name);
    return row ? row.value : null;
  }

  setCursor(name, value, updatedAt = Math.floor(Date.now() / 1000)) {
    this.db.prepare(`
      INSERT INTO service_cursors (name, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(name, String(value), updatedAt);
  }

  listCursors() {
    return this.db.prepare(`
      SELECT name, value, updated_at FROM service_cursors ORDER BY name ASC
    `).all().map((row) => ({
      name: row.name,
      value: row.value,
      updatedAt: row.updated_at
    }));
  }
}

function rowToEvent(row) {
  if (!row) {
    return null;
  }

  return {
    redeemRequestHash: row.redeem_request_hash,
    blockNumber: row.block_number,
    blockHash: row.block_hash,
    txHash: row.tx_hash,
    logIndex: row.log_index,
    requester: row.requester,
    destinationScriptHash: row.destination_script_hash,
    requestNonce: row.request_nonce,
    amountSats: row.amount_sats,
    maxMinerFeeSats: row.max_miner_fee_sats,
    deadline: row.deadline,
    destinationScriptPubKey: row.destination_script_pubkey,
    status: row.status,
    observedAt: row.observed_at,
    finalizedAt: row.finalized_at,
    releaseAuthorization: row.release_authorization_json ? JSON.parse(row.release_authorization_json) : null,
    attestationRequestedAt: row.attestation_requested_at,
    attestation: row.attestation,
    signerSetDigest: row.signer_set_digest,
    messageDigest: row.message_digest,
    attestedAt: row.attested_at,
    relayTxHash: row.relay_tx_hash,
    relayBlockNumber: row.relay_block_number,
    completedAt: row.completed_at,
    error: row.error
  };
}

module.exports = {
  RedeemStore,
  STATUS_ATTESTATION_REQUESTED,
  STATUS_AUTHORIZED,
  STATUS_ATTESTED,
  STATUS_CONSUMED,
  STATUS_FAILED,
  STATUS_RELAYED,
  STATUS_OBSERVED
};
