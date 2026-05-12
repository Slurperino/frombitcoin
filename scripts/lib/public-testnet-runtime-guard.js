"use strict";

const bitcoin = require("bitcoinjs-lib");
const { ZeroAddress, formatEther, isAddress, parseEther } = require("ethers");
const { networkForName } = require("./bitcoin-psbt");

const SEPOLIA_CHAIN_ID = 11155111;
const SIGNET_BTC_NETWORK = "3";
const PUBLIC_TESTNET_MAX_CAP_SATS = 10_000_000n;

function assertStaticPublicTestnetConfig(config) {
  if (Number(config.evm.chainId) !== SEPOLIA_CHAIN_ID) {
    throw new Error(`public testnet requires Sepolia chainId ${SEPOLIA_CHAIN_ID}`);
  }
  if (config.bitcoin.bitcoinNetwork !== "signet") {
    throw new Error("public testnet requires bitcoin.bitcoinNetwork signet");
  }
  if (String(config.bitcoin.btcNetwork) !== SIGNET_BTC_NETWORK) {
    throw new Error(`public testnet requires bitcoin.btcNetwork ${SIGNET_BTC_NETWORK}`);
  }
  for (const [name, value] of [
    ["deposits.maxSats", config.deposits.maxSats],
    ["redeems.maxSats", config.redeems.maxSats],
    ["redeems.maxMinerFeeSats", config.redeems.maxMinerFeeSats]
  ]) {
    if (BigInt(value) > PUBLIC_TESTNET_MAX_CAP_SATS) {
      throw new Error(`${name} must be <= ${PUBLIC_TESTNET_MAX_CAP_SATS} sats for public testnet`);
    }
  }
  assertSignetAddress(config.bitcoin.treasuryAddress, "bitcoin.treasuryAddress");
  assertSignetAddress(config.bitcoin.changeAddress, "bitcoin.changeAddress");
  if (config.bitcoin.custodyController === "chainlink-don" && !config.bitcoin.donCustodyAdapterUrl) {
    throw new Error("bitcoin.donCustodyAdapterUrl is required when bitcoin.custodyController is chainlink-don");
  }
}

async function assertPublicTestnetRuntime({ config, bitcoinRpc, provider, contracts, relayerAddress = null }) {
  assertStaticPublicTestnetConfig(config);
  const [chainInfo, network] = await Promise.all([
    bitcoinRpc.call("getblockchaininfo"),
    provider.getNetwork()
  ]);
  if (!chainInfo || chainInfo.chain !== "signet") {
    throw new Error(`Bitcoin Core must be on signet, got ${chainInfo && chainInfo.chain ? chainInfo.chain : "unknown"}`);
  }
  if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
    throw new Error(`EVM provider must be Sepolia ${SEPOLIA_CHAIN_ID}, got ${network.chainId}`);
  }

  await assertContractRuntime({ config, provider, contracts, relayerAddress });
}

async function assertContractRuntime({ config, provider, contracts, relayerAddress = null }) {
  for (const [name, address] of Object.entries({
    depositRegistry: config.evm.depositRegistry,
    mintGateway: config.evm.mintGateway,
    burnGateway: config.evm.burnGateway,
    wrappedBitcoin: config.evm.wrappedBitcoin,
    chainlinkVerifier: config.evm.chainlinkVerifier
  })) {
    if (!isAddress(address) || address === ZeroAddress) {
      throw new Error(`${name} must be a deployed contract address`);
    }
    const code = await provider.getCode(address);
    if (!code || code === "0x") {
      throw new Error(`${name} has no bytecode at ${address}`);
    }
  }

  await assertContractField(contracts.mintGateway, "btcNetwork", BigInt(config.bitcoin.btcNetwork));
  await assertContractField(contracts.burnGateway, "btcNetwork", BigInt(config.bitcoin.btcNetwork));
  await assertContractField(contracts.burnGateway, "sourceEvmChainId", BigInt(config.evm.chainId));
  await assertContractField(contracts.mintGateway, "bridgeDomain", config.evm.bridgeDomain);
  await assertContractField(contracts.burnGateway, "bridgeDomain", config.evm.bridgeDomain);
  await assertContractField(contracts.mintGateway, "attestationVerifier", config.evm.chainlinkVerifier);
  await assertContractField(contracts.burnGateway, "attestationVerifier", config.evm.chainlinkVerifier);
  await assertContractField(contracts.mintGateway, "bridgeToken", config.evm.wrappedBitcoin);
  await assertContractField(contracts.burnGateway, "bridgeToken", config.evm.wrappedBitcoin);
  await assertContractField(contracts.mintGateway, "depositRegistry", config.evm.depositRegistry);
  await assertContractField(contracts.wrappedBitcoin, "decimals", BigInt(8));
  if (contracts.depositRegistry && typeof contracts.depositRegistry.bridgeDomain === "function") {
    await assertContractField(contracts.depositRegistry, "bridgeDomain", config.evm.bridgeDomain);
  }

  if (config.bitcoin.custodyController === "chainlink-don") {
    await assertChainlinkOnlyRiskRuntime({ config, contracts, relayerAddress });
  }
}

