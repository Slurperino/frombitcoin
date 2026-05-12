const bitcoin = require("bitcoinjs-lib");
const { Command } = require("commander");
const { Contract, JsonRpcProvider, Wallet } = require("ethers");
const { loadArtifact } = require("./lib/artifacts");
const { BitcoinCoreRpc } = require("./lib/bitcoin-core-rpc");
const { buildWalletFundedPsbt, broadcastRawTransaction } = require("./lib/bitcoin-core-psbt");
const { createDonCustodyClient } = require("./lib/don-custody-client");
const { extractNormalizedSpendPlanFromPsbt, networkForName } = require("./lib/bitcoin-psbt");
const { assertAllowedDestinationScript } = require("./lib/destination-script-policy");
const {
  buildReleaseAuthorization,
  logToRedeemEvent,
  normalizedReleaseAuthorizationForContract
} = require("./lib/evm-redeem-watcher");
const {
  PublicTestnetStore,
  REDEEM_REDEEM_SUBMITTED
} = require("./lib/public-testnet-store");
const {
  bitcoinRpcOptions,
  loadPublicTestnetConfig,
  resolveEnvSecret
} = require("./lib/public-testnet-config");
const {
  buildMintAuthorization,
  buildMintAuthorizationRequest,
  buildReleaseAuthorizationRequest,
  chainlinkAttestation,
  loadFunctionsSource,
  normalizePendingRequest,
  requestMintAuthorization,
  requestReleaseAuthorization
} = require("./lib/public-testnet-chainlink");
const {
  toDonReleasePreparationRequest,
  toMintAuthorization,
  verifyReleaseSpendPlan
} = require("./lib/authorization-validator");
const { assertPublicTestnetRuntime } = require("./lib/public-testnet-runtime-guard");
const { createLogger, sleep, unixNow } = require("./lib/service-runtime");

const REDEEM_CURSOR = "public_redeem_watcher.last_scanned_block";

function createWorkerResources(config) {
  const provider = new JsonRpcProvider(config.evm.rpcUrl);
  const signer = new Wallet(resolveEnvSecret(config.evm.relayerPrivateKeyEnv, "EVM relayer private key"), provider);
  const bitcoinRpc = new BitcoinCoreRpc(bitcoinRpcOptions(config));
  const donCustody = config.bitcoin.custodyController === "chainlink-don"
    ? createDonCustodyClient({
        url: config.bitcoin.donCustodyAdapterUrl,
        timeoutMs: config.bitcoin.donCustodyAdapterTimeoutMs
      })
    : null;
  return {
    provider,
    signer,
    bitcoinRpc,
    donCustody,
    contracts: {
      depositRegistry: new Contract(config.evm.depositRegistry, loadArtifact("DepositRegistry").abi, signer),
      mintGateway: new Contract(config.evm.mintGateway, loadArtifact("MintGateway").abi, signer),
      burnGateway: new Contract(config.evm.burnGateway, loadArtifact("BurnGateway").abi, signer),
      wrappedBitcoin: new Contract(config.evm.wrappedBitcoin, loadArtifact("WrappedBitcoin").abi, signer),
      verifier: new Contract(config.evm.chainlinkVerifier, loadArtifact("ChainlinkFunctionsVerifier").abi, signer)
    },
    sources: {
      mint: loadFunctionsSource("mint-authorization.js"),
      release: loadFunctionsSource("release-authorization.js")
    }
  };
}

async function runCycle({ config, store, resources, logger }) {
  const startedAt = Date.now();
  const results = {};

  results.depositsObserved = await observeDeposits({ config, store, resources, logger });
  results.mintRequests = await requestMintAuthorizations({ config, store, resources, logger });
  results.mintCallbacks = await settleMintCallbacks({ config, store, resources, logger });
  results.redeemsScanned = await scanRedeems({ config, store, resources });
  results.redeemsPrepared = await prepareRedeems({ config, store, resources, logger });
  results.releaseRequests = await requestReleaseAuthorizations({ config, store, resources, logger });
  results.releaseCallbacks = await settleReleaseCallbacks({ config, store, resources, logger });
  results.bitcoinBroadcasts = config.redeems.autoBroadcastBitcoin
    ? await broadcastBitcoinReleases({ config, store, resources, logger })
    : { skipped: true, broadcasted: 0 };

  logger.info("public_worker_cycle_completed", {
    durationMs: Date.now() - startedAt,
    results
  });
  return results;
}

