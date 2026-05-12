const test = require("node:test");
const assert = require("node:assert/strict");
const { keccak256, toUtf8Bytes } = require("ethers");
const {
  burnGatewayInterface,
  findRedeemRequestedLog
} = require("../scripts/lib/redeem-event-source");

test("redeem event source extracts canonical RedeemRequested JSON from a receipt log", () => {
  const iface = burnGatewayInterface();
  const fragment = iface.getEvent("RedeemRequested");
  const burnGatewayAddress = "0x9999999999999999999999999999999999999999";
  const redeemRequestHash = keccak256(toUtf8Bytes("redeem-request"));
  const requester = "0x1111111111111111111111111111111111111111";
  const destinationScriptPubKey = "0x0014" + "22".repeat(20);
  const destinationScriptHash = keccak256(destinationScriptPubKey);
  const encoded = iface.encodeEventLog(fragment, [
    redeemRequestHash,
    requester,
    destinationScriptHash,
    7n,
    80000n,
    600n,
    1710000600n,
    destinationScriptPubKey
  ]);
  const receipt = {
    transactionHash: "0x" + "44".repeat(32),
    blockNumber: 123,
    blockHash: "0x" + "aa".repeat(32),
    logs: [
      {
        address: "0x8888888888888888888888888888888888888888",
        topics: encoded.topics,
        data: encoded.data,
        index: 7
      },
      {
        address: burnGatewayAddress,
        topics: encoded.topics,
        data: encoded.data,
        index: 7
      }
    ]
  };

  const event = findRedeemRequestedLog({
    receipt,
    burnGatewayAddress,
    logIndex: 7,
    iface
  });

  assert.equal(event.redeemRequestHash, redeemRequestHash);
  assert.equal(event.blockNumber, 123);
  assert.equal(event.blockHash, receipt.blockHash);
  assert.equal(event.txHash, receipt.transactionHash);
  assert.equal(event.logIndex, 7);
  assert.equal(event.requester, requester);
  assert.equal(event.destinationScriptHash, destinationScriptHash);
  assert.equal(event.requestNonce, "7");
  assert.equal(event.amountSats, "80000");
  assert.equal(event.maxMinerFeeSats, "600");
  assert.equal(event.deadline, "1710000600");
  assert.equal(event.destinationScriptPubKey, destinationScriptPubKey);
});