async function assertChainlinkOnlyRiskRuntime({ config, contracts, relayerAddress = null }) {
  await assertRequiredContractField(contracts.wrappedBitcoin, "minterLocked", true, "WrappedBitcoin");
  await assertRequiredContractField(contracts.wrappedBitcoin, "lockedMinter", config.evm.mintGateway, "WrappedBitcoin");
  await assertRequiredContractField(contracts.wrappedBitcoin, "isMinter", true, "WrappedBitcoin", [config.evm.mintGateway]);
  await assertRequiredContractField(contracts.depositRegistry, "consumerLocked", true, "DepositRegistry");
  await assertRequiredContractField(contracts.depositRegistry, "lockedConsumer", config.evm.mintGateway, "DepositRegistry");
  await assertRequiredContractField(
    contracts.depositRegistry,
    "authorizedConsumers",
    true,
    "DepositRegistry",
    [config.evm.mintGateway]
  );

  for (const [label, contract] of Object.entries({
    WrappedBitcoin: contracts.wrappedBitcoin,
    DepositRegistry: contracts.depositRegistry,
    MintGateway: contracts.mintGateway,
    BurnGateway: contracts.burnGateway,
    ChainlinkFunctionsVerifier: contracts.verifier
  })) {
    await assertRequiredContractField(contract, "owner", ZeroAddress, label);
  }

  if (relayerAddress && contracts.verifier && typeof contracts.verifier.authorizedRequester === "function") {
    await assertRequiredContractField(
      contracts.verifier,
      "authorizedRequester",
      true,
      "ChainlinkFunctionsVerifier",
      [relayerAddress]
    );
  }
}

async function assertContractField(contract, field, expected) {
  if (!contract || typeof contract[field] !== "function") {
    return;
  }
  const actual = await contract[field]();
  assertFieldValue(field, actual, expected);
}

async function assertRequiredContractField(contract, field, expected, label, args = []) {
  if (!contract || typeof contract[field] !== "function") {
    throw new Error(`${label}.${field} is not available on configured contract`);
  }
  const actual = await contract[field](...args);
  assertFieldValue(`${label}.${field}`, actual, expected);
}

function assertFieldValue(field, actual, expected) {
  if (typeof expected === "bigint") {
    if (BigInt(actual) !== expected) {
      throw new Error(`${field} mismatch: expected ${expected}, got ${actual}`);
    }
    return;
  }
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${field} mismatch: expected ${expected}, got ${actual}`);
  }
}

function assertSignetAddress(address, label = "Bitcoin address") {
  try {
    bitcoin.address.toOutputScript(address, networkForName("signet"));
  } catch {
    throw new Error(`${label} must be a valid signet address`);
  }
  if (!String(address).toLowerCase().startsWith("tb1")) {
    throw new Error(`${label} must be a signet bech32/bech32m address starting with tb1`);
  }
}

function publicRelayerFundingStatus(balanceWei, minimumEth) {
  if (balanceWei === null || balanceWei === undefined) {
    return "unknown";
  }
  const minimum = parseEther(String(minimumEth || "0"));
  return BigInt(balanceWei) >= minimum ? "funded" : "low";
}

function publicRelayerBalanceBucket(balanceWei) {
  if (balanceWei === null || balanceWei === undefined) {
    return "unknown";
  }
  const eth = Number(formatEther(balanceWei));
  if (!Number.isFinite(eth)) {
    return "unknown";
  }
  if (eth < 0.01) {
    return "<0.01";
  }
  if (eth < 0.05) {
    return "0.01-0.05";
  }
  if (eth < 0.1) {
    return "0.05-0.1";
  }
  if (eth < 0.5) {
    return "0.1-0.5";
  }
  return ">=0.5";
}

module.exports = {
  PUBLIC_TESTNET_MAX_CAP_SATS,
  SEPOLIA_CHAIN_ID,
  SIGNET_BTC_NETWORK,
  assertChainlinkOnlyRiskRuntime,
  assertContractRuntime,
  assertPublicTestnetRuntime,
  assertSignetAddress,
  assertStaticPublicTestnetConfig,
  publicRelayerBalanceBucket,
  publicRelayerFundingStatus
};