async function runWorkerLoop({
  config,
  store,
  resources,
  logger,
  once = false,
  shouldStop = () => false,
  sleepFn = sleep,
  cycle = runCycle
}) {
  const runOnce = Boolean(once || config.worker.once);

  do {
    const startedAt = Date.now();
    try {
      await cycle({ config, store, resources, logger });
    } catch (error) {
      logger.error("public_worker_cycle_failed", {
        durationMs: Date.now() - startedAt,
        error: error.message || String(error)
      });
      if (runOnce) {
        throw error;
      }
    }

    if (!runOnce && !shouldStop()) {
      await sleepFn(config.worker.pollIntervalMs);
    }
  } while (!runOnce && !shouldStop());
}

async function observeDeposits({ config, store, resources, logger }) {
  const deposits = store.listDepositObservationEligible(config.deposits.limit);
  if (deposits.length === 0) {
    return { checked: 0, observed: 0 };
  }

  const tipHeight = Number(await resources.bitcoinRpc.call("getblockcount"));
  let observed = 0;
  for (const deposit of deposits) {
    try {
      const utxos = await resources.bitcoinRpc.call("listunspent", [0, 9999999, [deposit.depositAddress], true]);
      const exact = utxos
        .map((utxo) => ({ utxo, sats: btcAmountToSats(utxo.amount) }))
        .filter(({ sats }) => sats === BigInt(deposit.expectedSats))
        .sort((a, b) => Number(b.utxo.confirmations || 0) - Number(a.utxo.confirmations || 0));

      if (exact.length === 0) {
        if (utxos.length > 0) {
          store.markDepositError(deposit.depositId, "observed UTXO amount does not match exact deposit intent");
        }
        continue;
      }

      const { utxo, sats } = exact[0];
      store.markDepositObserved({
        depositId: deposit.depositId,
        txid: String(utxo.txid).toLowerCase(),
        vout: Number(utxo.vout),
        sats: sats.toString(),
        confirmations: Number(utxo.confirmations || 0),
        observedBlockHeight: tipHeight
      });
      observed += 1;
      logger.info("public_deposit_observed", {
        depositId: deposit.depositId,
        txid: utxo.txid,
        vout: Number(utxo.vout),
        sats: sats.toString(),
        confirmations: Number(utxo.confirmations || 0)
      });
    } catch (error) {
      store.markDepositError(deposit.depositId, error);
      logger.error("public_deposit_observation_failed", {
        depositId: deposit.depositId,
        error: error.message
      });
    }
  }

  return { checked: deposits.length, observed };
}

async function requestMintAuthorizations({ config, store, resources, logger }) {
  const deposits = store.listMintRequestEligible({
    minConfirmations: config.chainlink.minConfirmations,
    limit: config.deposits.limit
  });
  let requested = 0;

  for (const deposit of deposits) {
    try {
      const now = unixNow();
      if (now > Number(deposit.expiry)) {
        store.markDepositFailed(deposit.depositId, "deposit intent expired before mint authorization");
        continue;
      }

      const authorization = buildMintAuthorization({ config, deposit, now });
      const request = buildMintAuthorizationRequest({
        config,
        source: resources.sources.mint,
        authorization,
        depositAddress: deposit.depositAddress
      });
      const result = await workerRpcCall({
        config,
        label: "verifier.requestMintAuthorization",
        retry: false,
        operation: () => requestMintAuthorization({
          verifier: resources.contracts.verifier,
          requestData: request.requestData,
          contractAuthorization: request.contractAuthorization
        })
      });

      store.markMintRequested({
        depositId: deposit.depositId,
        authorization,
        requestId: result.requestId,
        requestTxHash: result.txHash,
        structHash: request.structHash
      });
      requested += 1;
      logger.info("public_mint_authorization_requested", {
        depositId: deposit.depositId,
        requestId: result.requestId,
        txHash: result.txHash
      });
    } catch (error) {
      store.markDepositError(deposit.depositId, error);
      logger.error("public_mint_authorization_request_failed", {
        depositId: deposit.depositId,
        error: error.message
      });
    }
  }

  return { checked: deposits.length, requested };
}

