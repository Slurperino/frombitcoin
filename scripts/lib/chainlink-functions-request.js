const { isHexString } = require("ethers");

const LOCATION_INLINE = 0;
const CODE_LANGUAGE_JAVASCRIPT = 0;

function encodeLength(major, length) {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`invalid CBOR length: ${length}`);
  }

  if (length < 24) {
    return Buffer.from([(major << 5) | length]);
  }
  if (length <= 0xff) {
    return Buffer.from([(major << 5) | 24, length]);
  }
  if (length <= 0xffff) {
    const out = Buffer.alloc(3);
    out[0] = (major << 5) | 25;
    out.writeUInt16BE(length, 1);
    return out;
  }
  if (length <= 0xffffffff) {
    const out = Buffer.alloc(5);
    out[0] = (major << 5) | 26;
    out.writeUInt32BE(length, 1);
    return out;
  }

  const out = Buffer.alloc(9);
  out[0] = (major << 5) | 27;
  out.writeBigUInt64BE(BigInt(length), 1);
  return out;
}

function encodeUnsigned(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid CBOR unsigned integer: ${value}`);
  }
  return encodeLength(0, value);
}

function encodeBytes(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(isHexString(value) ? value.slice(2) : value, isHexString(value) ? "hex" : "utf8");
  return Buffer.concat([encodeLength(2, bytes.length), bytes]);
}

function encodeText(value) {
  const bytes = Buffer.from(String(value), "utf8");
  return Buffer.concat([encodeLength(3, bytes.length), bytes]);
}

function encodeArray(values, encoder) {
  return Buffer.concat([encodeLength(4, values.length), ...values.map(encoder)]);
}

function compareBuffers(a, b) {
  const sharedLength = Math.min(a.length, b.length);
  for (let i = 0; i < sharedLength; ++i) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return a.length - b.length;
}

function encodeCanonicalMap(entries) {
  const encodedEntries = entries
    .map(([key, value]) => [encodeText(key), value])
    .sort(([leftKey], [rightKey]) => compareBuffers(leftKey, rightKey));

  return Buffer.concat([
    encodeLength(5, encodedEntries.length),
    ...encodedEntries.flatMap(([key, value]) => [key, value])
  ]);
}

function buildFunctionsRequestCBOR({
  source,
  args = [],
  bytesArgs = [],
  encryptedSecretsReference,
  secretsLocation
}) {
  if (!source || typeof source !== "string") {
    throw new Error("source must be a non-empty JavaScript string");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("args must be an array of strings");
  }
  if (!Array.isArray(bytesArgs) || bytesArgs.some((arg) => !isHexString(arg))) {
    throw new Error("bytesArgs must be an array of hex strings");
  }

  const entries = [
    ["codeLocation", encodeUnsigned(LOCATION_INLINE)],
    ["codeLanguage", encodeUnsigned(CODE_LANGUAGE_JAVASCRIPT)],
    ["source", encodeText(source)]
  ];

  if (args.length > 0) {
    entries.push(["args", encodeArray(args, encodeText)]);
  }

  if (bytesArgs.length > 0) {
    entries.push(["bytesArgs", encodeArray(bytesArgs, encodeBytes)]);
  }

  if (encryptedSecretsReference) {
    if (!isHexString(encryptedSecretsReference)) {
      throw new Error("encryptedSecretsReference must be a hex string");
    }
    if (secretsLocation !== 1 && secretsLocation !== 2) {
      throw new Error("secretsLocation must be 1 (remote) or 2 (DON-hosted)");
    }
    entries.push(["secretsLocation", encodeUnsigned(secretsLocation)]);
    entries.push(["secrets", encodeBytes(encryptedSecretsReference)]);
  }

  return `0x${encodeCanonicalMap(entries).toString("hex")}`;
}

module.exports = {
  CODE_LANGUAGE_JAVASCRIPT,
  LOCATION_INLINE,
  buildFunctionsRequestCBOR
};
