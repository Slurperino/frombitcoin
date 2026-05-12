"use strict";

function normalizeScriptPubKeyHex(scriptPubKeyHex) {
  const raw = String(scriptPubKeyHex || "");
  const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("destinationScriptPubKey must be hex bytes");
  }
  return `0x${hex.toLowerCase()}`;
}

function destinationScriptTemplate(scriptPubKeyHex) {
  const normalized = normalizeScriptPubKeyHex(scriptPubKeyHex);
  const hex = normalized.slice(2);
  if (hex.length === 44 && hex.startsWith("0014")) {
    return "p2wpkh";
  }
  if (hex.length === 68 && hex.startsWith("0020")) {
    return "p2wsh";
  }
  if (hex.length === 68 && hex.startsWith("5120")) {
    return "p2tr";
  }
  throw new Error("unsupported BTC destination script; use signet P2WPKH, P2WSH, or P2TR");
}

function assertAllowedDestinationScript(scriptPubKeyHex) {
  destinationScriptTemplate(scriptPubKeyHex);
}

module.exports = {
  assertAllowedDestinationScript,
  destinationScriptTemplate,
  normalizeScriptPubKeyHex
};