async function settleMintCallbacks({ config, store, resources, logger }) {
  const deposits = store.listMintCallbackEligible(100);
  let fulfilled = 0;
  let minted = 0;
  for (const deposit of deposits) {
    try {
      const pending = normalizePendingRequest(await workerRpcCall({
        config,
        label: "verifier.pendingRequests(mint)",
        operation: () => resources.contracts.verifier.pendingRequests(deposit.mintRequestId)
      }));
      if (!pending.exists) {
        store.markDepositFailed(deposit.depositId, "Chainlink mint request is unknown on verifier");
        continue;
      }
      if (!pending.fulfilled) {
        continue;
      }
      fulfilled += 1;
      if (!pending.approved) {
        store.markDepositFailed(deposit.depositId, "Chainlink mint authorization rejected");
        continue;
      }

      const contractAuthorization = toMintAuthorization(deposit.mintAuthorization);
      const tx = await workerRpcCall({
        config,
        label: "mintGateway.mintWithAuthorization",
        retry: false,
        operation: () => resources.contracts.mintGateway.mintWithAuthorization(
          deposit.intent,
          contractAuthorization,
          chainlinkAttestation(deposit.mintRequestId)
        )
      });
      const receipt = await workerRpcCall({
        config,
        label: "mintGateway.mintWithAuthorization.wait",
        retry: false,
        operation: () => tx.wait()
      });
      if (receipt.status === 0) {
        store.markDepositFailed(deposit.depositId, "mintWithAuthorization transaction reverted");
        continue;
      }

      store.markMinted({
        depositId: deposit.depositId,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber
      });
      minted += 1;
      logger.info("public_deposit_minted", {
        depositId: deposit.depositId,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber
      });
    } catch (error) {
      store.markDepositError(deposit.depositId, error);
      logger.error("public_mint_settle_failed", {
        depositId: deposit.depositId,
        error: error.message
      });
    }
  }

  return { checked: deposits.length, fulfilled, minted };
}

async function scanRedeems({ config, store, resources }) {
  const latestBlock = await workerRpcCall({
    config,
    label: "provider.getBlockNumber(scanRedeems)",
    operation: () => resources.provider.getBlockNumber()
  });
  const finalizedBlock = latestBlock - config.evm.finalityBlocks;
  const previousCursor = store.getCursor(REDEEM_CURSOR);
  const lastScannedBlock = previousCursor === null ? config.evm.fromBlock - 1 : Number(previousCursor);
  const fromBlock = lastScannedBlock + 1;
  let toBlock = lastScannedBlock;
  let scanned = 0;

  if (finalizedBlock >= fromBlock) {
    toBlock = Math.min(finalizedBlock, fromBlock + config.evm.scanBatchSize - 1);
    const logs = await workerRpcCall({
      config,
      label: "burnGateway.queryFilter(RedeemRequested)",
      operation: () => resources.contracts.burnGateway.queryFilter(
        resources.contracts.burnGateway.filters.RedeemRequested(),
        fromBlock,
        toBlock
      )
    });
    for (const log of logs) {
      store.upsertRedeemObserved(logToRedeemEvent(log));
    }
    scanned = logs.length;
    store.setCursor(REDEEM_CURSOR, toBlock);
  }

  return {
    latestBlock,
    finalizedBlock,
    fromBlock,
    toBlock,
    scanned,
    cursor: store.getCursor(REDEEM_CURSOR)
  };
}

