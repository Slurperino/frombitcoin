const { STATUS_RELAYED } = require("./redeem-store");
const { normalizedReleaseAuthorizationForContract } = require("./evm-redeem-watcher");

function providerFor(contract) {
  return contract.runner && contract.runner.provider ? contract.runner.provider : null;
}

async function getRelayReceipt(contract, txHash) {
  const provider = providerFor(contract);
  if (!provider || !txHash) {
    return null;
  }

  return provider.getTransactionReceipt(txHash);
}

async function settleRelayedEvent({ burnGateway, store, event, now }) {
  const receipt = await getRelayReceipt(burnGateway, event.relayTxHash);
  if (!receipt) {
    return {
      redeemRequestHash: event.redeemRequestHash,
      txHash: event.relayTxHash,
      status: "pending"
    };
  }

  if (receipt.status === 0) {
    store.markRelayFailed(event.redeemRequestHash, "relay transaction reverted");
    return {
      redeemRequestHash: event.redeemRequestHash,
      txHash: event.relayTxHash,
      status: "failed"
    };
  }

  store.markConsumed(event.redeemRequestHash, receipt, now);
  return {
    redeemRequestHash: event.redeemRequestHash,
    txHash: event.relayTxHash,
    blockNumber: Number(receipt.blockNumber),
    status: "consumed"
  };
}

async function relayAttestedRedeems({
  burnGateway,
  store,
  limit = 100,
  now = Math.floor(Date.now() / 1000)
}) {
  const events = store.listRelayEligible(limit);
  const results = [];

  for (const event of events) {
    try {
      const contractAuthorization = normalizedReleaseAuthorizationForContract(event.releaseAuthorization);

      if (event.status === STATUS_RELAYED && event.relayTxHash) {
        const settled = await settleRelayedEvent({ burnGateway, store, event, now });
        if (settled.status !== "pending") {
          results.push(settled);
          continue;
        }

        if (await burnGateway.isRedeemIdConsumed(contractAuthorization.redeemId)) {
          store.markAlreadyConsumed(event.redeemRequestHash, now);
          results.push({
            redeemRequestHash: event.redeemRequestHash,
            redeemId: contractAuthorization.redeemId,
            status: "already_consumed"
          });
          continue;
        }

        results.push(settled);
        continue;
      }

      if (await burnGateway.isRedeemIdConsumed(contractAuthorization.redeemId)) {
        store.markAlreadyConsumed(event.redeemRequestHash, now);
        results.push({
          redeemRequestHash: event.redeemRequestHash,
          redeemId: contractAuthorization.redeemId,
          status: "already_consumed"
        });
        continue;
      }

      if (!event.attestation) {
        throw new Error("missing DON attestation for relayer");
      }

      const tx = await burnGateway.completeRedeemWithAuthorization(contractAuthorization, event.attestation);
      store.markRelayed(event.redeemRequestHash, tx.hash);

      const receipt = await tx.wait();
      if (receipt.status === 0) {
        store.markRelayFailed(event.redeemRequestHash, "relay transaction reverted");
        results.push({
          redeemRequestHash: event.redeemRequestHash,
          redeemId: contractAuthorization.redeemId,
          txHash: tx.hash,
          status: "failed"
        });
        continue;
      }

      store.markConsumed(event.redeemRequestHash, receipt, now);
      results.push({
        redeemRequestHash: event.redeemRequestHash,
        redeemId: contractAuthorization.redeemId,
        txHash: tx.hash,
        blockNumber: Number(receipt.blockNumber),
        status: "consumed"
      });
    } catch (error) {
      store.markError(event.redeemRequestHash, error);
      throw error;
    }
  }

  return results;
}

module.exports = {
  relayAttestedRedeems
};
