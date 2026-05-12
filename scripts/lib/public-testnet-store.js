const { openSqliteDatabase } = require("./sqlite");

const DEPOSIT_INTENT_CREATED = "intent_created";
const DEPOSIT_BTC_OBSERVED = "btc_observed";
const DEPOSIT_MINT_REQUESTED = "mint_requested";
const DEPOSIT_MINTED = "minted";
const DEPOSIT_FAILED = "failed";

const REDEEM_OBSERVED = "observed";
const REDEEM_RELEASE_PREPARED = "release_prepared";
const REDEEM_RELEASE_REQUESTED = "release_requested";
const REDEEM_REDEEM_SUBMITTED = "redeem_submitted";
const REDEEM_REDEEM_COMPLETED = "redeem_completed";
const REDEEM_BTC_BROADCAST = "btc_broadcast";
const REDEEM_FAILED = "failed";

class PublicTestnetStore {
  constructor(dbPath, options = {}) {
    this.db = openSqliteDatabase(dbPath, { ...options, foreignKeys: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS public_deposits (
        deposit_id TEXT PRIMARY KEY,
        recipient TEXT NOT NULL,
        deposit_address TEXT NOT NULL,
        deposit_address_hash TEXT NOT NULL,
        expected_sats TEXT NOT NULL,
        nonce TEXT NOT NULL,
        expiry TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        create_intent_tx_hash TEXT NOT NULL,
        create_intent_block_number INTEGER,
        status TEXT NOT NULL,
        btc_tx_id TEXT,
        btc_vout INTEGER,
        btc_sats TEXT,
        btc_confirmations INTEGER,
        btc_observed_block_height INTEGER,
        mint_authorization_json TEXT,
        mint_request_id TEXT,
        mint_request_tx_hash TEXT,
        mint_struct_hash TEXT,
        mint_tx_hash TEXT,
        mint_block_number INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        error TEXT,
        UNIQUE(deposit_address),
        UNIQUE(btc_tx_id, btc_vout)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS public_redeems (
        redeem_request_hash TEXT PRIMARY KEY,
        requester TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        destination_script_hash TEXT NOT NULL,
        destination_script_pubkey TEXT NOT NULL,
        destination_address TEXT,
        request_nonce TEXT NOT NULL,
        amount_sats TEXT NOT NULL,
        max_miner_fee_sats TEXT NOT NULL,
        deadline TEXT NOT NULL,
        status TEXT NOT NULL,
        psbt_json TEXT,
        spend_plan_json TEXT,
        release_authorization_json TEXT,
        release_request_id TEXT,
        release_request_tx_hash TEXT,
        release_struct_hash TEXT,
        complete_redeem_tx_hash TEXT,
        complete_redeem_block_number INTEGER,
        bitcoin_tx_id TEXT,
        bitcoin_tx_hex TEXT,
        observed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        error TEXT,
        UNIQUE(tx_hash, log_index)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS public_service_cursors (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this._migrate();
  }

  _migrate() {
    const migrations = {
      public_deposits: [
        ["mint_request_tx_hash", "ALTER TABLE public_deposits ADD COLUMN mint_request_tx_hash TEXT"],
        ["mint_struct_hash", "ALTER TABLE public_deposits ADD COLUMN mint_struct_hash TEXT"],
        ["mint_tx_hash", "ALTER TABLE public_deposits ADD COLUMN mint_tx_hash TEXT"],
        ["mint_block_number", "ALTER TABLE public_deposits ADD COLUMN mint_block_number INTEGER"],
        ["error", "ALTER TABLE public_deposits ADD COLUMN error TEXT"]
      ],
      public_redeems: [
        ["destination_address", "ALTER TABLE public_redeems ADD COLUMN destination_address TEXT"],
        ["release_struct_hash", "ALTER TABLE public_redeems ADD COLUMN release_struct_hash TEXT"],
        ["complete_redeem_tx_hash", "ALTER TABLE public_redeems ADD COLUMN complete_redeem_tx_hash TEXT"],
        ["complete_redeem_block_number", "ALTER TABLE public_redeems ADD COLUMN complete_redeem_block_number INTEGER"],
        ["bitcoin_tx_id", "ALTER TABLE public_redeems ADD COLUMN bitcoin_tx_id TEXT"],
        ["bitcoin_tx_hex", "ALTER TABLE public_redeems ADD COLUMN bitcoin_tx_hex TEXT"],
        ["error", "ALTER TABLE public_redeems ADD COLUMN error TEXT"]
      ]
    };

    for (const [table, tableMigrations] of Object.entries(migrations)) {
      const columns = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
      for (const [column, sql] of tableMigrations) {
        if (!columns.has(column)) {
          this.db.exec(sql);
        }
      }
    }
  }

  close() {
    this.db.close();
  }

  createDeposit({
    depositId,
    recipient,
    depositAddress,
    depositAddressHash,
    expectedSats,
    nonce,
    expiry,
    intent,
    createIntentTxHash,
    createIntentBlockNumber,
    now = unixNow()
  }) {
    this.db.prepare(`
      INSERT INTO public_deposits (
        deposit_id,
        recipient,
        deposit_address,
        deposit_address_hash,
        expected_sats,
        nonce,
        expiry,
        intent_json,
        create_intent_tx_hash,
        create_intent_block_number,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      depositId,
      recipient,
      depositAddress,
      depositAddressHash,
      String(expectedSats),
      nonce,
      String(expiry),
      JSON.stringify(intent),
      createIntentTxHash,
      createIntentBlockNumber === undefined ? null : Number(createIntentBlockNumber),
      DEPOSIT_INTENT_CREATED,
      now,
      now
    );
    return this.getDeposit(depositId);
  }

  getDeposit(depositId) {
    return rowToDeposit(this.db.prepare(`
      SELECT * FROM public_deposits WHERE deposit_id = ?
    `).get(depositId));
  }

  listDeposits({ limit = 100 } = {}) {
    return this.db.prepare(`
      SELECT * FROM public_deposits
      ORDER BY created_at DESC
      LIMIT ?
    `).all(Number(limit)).map(rowToDeposit);
  }

  listDepositObservationEligible(limit = 100) {
    return this.db.prepare(`
      SELECT * FROM public_deposits
      WHERE status IN (?, ?)
      ORDER BY created_at ASC
      LIMIT ?
    `).all(DEPOSIT_INTENT_CREATED, DEPOSIT_BTC_OBSERVED, Number(limit)).map(rowToDeposit);
  }

  markDepositObserved({
    depositId,
    txid,
    vout,
    sats,
    confirmations,
    observedBlockHeight,
    now = unixNow()
  }) {
    this.db.prepare(`
      UPDATE public_deposits
      SET status = ?,
          btc_tx_id = ?,
          btc_vout = ?,
          btc_sats = ?,
          btc_confirmations = ?,
          btc_observed_block_height = ?,
          updated_at = ?,
          error = NULL
      WHERE deposit_id = ?
    `).run(
      DEPOSIT_BTC_OBSERVED,
      txid,
      Number(vout),
      String(sats),
      Number(confirmations),
      Number(observedBlockHeight),
      now,
      depositId
    );
  }

  listMintRequestEligible({ minConfirmations, limit = 100 }) {
    return this.db.prepare(`
      SELECT * FROM public_deposits
      WHERE status = ?
        AND btc_tx_id IS NOT NULL
        AND btc_confirmations >= ?
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(DEPOSIT_BTC_OBSERVED, Number(minConfirmations), Number(limit)).map(rowToDeposit);
  }

  markMintRequested({
    depositId,
    authorization,
    requestId,
    requestTxHash,
    structHash,
    now = unixNow()
  }) {
    this.db.prepare(`
      UPDATE public_deposits
      SET status = ?,
          mint_authorization_json = ?,
          mint_request_id = ?,
          mint_request_tx_hash = ?,
          mint_struct_hash = ?,
          updated_at = ?,
          error = NULL
      WHERE deposit_id = ?
    `).run(
      DEPOSIT_MINT_REQUESTED,
      JSON.stringify(authorization),
      requestId,
      requestTxHash,
      structHash,
      now,
      depositId
    );
  }

  listMintCallbackEligible(limit = 100) {
    return this.db.prepare(`
      SELECT * FROM public_deposits
      WHERE status = ? AND mint_request_id IS NOT NULL AND mint_authorization_json IS NOT NULL
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(DEPOSIT_MINT_REQUESTED, Number(limit)).map(rowToDeposit);
  }

  markMinted({ depositId, txHash, blockNumber, now = unixNow() }) {
    this.db.prepare(`
      UPDATE public_deposits
      SET status = ?,
          mint_tx_hash = ?,
          mint_block_number = ?,
          updated_at = ?,
          error = NULL
      WHERE deposit_id = ?
    `).run(DEPOSIT_MINTED, txHash, Number(blockNumber), now, depositId);
  }

  markDepositFailed(depositId, error, now = unixNow()) {
    this.db.prepare(`
      UPDATE public_deposits
      SET status = ?, error = ?, updated_at = ?
      WHERE deposit_id = ?
    `).run(DEPOSIT_FAILED, messageOf(error), now, depositId);
  }

  markDepositError(depositId, error, now = unixNow()) {
    this.db.prepare(`
      UPDATE public_deposits
      SET error = ?, updated_at = ?
      WHERE deposit_id = ?
    `).run(messageOf(error), now, depositId);
  }

  upsertRedeemObserved(event, now = unixNow()) {
    this.db.prepare(`
      INSERT INTO public_redeems (
        redeem_request_hash,
        requester,
        tx_hash,
        block_number,
        block_hash,
        log_index,
        destination_script_hash,
        destination_script_pubkey,
        request_nonce,
        amount_sats,
        max_miner_fee_sats,
        deadline,
        status,
        observed_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(redeem_request_hash) DO UPDATE SET
        requester = excluded.requester,
        tx_hash = excluded.tx_hash,
        block_number = excluded.block_number,
        block_hash = excluded.block_hash,
        log_index = excluded.log_index,
        destination_script_hash = excluded.destination_script_hash,
        destination_script_pubkey = excluded.destination_script_pubkey,
        request_nonce = excluded.request_nonce,
        amount_sats = excluded.amount_sats,
        max_miner_fee_sats = excluded.max_miner_fee_sats,
        deadline = excluded.deadline,
        updated_at = excluded.updated_at
    `).run(
      event.redeemRequestHash,
      event.requester,
      event.txHash,
      Number(event.blockNumber),
      event.blockHash,
      Number(event.logIndex),
      event.destinationScriptHash,
      event.destinationScriptPubKey,
      event.requestNonce,
      event.amountSats,
      event.maxMinerFeeSats,
      event.deadline,
      REDEEM_OBSERVED,
      now,
      now
    );
  }

  getRedeem(redeemRequestHash) {
    return rowToRedeem(this.db.prepare(`
      SELECT * FROM public_redeems WHERE redeem_request_hash = ?
    `).get(redeemRequestHash));
  }

  listRedeems({ limit = 100 } = {}) {
    return this.db.prepare(`
      SELECT * FROM public_redeems
      ORDER BY observed_at DESC
      LIMIT ?
    `).all(Number(limit)).map(rowToRedeem);
  }

  listRedeemPreparationEligible({ finalizedBlock, limit = 100 }) {
    return this.db.prepare(`
      SELECT * FROM public_redeems
      WHERE status = ? AND block_number <= ?
      ORDER BY block_number ASC, log_index ASC
      LIMIT ?
    `).all(REDEEM_OBSERVED, Number(finalizedBlock), Number(limit)).map(rowToRedeem);
  }

  markRedeemPrepared({
    redeemRequestHash,
    destinationAddress,
    psbt,
    spendPlan,
    authorization,
    bitcoinTxHex = null,
    now = unixNow()
  }) {
    this.db.prepare(`
      UPDATE public_redeems
      SET status = ?,
          destination_address = ?,
          psbt_json = ?,
          spend_plan_json = ?,
          release_authorization_json = ?,
          bitcoin_tx_hex = ?,
          updated_at = ?,
          error = NULL
      WHERE redeem_request_hash = ?
    `).run(
      REDEEM_RELEASE_PREPARED,
      destinationAddress,
      psbt ? JSON.stringify(psbt) : null,
      JSON.stringify(spendPlan),
      JSON.stringify(authorization),
      bitcoinTxHex,
      now,
      redeemRequestHash
    );
  }

  listReleaseRequestEligible(limit = 100) {
    return this.db.prepare(`
      SELECT * FROM public_redeems
      WHERE status = ? AND release_authorization_json IS NOT NULL AND spend_plan_json IS NOT NULL
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(REDEEM_RELEASE_PREPARED, Number(limit)).map(rowToRedeem);
  }

  markReleaseRequested({
    redeemRequestHash,
    requestId,
    requestTxHash,
    structHash,
    now = unixNow()
  }) {
    this.db.prepare(`
      UPDATE public_redeems
      SET status = ?,
          release_request_id = ?,
          release_request_tx_hash = ?,
          release_struct_hash = ?,
          updated_at = ?,
          error = NULL
      WHERE redeem_request_hash = ?
    `).run(
      REDEEM_RELEASE_REQUESTED,
      requestId,
      requestTxHash,
      structHash,
      now,
      redeemRequestHash
    );
  }

  listReleaseCallbackEligible(limit = 100) {
    return this.db.prepare(`
      SELECT * FROM public_redeems
      WHERE status IN (?, ?) AND release_request_id IS NOT NULL AND release_authorization_json IS NOT NULL
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(REDEEM_RELEASE_REQUESTED, REDEEM_REDEEM_SUBMITTED, Number(limit)).map(rowToRedeem);
  }

  markRedeemSubmitted({ redeemRequestHash, txHash, now = unixNow() }) {
    this.db.prepare(`
      UPDATE public_redeems
      SET status = ?,
          complete_redeem_tx_hash = ?,
          complete_redeem_block_number = NULL,
          updated_at = ?,
          error = NULL
      WHERE redeem_request_hash = ?
    `).run(REDEEM_REDEEM_SUBMITTED, txHash, now, redeemRequestHash);
  }

  markRedeemCompleted({ redeemRequestHash, txHash, blockNumber, now = unixNow() }) {
    this.db.prepare(`
      UPDATE public_redeems
      SET status = ?,
          complete_redeem_tx_hash = ?,
          complete_redeem_block_number = ?,
          updated_at = ?,
          error = NULL
      WHERE redeem_request_hash = ?
    `).run(REDEEM_REDEEM_COMPLETED, txHash, Number(blockNumber), now, redeemRequestHash);
  }

  listBitcoinBroadcastEligible(limit = 100) {
    return this.db.prepare(`
      SELECT * FROM public_redeems
      WHERE status = ? AND (psbt_json IS NOT NULL OR bitcoin_tx_hex IS NOT NULL)
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(REDEEM_REDEEM_COMPLETED, Number(limit)).map(rowToRedeem);
  }

  markBitcoinFinalized({ redeemRequestHash, txHex, now = unixNow() }) {
    this.db.prepare(`
      UPDATE public_redeems
      SET bitcoin_tx_hex = ?,
          updated_at = ?,
          error = NULL
      WHERE redeem_request_hash = ?
    `).run(txHex, now, redeemRequestHash);
  }

  markBitcoinBroadcast({ redeemRequestHash, txid, txHex, now = unixNow() }) {
    this.db.prepare(`
      UPDATE public_redeems
      SET status = ?,
          bitcoin_tx_id = ?,
          bitcoin_tx_hex = ?,
          updated_at = ?,
          error = NULL
      WHERE redeem_request_hash = ?
    `).run(REDEEM_BTC_BROADCAST, txid, txHex, now, redeemRequestHash);
  }

  markRedeemFailed(redeemRequestHash, error, now = unixNow()) {
    this.db.prepare(`
      UPDATE public_redeems
      SET status = ?, error = ?, updated_at = ?
      WHERE redeem_request_hash = ?
    `).run(REDEEM_FAILED, messageOf(error), now, redeemRequestHash);
  }

  markRedeemError(redeemRequestHash, error, now = unixNow()) {
    this.db.prepare(`
      UPDATE public_redeems
      SET error = ?, updated_at = ?
      WHERE redeem_request_hash = ?
    `).run(messageOf(error), now, redeemRequestHash);
  }

  countDepositsByStatus() {
    return countByStatus(this.db, "public_deposits");
  }

  countRedeemsByStatus() {
    return countByStatus(this.db, "public_redeems");
  }

  reconciliationStats({ now = unixNow(), staleSeconds = 3600 } = {}) {
    const mintedDepositSats = sumColumn(this.db, `
      SELECT btc_sats AS value
      FROM public_deposits
      WHERE status = ? AND btc_sats IS NOT NULL
    `, [DEPOSIT_MINTED]);
    const observedBurnSats = sumColumn(this.db, `
      SELECT amount_sats AS value
      FROM public_redeems
    `);
    const bitcoinBroadcastSats = sumColumn(this.db, `
      SELECT amount_sats AS value
      FROM public_redeems
      WHERE status = ?
    `, [REDEEM_BTC_BROADCAST]);
    const outstandingRedeemSats = sumColumn(this.db, `
      SELECT amount_sats AS value
      FROM public_redeems
      WHERE status != ?
    `, [REDEEM_BTC_BROADCAST]);
    const staleBefore = Number(now) - Number(staleSeconds);
    const staleRedeems = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM public_redeems
      WHERE status != ? AND updated_at <= ?
      GROUP BY status
      ORDER BY status ASC
    `).all(REDEEM_BTC_BROADCAST, staleBefore).reduce((counts, row) => {
      counts[row.status] = Number(row.count);
      return counts;
    }, {});
    const donMissingFinalizedTxs = Number(this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM public_redeems
      WHERE status IN (?, ?, ?, ?)
        AND bitcoin_tx_hex IS NULL
    `).get(
      REDEEM_RELEASE_PREPARED,
      REDEEM_RELEASE_REQUESTED,
      REDEEM_REDEEM_SUBMITTED,
      REDEEM_REDEEM_COMPLETED
    ).count);
    const releaseArtifactsMissing = Number(this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM public_redeems
      WHERE status IN (?, ?, ?, ?, ?)
        AND (spend_plan_json IS NULL OR release_authorization_json IS NULL)
    `).get(
      REDEEM_RELEASE_PREPARED,
      REDEEM_RELEASE_REQUESTED,
      REDEEM_REDEEM_SUBMITTED,
      REDEEM_REDEEM_COMPLETED,
      REDEEM_BTC_BROADCAST
    ).count);

    return {
      mintedDepositSats,
      observedBurnSats,
      knownNetSupplySats: (BigInt(mintedDepositSats) - BigInt(observedBurnSats)).toString(),
      bitcoinBroadcastSats,
      outstandingRedeemSats,
      staleRedeems,
      donMissingFinalizedTxs,
      releaseArtifactsMissing
    };
  }

  listReleaseIntegrityCandidates(limit = 500) {
    return this.db.prepare(`
      SELECT * FROM public_redeems
      WHERE status IN (?, ?, ?, ?, ?)
        AND spend_plan_json IS NOT NULL
        AND release_authorization_json IS NOT NULL
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(
      REDEEM_RELEASE_PREPARED,
      REDEEM_RELEASE_REQUESTED,
      REDEEM_REDEEM_SUBMITTED,
      REDEEM_REDEEM_COMPLETED,
      REDEEM_BTC_BROADCAST,
      Number(limit)
    ).map(rowToRedeem);
  }

  getCursor(name) {
    const row = this.db.prepare(`
      SELECT value FROM public_service_cursors WHERE name = ?
    `).get(name);
    return row ? row.value : null;
  }

  setCursor(name, value, updatedAt = unixNow()) {
    this.db.prepare(`
      INSERT INTO public_service_cursors (name, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(name, String(value), updatedAt);
  }

  listCursors() {
    return this.db.prepare(`
      SELECT name, value, updated_at FROM public_service_cursors ORDER BY name ASC
    `).all().map((row) => ({
      name: row.name,
      value: row.value,
      updatedAt: row.updated_at
    }));
  }
}

function countByStatus(db, table) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM ${table}
    GROUP BY status
    ORDER BY status ASC
  `).all();
  const counts = {};
  for (const row of rows) {
    counts[row.status] = Number(row.count);
  }
  return counts;
}

function sumColumn(db, sql, params = []) {
  const rows = db.prepare(sql).all(...params);
  return rows.reduce((sum, row) => sum + BigInt(row.value || "0"), 0n).toString();
}

function rowToDeposit(row) {
  if (!row) {
    return null;
  }
  return {
    depositId: row.deposit_id,
    recipient: row.recipient,
    depositAddress: row.deposit_address,
    depositAddressHash: row.deposit_address_hash,
    expectedSats: row.expected_sats,
    nonce: row.nonce,
    expiry: row.expiry,
    intent: JSON.parse(row.intent_json),
    createIntentTxHash: row.create_intent_tx_hash,
    createIntentBlockNumber: row.create_intent_block_number,
    status: row.status,
    btcTxId: row.btc_tx_id,
    btcVout: row.btc_vout,
    btcSats: row.btc_sats,
    btcConfirmations: row.btc_confirmations,
    btcObservedBlockHeight: row.btc_observed_block_height,
    mintAuthorization: row.mint_authorization_json ? JSON.parse(row.mint_authorization_json) : null,
    mintRequestId: row.mint_request_id,
    mintRequestTxHash: row.mint_request_tx_hash,
    mintStructHash: row.mint_struct_hash,
    mintTxHash: row.mint_tx_hash,
    mintBlockNumber: row.mint_block_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error
  };
}

function rowToRedeem(row) {
  if (!row) {
    return null;
  }
  return {
    redeemRequestHash: row.redeem_request_hash,
    requester: row.requester,
    txHash: row.tx_hash,
    blockNumber: row.block_number,
    blockHash: row.block_hash,
    logIndex: row.log_index,
    destinationScriptHash: row.destination_script_hash,
    destinationScriptPubKey: row.destination_script_pubkey,
    destinationAddress: row.destination_address,
    requestNonce: row.request_nonce,
    amountSats: row.amount_sats,
    maxMinerFeeSats: row.max_miner_fee_sats,
    deadline: row.deadline,
    status: row.status,
    psbt: row.psbt_json ? JSON.parse(row.psbt_json) : null,
    spendPlan: row.spend_plan_json ? JSON.parse(row.spend_plan_json) : null,
    releaseAuthorization: row.release_authorization_json ? JSON.parse(row.release_authorization_json) : null,
    releaseRequestId: row.release_request_id,
    releaseRequestTxHash: row.release_request_tx_hash,
    releaseStructHash: row.release_struct_hash,
    completeRedeemTxHash: row.complete_redeem_tx_hash,
    completeRedeemBlockNumber: row.complete_redeem_block_number,
    bitcoinTxId: row.bitcoin_tx_id,
    bitcoinTxHex: row.bitcoin_tx_hex,
    observedAt: row.observed_at,
    updatedAt: row.updated_at,
    error: row.error
  };
}

function messageOf(error) {
  return String(error && error.message ? error.message : error);
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

module.exports = {
  DEPOSIT_BTC_OBSERVED,
  DEPOSIT_FAILED,
  DEPOSIT_INTENT_CREATED,
  DEPOSIT_MINT_REQUESTED,
  DEPOSIT_MINTED,
  PublicTestnetStore,
  REDEEM_BTC_BROADCAST,
  REDEEM_FAILED,
  REDEEM_OBSERVED,
  REDEEM_REDEEM_COMPLETED,
  REDEEM_REDEEM_SUBMITTED,
  REDEEM_RELEASE_PREPARED,
  REDEEM_RELEASE_REQUESTED
};