async function prepareRedeems({ config, store, resources, logger }) {
  const latestBlock = await workerRpcCall({
    config,
    label: "provider.getBlockNumber(prepareRedeems)",
    operation: () => resources.provider.getBlockNumber()
  });
  const finalizedBlock = latestBlock - config.evm.finalityBlocks;
  const redeems = store.listRedeemPreparationEligible({
    finalizedBlock,
    limit: config.redeems.limit
  });
  const bridgeConfig = {
    bridgeDomain: config.evm.bridgeDomain,
    btcNetwork: Number(config.bitcoin.btcNetwork),
    sourceEvmChainId: Number(config.evm.chainId)
  };
  let prepared = 0;

  for (const redeem of redeems) {
    try {
      const now = unixNow();
      if (markExpiredRedeem({ store, redeem, now, stage: "redeem preparation" })) {
        continue;
      }
      const limitViolation = redeemLimitViolation(config, redeem);
      if (limitViolation) {
        store.markRedeemFailed(redeem.redeemRequestHash, limitViolation, now);
        logger.error("public_redeem_rejected", {
          redeemRequestHash: redeem.redeemRequestHash,
          error: limitViolation
        });
        continue;
      }
      assertAllowedDestinationScript(redeem.destinationScriptPubKey);
      const block = await workerRpcCall({
        config,
        label: "provider.getBlock(redeem)",
        operation: () => resources.provider.getBlock(redeem.blockNumber)
      });
      if (!block || String(block.hash).toLowerCase() !== String(redeem.blockHash).toLowerCase()) {
        store.markRedeemFailed(redeem.redeemRequestHash, "redeem event block hash changed before finality");
        continue;
      }

      const destinationAddress = destinationAddressFromScript(
        redeem.destinationScriptPubKey,
        config.bitcoin.bitcoinNetwork
      );
      const preparedRelease = config.bitcoin.custodyController === "chainlink-don"
        ? await prepareDonCustodyRelease({
            config,
            resources,
            redeem,
            bridgeConfig,
            destinationAddress
          })
        : await prepareLocalWalletRelease({
            config,
            resources,
            redeem,
            destinationAddress
          });
      const authorization = buildReleaseAuthorization({
        event: redeem,
        bridgeConfig,
        spendPlan: preparedRelease.spendPlan,
        changePolicyHash: config.redeems.changePolicyHash,
        now,
        ttlSeconds: config.redeems.authorizationTtlSeconds
      });

      store.markRedeemPrepared({
        redeemRequestHash: redeem.redeemRequestHash,
        destinationAddress: preparedRelease.destinationAddress,
        psbt: preparedRelease.psbt,
        spendPlan: preparedRelease.spendPlan,
        authorization,
        bitcoinTxHex: preparedRelease.bitcoinTxHex
      });
      prepared += 1;
      logger.info("public_redeem_prepared", {
        redeemRequestHash: redeem.redeemRequestHash,
        custodyController: config.bitcoin.custodyController,
        destinationAddress: preparedRelease.destinationAddress,
        amountSats: redeem.amountSats,
        feeSats: preparedRelease.spendPlan.feeSats,
        bitcoinTxFinalized: Boolean(preparedRelease.bitcoinTxHex)
      });
    } catch (error) {
      store.markRedeemError(redeem.redeemRequestHash, error);
      logger.error("public_redeem_prepare_failed", {
        redeemRequestHash: redeem.redeemRequestHash,
        error: error.message
      });
    }
  }

  return { checked: redeems.length, prepared };
}

async function prepareLocalWalletRelease({ config, resources, redeem, destinationAddress }) {
  const funded = await buildWalletFundedPsbt({
    rpc: resources.bitcoinRpc,
    btcNetwork: config.bitcoin.btcNetwork,
    bitcoinNetwork: config.bitcoin.bitcoinNetwork,
    destinationAddress,
    amountSats: redeem.amountSats,
    changeAddress: config.bitcoin.changeAddress,
    minConf: config.bitcoin.minConf,
    lockUnspents: true
  });

  return {
    destinationAddress,
    psbt: funded.psbt,
    spendPlan: funded.spendPlan,
    bitcoinTxHex: null
  };
}

