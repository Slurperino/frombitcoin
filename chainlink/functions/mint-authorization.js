const KIND_MINT = 1;

function normalizeHex(value) {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw new Error(`invalid hex value: ${value}`);
  }
  return value.toLowerCase();
}

function normalizeTxId(value) {
  if (typeof value !== "string") {
    throw new Error("invalid txid");
  }
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`invalid txid: ${value}`);
  }
  return hex.toLowerCase();
}

function assertSame(a, b, label) {
  if (String(a).toLowerCase() !== String(b).toLowerCase()) {
    throw new Error(`${label} mismatch`);
  }
}

function assertIntegerString(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be a canonical uint string`);
  }
}

function assertBytes32(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(value))) {
    throw new Error(`${label} must be bytes32 hex`);
  }
}

function utf8Bytes(value) {
  const bytes = [];
  const text = String(value);
  for (let i = 0; i < text.length; i += 1) {
    let codePoint = text.charCodeAt(i);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      i += 1;
      const low = text.charCodeAt(i);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new Error("invalid UTF-16 string");
      }
      codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
    }

    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    }
  }
  return bytes;
}

const MASK_64 = (1n << 64n) - 1n;
const KECCAK_ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
const KECCAK_ROTATION_OFFSETS = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14]
];

function rotl64(value, shift) {
  const bits = BigInt(shift);
  const normalized = value & MASK_64;
  if (bits === 0n) {
    return normalized;
  }
  return ((normalized << bits) | (normalized >> (64n - bits))) & MASK_64;
}

function keccakF1600(state) {
  for (const roundConstant of KECCAK_ROUND_CONSTANTS) {
    const c = new Array(5);
    const d = new Array(5);
    for (let x = 0; x < 5; x += 1) {
      c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x += 1) {
      d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] = (state[x + 5 * y] ^ d[x]) & MASK_64;
      }
    }

    const b = new Array(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(state[x + 5 * y], KECCAK_ROTATION_OFFSETS[x][y]);
      }
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] = (
          b[x + 5 * y] ^
          (((~b[((x + 1) % 5) + 5 * y]) & MASK_64) & b[((x + 2) % 5) + 5 * y])
        ) & MASK_64;
      }
    }
    state[0] = (state[0] ^ roundConstant) & MASK_64;
  }
}

function keccak256Utf8(value) {
  const rateBytes = 136;
  const bytes = utf8Bytes(value);
  bytes.push(0x01);
  while (bytes.length % rateBytes !== rateBytes - 1) {
    bytes.push(0);
  }
  bytes.push(0x80);

  const state = new Array(25).fill(0n);
  for (let offset = 0; offset < bytes.length; offset += rateBytes) {
    for (let i = 0; i < rateBytes; i += 8) {
      let lane = 0n;
      for (let j = 0; j < 8; j += 1) {
        lane |= BigInt(bytes[offset + i + j]) << BigInt(8 * j);
      }
      state[i / 8] = (state[i / 8] ^ lane) & MASK_64;
    }
    keccakF1600(state);
  }

  const out = [];
  for (let i = 0; i < 32; i += 1) {
    out.push(Number((state[Math.floor(i / 8)] >> BigInt(8 * (i % 8))) & 0xffn));
  }
  return `0x${out.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, "")}${path}`;
}

async function getJson(url) {
  const response = await Functions.makeHttpRequest({
    url,
    method: "GET",
    timeout: 9000
  });
  if (response.error) {
    throw new Error(`HTTP request failed: ${url}`);
  }
  return response.data;
}

async function observeDeposit(apiBase, txid, vout) {
  const [tx, tipHeightRaw] = await Promise.all([
    getJson(joinUrl(apiBase, `/tx/${txid}`)),
    getJson(joinUrl(apiBase, "/blocks/tip/height"))
  ]);

  if (!tx || normalizeTxId(tx.txid) !== txid) {
    throw new Error("deposit transaction not found");
  }
  if (!tx.status || tx.status.confirmed !== true) {
    throw new Error("deposit transaction is not confirmed");
  }
  if (!Array.isArray(tx.vout) || !tx.vout[vout]) {
    throw new Error("deposit output not found");
  }

  const tipHeight = Number(tipHeightRaw);
  const blockHeight = Number(tx.status.block_height);
  if (!Number.isSafeInteger(tipHeight) || !Number.isSafeInteger(blockHeight)) {
    throw new Error("invalid Bitcoin block height");
  }

  const output = tx.vout[vout];
  return {
    txid,
    vout,
    value: String(output.value),
    scriptPubKey: String(output.scriptpubkey || "").toLowerCase(),
    address: String(output.scriptpubkey_address || ""),
    blockHeight,
    blockHash: String(tx.status.block_hash || "").toLowerCase(),
    tipHeight,
    confirmations: tipHeight - blockHeight + 1
  };
}

function assertObservationMatchesAuthorization(observation, authorization, depositAddress, minConfirmations) {
  assertSame(observation.txid, normalizeTxId(authorization.btcTxId), "btcTxId");
  assertSame(observation.vout, authorization.vout, "vout");
  assertSame(observation.value, authorization.sats, "sats");
  assertSame(observation.address, depositAddress, "deposit address");

  const observedBlockHeight = Number(authorization.observedBlockHeight);
  const authorizedConfirmations = Number(authorization.confirmations);
  if (!Number.isSafeInteger(observedBlockHeight) || !Number.isSafeInteger(authorizedConfirmations)) {
    throw new Error("invalid authorization observation heights");
  }
  if (observedBlockHeight < observation.blockHeight || observedBlockHeight > observation.tipHeight) {
    throw new Error("authorization observedBlockHeight is outside observed chain range");
  }
  if (authorizedConfirmations !== observedBlockHeight - observation.blockHeight + 1) {
    throw new Error("authorization confirmations do not match observedBlockHeight");
  }
  if (authorizedConfirmations < minConfirmations || observation.confirmations < minConfirmations) {
    throw new Error("deposit does not satisfy confirmation policy");
  }
}

function assertObservationsAgree(primary, secondary) {
  for (const field of ["txid", "vout", "value", "scriptPubKey", "address", "blockHeight", "blockHash"]) {
    assertSame(primary[field], secondary[field], `secondary ${field}`);
  }
}

function abiEncodeApproval(kind, structHash) {
  const normalizedStructHash = normalizeHex(structHash);
  if (normalizedStructHash.length !== 66) {
    throw new Error("struct hash must be bytes32");
  }
  const kindHex = BigInt(kind).toString(16).padStart(64, "0");
  return hexToBytes(`${kindHex}${normalizedStructHash.slice(2)}`);
}

function hexToBytes(hex) {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(normalized)) {
    throw new Error("invalid bytes hex");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const primaryApiBase = args[0];
const secondaryApiBase = args[1];
const minConfirmations = Number(args[2]);
const authorization = JSON.parse(args[3]);
const depositAddress = args[4];
const mintStructHash = args[5];

if (!Number.isSafeInteger(minConfirmations) || minConfirmations <= 0) {
  throw new Error("invalid confirmation policy");
}
for (const field of [
  "bridgeDomain",
  "depositId",
  "depositAddressHash",
  "btcTxId"
]) {
  assertBytes32(authorization[field], field);
}
for (const field of ["btcNetwork", "vout", "sats", "confirmations", "observedBlockHeight", "attestationTimestamp", "deadline"]) {
  assertIntegerString(authorization[field], field);
}
if (Date.now() / 1000 > Number(authorization.deadline)) {
  throw new Error("mint authorization is expired");
}

const txid = normalizeTxId(authorization.btcTxId);
const vout = Number(authorization.vout);
if (!Number.isSafeInteger(vout) || vout < 0) {
  throw new Error("invalid vout");
}
assertSame(keccak256Utf8(depositAddress), authorization.depositAddressHash, "depositAddressHash");

const primaryObservation = await observeDeposit(primaryApiBase, txid, vout);
const secondaryObservation = await observeDeposit(secondaryApiBase, txid, vout);
assertObservationMatchesAuthorization(primaryObservation, authorization, depositAddress, minConfirmations);
assertObservationMatchesAuthorization(secondaryObservation, authorization, depositAddress, minConfirmations);
assertObservationsAgree(primaryObservation, secondaryObservation);

return abiEncodeApproval(KIND_MINT, mintStructHash);
