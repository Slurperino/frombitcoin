const { openSqliteDatabase } = require("./sqlite");

const STATUS_RESERVED = "reserved";
const STATUS_SIGNED = "signed";
const STATUS_BROADCAST = "broadcast";
const STATUS_CONFIRMED = "confirmed";
const STATUS_ABORTED = "aborted";

class BtcSignerStore {
  constructor(dbPath, options = {}) {
    this.db = openSqliteDatabase(dbPath, options);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS btc_signer_decisions (
        redeem_id TEXT PRIMARY KEY,
        authorization_digest TEXT NOT NULL,
        spend_plan_digest TEXT NOT NULL,
        unsigned_psbt_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        reserved_at INTEGER NOT NULL,
        signed_at INTEGER,
        signed_psbt_base64 TEXT,
        tx_hex TEXT,
        txid TEXT,
        error TEXT
      )
    `);
  }

  close() {
    this.db.close();
  }

  getDecision(redeemId) {
    const row = this.db.prepare(`
      SELECT * FROM btc_signer_decisions WHERE redeem_id = ?
    `).get(redeemId);
    return rowToDecision(row);
  }

  reserveSigning({
    redeemId,
    authorizationDigest,
    spendPlanDigest,
    unsignedPsbtDigest,
    reservedAt = Math.floor(Date.now() / 1000)
  }) {
    const existing = this.getDecision(redeemId);
    if (existing) {
      if (
        existing.authorizationDigest !== authorizationDigest ||
        existing.spendPlanDigest !== spendPlanDigest ||
        existing.unsignedPsbtDigest !== unsignedPsbtDigest
      ) {
        throw new Error("redeemId already has a conflicting signer reservation");
      }

      if ([STATUS_SIGNED, STATUS_BROADCAST, STATUS_CONFIRMED].includes(existing.status)) {
        return {
          status: "already_signed",
          decision: existing
        };
      }

      if (existing.status === STATUS_RESERVED) {
        return {
          status: "reserved",
          decision: existing
        };
      }

      throw new Error(`redeemId already has signer status ${existing.status}`);
    }

    this.db.prepare(`
      INSERT INTO btc_signer_decisions (
        redeem_id,
        authorization_digest,
        spend_plan_digest,
        unsigned_psbt_digest,
        status,
        reserved_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      redeemId,
      authorizationDigest,
      spendPlanDigest,
      unsignedPsbtDigest,
      STATUS_RESERVED,
      reservedAt
    );

    return {
      status: "reserved",
      decision: this.getDecision(redeemId)
    };
  }

  markSigned({
    redeemId,
    signedPsbtBase64,
    txHex,
    txid,
    signedAt = Math.floor(Date.now() / 1000)
  }) {
    this.db.prepare(`
      UPDATE btc_signer_decisions
      SET status = ?,
          signed_at = ?,
          signed_psbt_base64 = ?,
          tx_hex = ?,
          txid = ?,
          error = NULL
      WHERE redeem_id = ?
    `).run(
      STATUS_SIGNED,
      signedAt,
      signedPsbtBase64,
      txHex,
      txid,
      redeemId
    );

    return this.getDecision(redeemId);
  }

  markError(redeemId, error) {
    this.db.prepare(`
      UPDATE btc_signer_decisions
      SET error = ?
      WHERE redeem_id = ?
    `).run(String(error && error.message ? error.message : error), redeemId);
  }
}

function rowToDecision(row) {
  if (!row) {
    return null;
  }

  return {
    redeemId: row.redeem_id,
    authorizationDigest: row.authorization_digest,
    spendPlanDigest: row.spend_plan_digest,
    unsignedPsbtDigest: row.unsigned_psbt_digest,
    status: row.status,
    reservedAt: row.reserved_at,
    signedAt: row.signed_at,
    signedPsbtBase64: row.signed_psbt_base64,
    txHex: row.tx_hex,
    txid: row.txid,
    error: row.error
  };
}

module.exports = {
  BtcSignerStore,
  STATUS_ABORTED,
  STATUS_BROADCAST,
  STATUS_CONFIRMED,
  STATUS_RESERVED,
  STATUS_SIGNED
};