async function prepareDonCustodyRelease({ config, resources, redeem, bridgeConfig, destinationAddress }) {
  if (!resources.donCustody || typeof resources.donCustody.prepareRelease !== "function") {
    throw new Error("DON-controlled BTC custody requires a configured DON custody adapter");
  }

  const prepared = await resources.donCustody.prepareRelease({
    request: buildDonCustodyReleaseRequest({
      config,
      redeem,
      bridgeConfig,
      destinationAddress
    })
  });
  if (prepared.destinationAddress && prepared.destinationAddress !== destinationAddress) {
    throw new Error("DON custody adapter destinationAddress does not match redeem destination script");
  }
  if (!prepared.bitcoinTxHex) {
    throw new Error("DON-controlled BTC custody requires a finalized Bitcoin transaction from the DON signer");
  }

  return {
    destinationAddress,
    psbt: null,
    spendPlan: prepared.spendPlan,
    bitcoinTxHex: prepared.bitcoinTxHex
  };
}

function buildDonCustodyReleaseRequest({ config, redeem, bridgeConfig, destinationAddress }) {
  return toDonReleasePreparationRequest({
    kind: "DonReleasePreparationRequestV1",
    schemaVersion: "1.0.0",
    bridgeDomain: bridgeConfig.bridgeDomain,
    btcNetwork: String(bridgeConfig.btcNetwork),
    sourceEvmChainId: String(bridgeConfig.sourceEvmChainId),
    bitcoinNetwork: config.bitcoin.bitcoinNetwork,
    treasuryAddress: config.bitcoin.treasuryAddress,
    changePolicyHash: config.redeems.changePolicyHash,
    redeemEvent: {
      redeemRequestHash: redeem.redeemRequestHash,
      requester: redeem.requester,
      txHash: redeem.txHash,
      blockNumber: String(redeem.blockNumber),
      blockHash: redeem.blockHash,
      logIndex: String(redeem.logIndex),
      destinationScriptHash: redeem.destinationScriptHash,
      destinationScriptPubKey: redeem.destinationScriptPubKey,
      requestNonce: redeem.requestNonce,
      amountSats: redeem.amountSats,
      maxMinerFeeSats: redeem.maxMinerFeeSats,
      deadline: redeem.deadline
    },
    destinationAddress
  });
}

async function requestReleaseAuthorizations({ config, store, resources, logger }) {
  const redeems = store.listReleaseRequestEligible(config.redeems.limit);
  let requested = 0;

  for (const redeem of redeems) {
    try {
      const now = unixNow();
      if (markExpiredRedeem({ store, redeem, now, stage: "release authorization request" })) {
        continue;
      }
      const request = buildReleaseAuthorizationRequest({
        config,
        source: resources.sources.release,
        authorization: redeem.releaseAuthorization,
        spendPlan: redeem.spendPlan
      });
      const result = await workerRpcCall({
        config,
        label: "verifier.requestReleaseAuthorization",
        retry: false,
        operation: () => requestReleaseAuthorization({
          verifier: resources.contracts.verifier,
          requestData: request.requestData,
          contractAuthorization: request.contractAuthorization
        })
      });

      store.markReleaseRequested({
        redeemRequestHash: redeem.redeemRequestHash,
        requestId: result.requestId,
        requestTxHash: result.txHash,
        structHash: request.structHash
      });
      requested += 1;
      logger.info("public_release_authorization_requested", {
        redeemRequestHash: redeem.redeemRequestHash,
        requestId: result.requestId,
        txHash: result.txHash
      });
    } catch (error) {
      store.markRedeemError(redeem.redeemRequestHash, error);
      logger.error("public_release_authorization_request_failed", {
        redeemRequestHash: redeem.redeemRequestHash,
        error: error.message
      });
    }
  }

  return { checked: redeems.length, requested };
}

async function settleReleaseCallbacks({ config, store, resources, logger }) {
  const redeems = store.listReleaseCallbackEligible(100);
  let fulfilled = 0;
  let completed = 0;

  for (const redeem of redeems) {
    try {
      const now = unixNow();
      if (redeem.status === REDEEM_REDEEM_SUBMITTED) {
        const settled = await settleSubmittedRedeem({ config, store, resources, logger, redeem, now });
        if (settled.completed) {
          completed += 1;
        }
        continue;
      }
      if (markExpiredRedeem({ store, redeem, now, stage: "redeem completion" })) {
        continue;
      }
      const pending = normalizePendingRequest(await workerRpcCall({
        config,
        label: "verifier.pendingRequests(release)",
        operation: () => resources.contracts.verifier.pendingRequests(redeem.releaseRequestId)
      }));
      if (!pending.exists) {
        store.markRedeemFailed(redeem.redeemRequestHash, "Chainlink release request is unknown on verifier");
        continue;
      }
      if (!pending.fulfilled) {
        continue;
      }
      fulfilled += 1;
      if (!pending.approved) {
        store.markRedeemFailed(redeem.redeemRequestHash, "Chainlink release authorization rejected");
        continue;
      }

      const contractAuthorization = normalizedReleaseAuthorizationForContract(redeem.releaseAuthorization);
      const consumed = await workerRpcCall({
        config,
        label: "burnGateway.isRedeemIdConsumed",
        operation: () => resources.contracts.burnGateway.isRedeemIdConsumed(contractAuthorization.redeemId)
      });
      if (consumed) {
        const reconciled = await reconcileConsumedRedeem({ config, store, resources, logger, redeem, contractAuthorization, now });
        if (reconciled) {
          completed += 1;
        }
        continue;
      }

      const tx = await workerRpcCall({
        config,
        label: "burnGateway.completeRedeemWithAuthorization",
        retry: false,
        operation: () => resources.contracts.burnGateway.completeRedeemWithAuthorization(
          contractAuthorization,
          chainlinkAttestation(redeem.releaseRequestId)
        )
      });
      store.markRedeemSubmitted({
        redeemRequestHash: redeem.redeemRequestHash,
        txHash: tx.hash
      });
      const receipt = await workerRpcCall({
        config,
        label: "burnGateway.completeRedeemWithAuthorization.wait",
        retry: false,
        operation: () => tx.wait()
      });
      if (receipt.status === 0) {
        store.markRedeemFailed(redeem.redeemRequestHash, "completeRedeemWithAuthorization transaction reverted");
        continue;
      }

      store.markRedeemCompleted({
        redeemRequestHash: redeem.redeemRequestHash,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber
      });
      completed += 1;
      logger.info("public_redeem_completed", {
        redeemRequestHash: redeem.redeemRequestHash,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber
      });
    } catch (error) {
      store.markRedeemError(redeem.redeemRequestHash, error);
      logger.error("public_release_settle_failed", {
        redeemRequestHash: redeem.redeemRequestHash,
        error: error.message
      });
    }
  }

  return { checked: redeems.length, fulfilled, completed };
}

async function reconcileConsumedRedeem({ config, store, resources, logger, redeem, contractAuthorization, now }) {
  const filter = resources.contracts.burnGateway.filters.RedeemConsumed(
    redeem.redeemRequestHash,
    contractAuthorization.redeemId
  );
  const fromBlock = Math.max(0, Number(redeem.blockNumber || 0));
  const events = await workerRpcCall({
    config,
    label: "burnGateway.queryFilter(RedeemConsumed)",
    operation: () => resources.contracts.burnGateway.queryFilter(filter, fromBlock, "latest")
  });
  const event = events[0];
  if (!event) {
    store.markRedeemError(
      redeem.redeemRequestHash,
      "redeem id is consumed, but RedeemConsumed event was not found yet",
      now
    );
    return false;
  }

  const txHash = event.transactionHash || event.log && event.log.transactionHash;
  const blockNumber = event.blockNumber || event.log && event.log.blockNumber;
  if (!txHash || blockNumber === undefined || blockNumber === null) {
    store.markRedeemError(redeem.redeemRequestHash, "RedeemConsumed event is missing transaction metadata", now);
    return false;
  }

  store.markRedeemCompleted({
    redeemRequestHash: redeem.redeemRequestHash,
    txHash,
    blockNumber,
    now
  });
  logger.info("public_redeem_completed_reconciled", {
    redeemRequestHash: redeem.redeemRequestHash,
    txHash,
    blockNumber
  });
  return true;
}

async function settleSubmittedRedeem({ config, store, resources, logger, redeem, now }) {
  if (!redeem.completeRedeemTxHash) {
    store.markRedeemError(redeem.redeemRequestHash, "submitted redeem is missing completion transaction hash", now);
    return { completed: false };
  }

  const receipt = await workerRpcCall({
    config,
    label: "provider.getTransactionReceipt(completeRedeemWithAuthorization)",
    operation: () => resources.provider.getTransactionReceipt(redeem.completeRedeemTxHash)
  });
  if (!receipt) {
    return { completed: false };
  }
  if (receipt.status === 0) {
    store.markRedeemFailed(redeem.redeemRequestHash, "completeRedeemWithAuthorization transaction reverted", now);
    return { completed: false };
  }

  store.markRedeemCompleted({
    redeemRequestHash: redeem.redeemRequestHash,
    txHash: receipt.hash || redeem.completeRedeemTxHash,
    blockNumber: receipt.blockNumber,
    now
  });
  logger.info("public_redeem_completed", {
    redeemRequestHash: redeem.redeemRequestHash,
    txHash: receipt.hash || redeem.completeRedeemTxHash,
    blockNumber: receipt.blockNumber
  });
  return { completed: true };
}

async function broadcastBitcoinReleases({ config, store, resources, logger }) {
  const redeems = store.listBitcoinBroadcastEligible(config.redeems.limit);
  let broadcasted = 0;

  for (const redeem of redeems) {
    try {
      let txHex = redeem.bitcoinTxHex;
      if (!txHex) {
        if (config.bitcoin.custodyController === "chainlink-don") {
          throw new Error("DON-controlled BTC custody requires a finalized Bitcoin transaction from the DON signer");
        }
        assertReleasePsbtMatchesAuthorization({
          redeem,
          bitcoinNetwork: config.bitcoin.bitcoinNetwork
        });
        const processed = await resources.bitcoinRpc.call("walletprocesspsbt", [
          redeem.psbt.psbtBase64,
          true,
          "ALL",
          true
        ]);
        const finalized = await resources.bitcoinRpc.call("finalizepsbt", [processed.psbt, true]);
        if (!finalized.complete || !finalized.hex) {
          throw new Error("Bitcoin Core could not finalize release PSBT");
        }
        txHex = finalized.hex;
        store.markBitcoinFinalized({
          redeemRequestHash: redeem.redeemRequestHash,
          txHex
        });
      }

      const result = await broadcastRawTransaction({
        rpc: resources.bitcoinRpc,
        txHex
      });
      store.markBitcoinBroadcast({
        redeemRequestHash: redeem.redeemRequestHash,
        txid: result.txid,
        txHex
      });
      broadcasted += 1;
      logger.info("public_bitcoin_release_broadcast", {
        redeemRequestHash: redeem.redeemRequestHash,
        bitcoinTxId: result.txid
      });
    } catch (error) {
      store.markRedeemError(redeem.redeemRequestHash, error);
      logger.error("public_bitcoin_release_broadcast_failed", {
        redeemRequestHash: redeem.redeemRequestHash,
        error: error.message
      });
    }
  }

  return { checked: redeems.length, broadcasted };
}

function redeemLimitViolation(config, redeem) {
  if (BigInt(redeem.amountSats) > BigInt(config.redeems.maxSats)) {
    return `redeem amount exceeds public testnet max ${config.redeems.maxSats} sats`;
  }
  if (BigInt(redeem.maxMinerFeeSats) > BigInt(config.redeems.maxMinerFeeSats)) {
    return `redeem miner fee budget exceeds public testnet max ${config.redeems.maxMinerFeeSats} sats`;
  }
  return null;
}

function assertReleasePsbtMatchesAuthorization({ redeem, bitcoinNetwork }) {
  if (!redeem.psbt) {
    throw new Error("redeem is missing release PSBT");
  }
  if (!redeem.releaseAuthorization) {
    throw new Error("redeem is missing release authorization");
  }
  const spendPlan = {
    kind: "NormalizedSpendPlanV1",
    schemaVersion: "1.0.0",
    ...extractNormalizedSpendPlanFromPsbt(redeem.psbt, bitcoinNetwork)
  };
  verifyReleaseSpendPlan(redeem.releaseAuthorization, spendPlan);
  return spendPlan;
}

function redeemExpirationReason(redeem, now, stage) {
  const redeemDeadline = Number(redeem.deadline);
  if (!Number.isSafeInteger(redeemDeadline)) {
    return `redeem deadline is invalid before ${stage}`;
  }
  if (now > redeemDeadline) {
    return `redeem deadline expired before ${stage}`;
  }

  if (redeem.releaseAuthorization && redeem.releaseAuthorization.deadline !== undefined) {
    const authorizationDeadline = Number(redeem.releaseAuthorization.deadline);
    if (!Number.isSafeInteger(authorizationDeadline)) {
      return `release authorization deadline is invalid before ${stage}`;
    }
    if (now > authorizationDeadline) {
      return `release authorization deadline expired before ${stage}`;
    }
  }

  return null;
}

function markExpiredRedeem({ store, redeem, now, stage }) {
  const reason = redeemExpirationReason(redeem, now, stage);
  if (!reason) {
    return false;
  }
  store.markRedeemFailed(redeem.redeemRequestHash, reason, now);
  return true;
}

async function workerRpcCall({ config, label, operation, retry = true }) {
  const rpcConfig = config.worker || {};
  const timeoutMs = rpcConfig.rpcTimeoutMs ?? 9000;
  const maxRetries = retry ? rpcConfig.rpcMaxRetries ?? 0 : 0;
  const retryDelayMs = rpcConfig.rpcRetryDelayMs ?? 0;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await withTimeout(Promise.resolve().then(operation), timeoutMs, label);
    } catch (error) {
      if (attempt >= maxRetries) {
        throw error;
      }
      await sleep(retryDelayMs);
    }
  }

  throw new Error(`${label} failed after retries`);
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function destinationAddressFromScript(scriptPubKeyHex, networkName) {
  const hex = String(scriptPubKeyHex).startsWith("0x") ? String(scriptPubKeyHex).slice(2) : String(scriptPubKeyHex);
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length === 0 || hex.length % 2 !== 0) {
    throw new Error("destinationScriptPubKey must be hex bytes");
  }
  assertAllowedDestinationScript(scriptPubKeyHex);
  return bitcoin.address.fromOutputScript(Buffer.from(hex, "hex"), networkForName(networkName));
}

function btcAmountToSats(value) {
  const decimal = typeof value === "number" ? value.toFixed(8) : String(value);
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(decimal)) {
    throw new Error(`invalid BTC amount from Bitcoin Core: ${value}`);
  }
  const [whole, fraction = ""] = decimal.split(".");
  return BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, "0"));
}

async function main() {
  const program = new Command();
  program
    .requiredOption("--config <path>", "public testnet service JSON config")
    .option("--once", "run one worker cycle and exit", false);
  program.parse(process.argv);
  const options = program.opts();

  const config = loadPublicTestnetConfig(options.config);
  const logger = createLogger({ service: config.serviceName, role: "public-worker" });
  const store = new PublicTestnetStore(config.database);
  const resources = createWorkerResources(config);
  await assertPublicTestnetRuntime({
    config,
    bitcoinRpc: resources.bitcoinRpc,
    provider: resources.provider,
    contracts: resources.contracts,
    relayerAddress: resources.signer.address
  });
  let stopping = false;
  const stop = () => {
    stopping = true;
    logger.info("shutdown_requested");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    logger.info("public_worker_started", {
      once: Boolean(options.once || config.worker.once),
      pollIntervalMs: config.worker.pollIntervalMs
    });
    await runWorkerLoop({
      config,
      store,
      resources,
      logger,
      once: options.once,
      shouldStop: () => stopping
    });
  } finally {
    store.close();
    logger.info("public_worker_stopped");
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  btcAmountToSats,
  assertReleasePsbtMatchesAuthorization,
  broadcastBitcoinReleases,
  buildDonCustodyReleaseRequest,
  createWorkerResources,
  destinationAddressFromScript,
  markExpiredRedeem,
  prepareDonCustodyRelease,
  prepareLocalWalletRelease,
  prepareRedeems,
  redeemExpirationReason,
  requestReleaseAuthorizations,
  runCycle,
  runWorkerLoop,
  settleSubmittedRedeem,
  settleReleaseCallbacks,
  workerRpcCall
};
