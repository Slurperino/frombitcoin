const SEPOLIA_CHAIN_ID = "0xaa36a7";
const UINT64_MAX_STRING = "18446744073709551615";
const UINT64_MAX = BigInt(UINT64_MAX_STRING);
const UINT256_ZERO = "0".repeat(64);
const FUNCTION_SELECTORS = {
  balanceOf: "0x70a08231",
  allowance: "0xdd62ed3e",
  approve: "0x095ea7b3",
  burn: "0x26592b71"
};

const appState = {
  status: null,
  deposits: [],
  redeems: [],
  selectedTab: "deposits",
  latestDeposit: null,
  latestRedeem: null,
  latestTicketType: null,
  busy: false,
  walletBusy: false,
  wallet: {
    account: null,
    chainId: null,
    balanceSats: null,
    allowanceSats: null
  }
};

const elements = {
  refreshButton: document.getElementById("refresh-button"),
  connectWalletButton: document.getElementById("connect-wallet-button"),
  servicePill: document.getElementById("service-pill"),
  notice: document.getElementById("notice"),
  bitcoinBlock: document.getElementById("bitcoin-block"),
  evmBlock: document.getElementById("evm-block"),
  tokenSupply: document.getElementById("token-supply"),
  relayerEth: document.getElementById("relayer-eth"),
  depositCap: document.getElementById("deposit-cap"),
  redeemCap: document.getElementById("redeem-cap"),
  feeBudget: document.getElementById("fee-budget"),
  minConfirmations: document.getElementById("min-confirmations"),
  wrappedBitcoinContract: document.getElementById("wrapped-bitcoin-contract"),
  mintGatewayContract: document.getElementById("mint-gateway-contract"),
  burnGatewayContract: document.getElementById("burn-gateway-contract"),
  chainlinkVerifierContract: document.getElementById("chainlink-verifier-contract"),
  depositLimits: document.getElementById("deposit-limits"),
  redeemLimits: document.getElementById("redeem-limits"),
  walletAddress: document.getElementById("wallet-address"),
  walletBalance: document.getElementById("wallet-balance"),
  depositForm: document.getElementById("deposit-form"),
  recipientInput: document.getElementById("recipient-input"),
  amountInput: document.getElementById("amount-input"),
  createDepositButton: document.getElementById("create-deposit-button"),
  quickAmounts: document.querySelectorAll("[data-sats]"),
  redeemForm: document.getElementById("redeem-form"),
  redeemDestinationInput: document.getElementById("redeem-destination-input"),
  redeemAmountInput: document.getElementById("redeem-amount-input"),
  redeemFeeInput: document.getElementById("redeem-fee-input"),
  approveRedeemButton: document.getElementById("approve-redeem-button"),
  createRedeemButton: document.getElementById("create-redeem-button"),
  ticketState: document.getElementById("ticket-state"),
  depositTicket: document.getElementById("deposit-ticket"),
  depositsTab: document.getElementById("deposits-tab"),
  redeemsTab: document.getElementById("redeems-tab"),
  activityList: document.getElementById("activity-list")
};

function numberFormat(value) {
  if (value === null || value === undefined || value === "") {
    return "...";
  }
  if (/^(0|[1-9][0-9]*)$/.test(String(value))) {
    return BigInt(value).toLocaleString("en-US");
  }
  return new Intl.NumberFormat("en-US").format(Number(value));
}

function formatSats(value) {
  return `${numberFormat(value)} sats`;
}

function isNoCapLimit(value) {
  if (value === null || value === undefined || value === "") {
    return false;
  }
  const raw = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    return false;
  }
  return raw === "0" || BigInt(raw) >= UINT64_MAX;
}

function formatCapSats(value) {
  return isNoCapLimit(value) ? "No cap" : formatSats(value);
}

function formatDepositRange(minSats, maxSats) {
  return isNoCapLimit(maxSats) ? `From ${formatSats(minSats)}, no cap` : `${formatSats(minSats)} to ${formatSats(maxSats)}`;
}

function formatRedeemRange(maxRedeemSats, maxMinerFeeSats) {
  const redeemText = isNoCapLimit(maxRedeemSats) ? "No redeem cap" : `Up to ${formatSats(maxRedeemSats)}`;
  const feeText = isNoCapLimit(maxMinerFeeSats) ? "fee below amount" : `fee ${formatSats(maxMinerFeeSats)}`;
  return `${redeemText}, ${feeText}`;
}

function setOptionalMax(input, value) {
  if (isNoCapLimit(value)) {
    input.removeAttribute("max");
    return;
  }
  input.max = value;
}

function exceedsCap(value, cap) {
  return !isNoCapLimit(cap) && value > BigInt(cap);
}

function requireUint64(value, label) {
  if (value > UINT64_MAX) {
    throw new Error(`${label} must fit in uint64 sats.`);
  }
}

function shortHex(value) {
  if (!value || typeof value !== "string") {
    return "";
  }
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function statusText(value) {
  const labels = {
    awaiting_bitcoin_deposit: "awaiting BTC deposit",
    bitcoin_deposit_observed: "BTC deposit observed",
    external_authorization_requested: "external authorization requested",
    mint_confirmed: "mint confirmed",
    burn_observed: "burn observed",
    release_plan_prepared: "release plan prepared",
    evm_completion_submitted: "EVM completion submitted",
    evm_completion_confirmed: "EVM completion confirmed",
    bitcoin_broadcast_retrying: "Bitcoin broadcast retrying",
    bitcoin_broadcast: "Bitcoin broadcast",
    operator_review_required: "operator review required",
    "burn submitted": "burn submitted"
  };
  const normalized = String(value || "unknown");
  return labels[normalized] || normalized.replaceAll("_", " ");
}

function sepoliaTxUrl(hash) {
  return `https://sepolia.etherscan.io/tx/${encodeURIComponent(hash)}`;
}

function sepoliaAddressUrl(address) {
  return `https://sepolia.etherscan.io/address/${encodeURIComponent(address)}`;
}

function signetTxUrl(txid) {
  return `https://mempool.space/signet/tx/${encodeURIComponent(txid)}`;
}

function signetAddressUrl(address) {
  return `https://mempool.space/signet/address/${encodeURIComponent(address)}`;
}

function linkFor(label, value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  if (label === "Intent tx" || label === "Mint tx" || label === "Burn tx" || label === "Complete tx" || label === "Release request") {
    return sepoliaTxUrl(value);
  }
  if (label === "Recipient" || label === "Requester") {
    return sepoliaAddressUrl(value);
  }
  if (label === "BTC tx" || label === "BTC release") {
    return signetTxUrl(value);
  }
  if (label === "Deposit address" || label === "BTC destination") {
    return signetAddressUrl(value);
  }
  return null;
}

function setNotice(message, kind = "error") {
  if (!message) {
    elements.notice.hidden = true;
    elements.notice.textContent = "";
    elements.notice.className = "notice";
    return;
  }
  elements.notice.hidden = false;
  elements.notice.className = `notice is-${kind}`;
  elements.notice.textContent = message;
}

function errorMessage(error) {
  if (error && error.code === 4001) {
    return "Wallet request rejected.";
  }
  return error && error.message ? error.message : String(error);
}

async function fetchJson(path, options) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error && json.error.message ? json.error.message : `Request failed with ${response.status}`);
  }
  return json;
}

async function refreshAll() {
  elements.refreshButton.disabled = true;
  try {
    const [status, deposits, redeems] = await Promise.all([
      fetchJson("/status"),
      fetchJson("/deposits?limit=20"),
      fetchJson("/redeems?limit=20")
    ]);
    appState.status = status;
    appState.deposits = deposits.deposits || [];
    appState.redeems = redeems.redeems || [];
    await refreshWalletState({ silent: true });
    setNotice("");
    render();
  } catch (error) {
    elements.servicePill.textContent = "Degraded";
    elements.servicePill.className = "service-pill is-error";
    setNotice(errorMessage(error));
  } finally {
    elements.refreshButton.disabled = false;
  }
}

async function createDeposit(event) {
  event.preventDefault();
  if (appState.busy) {
    return;
  }

  const recipient0x = elements.recipientInput.value.trim();
  const expectedSats = elements.amountInput.value.trim();
  const limits = appState.status && appState.status.limits;

  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient0x)) {
    setNotice("Sepolia recipient must be a 0x address.");
    elements.recipientInput.focus();
    return;
  }
  if (!isWholeNumber(expectedSats)) {
    setNotice("Amount must be a whole number of sats.");
    elements.amountInput.focus();
    return;
  }
  if (limits) {
    const sats = BigInt(expectedSats);
    if (sats < BigInt(limits.minDepositSats)) {
      setNotice(`Amount must be at least ${limits.minDepositSats} sats.`);
      elements.amountInput.focus();
      return;
    }
    if (exceedsCap(sats, limits.maxDepositSats)) {
      setNotice(`Amount must be at most ${limits.maxDepositSats} sats.`);
      elements.amountInput.focus();
      return;
    }
    try {
      requireUint64(sats, "Amount");
    } catch (error) {
      setNotice(errorMessage(error));
      elements.amountInput.focus();
      return;
    }
  }

  appState.busy = true;
  elements.createDepositButton.disabled = true;
  elements.createDepositButton.textContent = "Creating...";

  try {
    const result = await fetchJson("/deposits", {
      method: "POST",
      body: JSON.stringify({ recipient0x, expectedSats })
    });
    appState.latestDeposit = result.deposit;
    appState.latestTicketType = "deposit";
    sessionStorage.setItem("latestDeposit", JSON.stringify(result.deposit));
    sessionStorage.setItem("latestTicketType", "deposit");
    setNotice("");
    await refreshAll();
    renderActionTicket();
  } catch (error) {
    setNotice(errorMessage(error));
  } finally {
    appState.busy = false;
    elements.createDepositButton.disabled = false;
    elements.createDepositButton.textContent = "Create deposit";
  }
}

function render() {
  renderStatus();
  renderWallet();
  renderActionTicket();
  renderActivity();
}

function renderStatus() {
  const status = appState.status;
  if (!status) {
    return;
  }
  elements.servicePill.textContent = status.ok ? "Live" : "Degraded";
  elements.servicePill.className = status.ok ? "service-pill is-ok" : "service-pill is-error";
  elements.bitcoinBlock.textContent = numberFormat(status.chain && status.chain.bitcoinBlock);
  elements.evmBlock.textContent = numberFormat(status.chain && status.chain.evmBlock);
  elements.tokenSupply.textContent = formatSats(status.token && status.token.totalSupplySats);
  if (status.relayer && status.relayer.fundingStatus) {
    elements.relayerEth.textContent = `${statusText(status.relayer.fundingStatus)} (${status.relayer.balanceBucketEth || "unknown"} ETH)`;
  } else {
    elements.relayerEth.textContent = "...";
  }

  const limits = status.limits;
  if (limits) {
    elements.depositLimits.textContent = formatDepositRange(limits.minDepositSats, limits.maxDepositSats);
    elements.redeemLimits.textContent = formatRedeemRange(limits.maxRedeemSats, limits.maxRedeemMinerFeeSats);
    elements.depositCap.textContent = formatCapSats(limits.maxDepositSats);
    elements.redeemCap.textContent = formatCapSats(limits.maxRedeemSats);
    elements.feeBudget.textContent = formatCapSats(limits.maxRedeemMinerFeeSats);
    elements.minConfirmations.textContent = numberFormat(limits.minConfirmations);
    elements.amountInput.min = limits.minDepositSats;
    setOptionalMax(elements.amountInput, limits.maxDepositSats);
    setOptionalMax(elements.redeemAmountInput, limits.maxRedeemSats);
    setOptionalMax(elements.redeemFeeInput, limits.maxRedeemMinerFeeSats);
    if (!elements.amountInput.value) {
      elements.amountInput.value = limits.minDepositSats;
    }
    if (!elements.redeemAmountInput.value) {
      elements.redeemAmountInput.value = limits.minDepositSats;
    }
    if (!elements.redeemFeeInput.value) {
      elements.redeemFeeInput.value = String(Math.min(500, Number(limits.maxRedeemMinerFeeSats)));
    }
  }

  const contracts = status.contracts || {};
  elements.wrappedBitcoinContract.textContent = shortHex(contracts.wrappedBitcoin);
  elements.mintGatewayContract.textContent = shortHex(contracts.mintGateway);
  elements.burnGatewayContract.textContent = shortHex(contracts.burnGateway);
  elements.chainlinkVerifierContract.textContent = shortHex(contracts.chainlinkVerifier);
}

function renderWallet() {
  const wallet = appState.wallet;
  const connected = Boolean(wallet.account);
  elements.connectWalletButton.textContent = connected ? shortHex(wallet.account) : "Connect";
  elements.walletAddress.textContent = connected ? shortHex(wallet.account) : "No wallet";
  elements.walletBalance.textContent = connected && wallet.balanceSats !== null
    ? `${formatSats(wallet.balanceSats)} bbBTC`
    : "...";

  const disabled = appState.walletBusy || appState.busy;
  elements.approveRedeemButton.disabled = disabled || !connected;
  elements.createRedeemButton.disabled = disabled || !connected;
}

function renderActionTicket() {
  const ticketType = appState.latestTicketType || sessionStorage.getItem("latestTicketType");
  if (ticketType === "redeem") {
    renderRedeemTicket(appState.latestRedeem);
    return;
  }
  renderDepositTicket(appState.latestDeposit);
}

function renderDepositTicket(deposit) {
  if (!deposit) {
    const stored = sessionStorage.getItem("latestDeposit");
    if (stored) {
      try {
        deposit = JSON.parse(stored);
        appState.latestDeposit = deposit;
      } catch {
        sessionStorage.removeItem("latestDeposit");
      }
    }
  }

  if (!deposit) {
    renderEmptyTicket();
    return;
  }

  elements.ticketState.textContent = statusText(deposit.status);
  elements.depositTicket.className = "ticket";
  elements.depositTicket.innerHTML = [
    ticketRow("Deposit address", deposit.depositAddress, true),
    ticketRow("Expected amount", formatSats(deposit.expectedSats), false),
    ticketRow("Deposit id", deposit.depositId, true),
    ticketRow("Intent tx", deposit.createIntentTxHash, true),
    ticketRow("Expires", formatTime(deposit.expiry), false)
  ].join("");
}

function renderRedeemTicket(redeem) {
  if (!redeem) {
    const stored = sessionStorage.getItem("latestRedeem");
    if (stored) {
      try {
        redeem = JSON.parse(stored);
        appState.latestRedeem = redeem;
      } catch {
        sessionStorage.removeItem("latestRedeem");
      }
    }
  }

  if (!redeem) {
    renderEmptyTicket();
    return;
  }

  elements.ticketState.textContent = redeem.status || "redeem submitted";
  elements.depositTicket.className = "ticket";
  elements.depositTicket.innerHTML = [
    ticketRow("BTC destination", redeem.destinationAddress, true),
    ticketRow("Expected amount", formatSats(redeem.amountSats), false),
    ticketRow("Max miner fee", formatSats(redeem.maxMinerFeeSats), false),
    ticketRow("Burn tx", redeem.burnTxHash, true),
    ticketRow("Status", "Watch the Redeems tab after Sepolia finality", false)
  ].join("");
}

function renderEmptyTicket() {
  elements.ticketState.textContent = "No active ticket";
  elements.depositTicket.className = "ticket-empty";
  elements.depositTicket.innerHTML = `
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <rect x="16" y="20" width="88" height="80" rx="8"></rect>
      <path d="M34 40h52M34 58h52M34 76h32"></path>
    </svg>
  `;
}

function ticketRow(label, value, copyable) {
  const safeValue = escapeHtml(value || "");
  const href = linkFor(label, value);
  return `
    <div class="ticket-row">
      <span class="ticket-label">${escapeHtml(label)}</span>
      <strong class="mono">${safeValue}</strong>
      <span class="row-actions">
        ${copyable ? `<button class="copy-button" type="button" data-copy="${safeValue}">Copy</button>` : ""}
        ${href ? `<a class="open-button" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">Open</a>` : ""}
      </span>
    </div>
  `;
}

function renderActivity() {
  elements.depositsTab.classList.toggle("is-active", appState.selectedTab === "deposits");
  elements.redeemsTab.classList.toggle("is-active", appState.selectedTab === "redeems");
  elements.depositsTab.setAttribute("aria-selected", appState.selectedTab === "deposits" ? "true" : "false");
  elements.redeemsTab.setAttribute("aria-selected", appState.selectedTab === "redeems" ? "true" : "false");

  const items = appState.selectedTab === "deposits" ? appState.deposits : appState.redeems;
  if (!items.length) {
    elements.activityList.innerHTML = `<div class="empty-state">No ${appState.selectedTab} yet.</div>`;
    return;
  }

  elements.activityList.innerHTML = items.map((item) => {
    if (appState.selectedTab === "deposits") {
      return renderDepositItem(item);
    }
    return renderRedeemItem(item);
  }).join("");
}

function renderDepositItem(deposit) {
  return `
    <article class="activity-item">
      <div class="item-head">
        <strong>${escapeHtml(shortHex(deposit.depositId))}</strong>
        ${badge(deposit.status)}
      </div>
      ${itemRow("Amount", formatSats(deposit.expectedSats))}
      ${itemRow("Recipient", deposit.recipient, true)}
      ${itemRow("Deposit address", deposit.depositAddress, true)}
      ${deposit.btcTxId ? itemRow("BTC tx", deposit.btcTxId, true) : ""}
      ${deposit.mintTxHash ? itemRow("Mint tx", deposit.mintTxHash, true) : ""}
      ${deposit.errorCategory ? itemRow("Error", statusText(deposit.errorCategory)) : ""}
    </article>
  `;
}

function renderRedeemItem(redeem) {
  return `
    <article class="activity-item">
      <div class="item-head">
        <strong>${escapeHtml(shortHex(redeem.redeemRequestHash))}</strong>
        ${badge(redeem.status)}
      </div>
      ${itemRow("Amount", formatSats(redeem.amountSats))}
      ${itemRow("Requester", redeem.requester, true)}
      ${redeem.txHash ? itemRow("Burn tx", redeem.txHash, true) : ""}
      ${redeem.releaseRequestTxHash ? itemRow("Release request", redeem.releaseRequestTxHash, true) : ""}
      ${redeem.completeRedeemTxHash ? itemRow("Complete tx", redeem.completeRedeemTxHash, true) : ""}
      ${redeem.bitcoinTxId ? itemRow("BTC release", redeem.bitcoinTxId, true) : ""}
      ${redeem.errorCategory ? itemRow("Error", statusText(redeem.errorCategory)) : ""}
    </article>
  `;
}

function itemRow(label, value, copyable) {
  const safeValue = escapeHtml(value || "");
  const href = linkFor(label, value);
  return `
    <div class="item-row">
      <span class="item-label">${escapeHtml(label)}</span>
      <strong class="mono">${safeValue}</strong>
      <span class="row-actions">
        ${copyable ? `<button class="copy-button" type="button" data-copy="${safeValue}">Copy</button>` : ""}
        ${href ? `<a class="open-button" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">Open</a>` : ""}
      </span>
    </div>
  `;
}

function badge(status) {
  const normalized = String(status || "unknown");
  return `<span class="badge is-${escapeHtml(normalized)}">${escapeHtml(statusText(normalized))}</span>`;
}

function formatTime(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return "...";
  }
  return new Date(seconds * 1000).toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isWholeNumber(value) {
  return /^(0|[1-9][0-9]*)$/.test(String(value));
}

async function copyText(value, button) {
  await navigator.clipboard.writeText(value);
  const original = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = original;
  }, 1000);
}

function ethereumProvider() {
  if (!window.ethereum || typeof window.ethereum.request !== "function") {
    throw new Error("Install a browser wallet such as MetaMask to redeem bbBTC.");
  }
  return window.ethereum;
}

async function walletRequest(method, params = []) {
  return ethereumProvider().request({ method, params });
}

async function connectWallet() {
  appState.walletBusy = true;
  renderWallet();
  try {
    const accounts = await walletRequest("eth_requestAccounts");
    appState.wallet.account = accounts && accounts[0] ? accounts[0] : null;
    appState.wallet.chainId = await walletRequest("eth_chainId");
    await ensureSepolia();
    await refreshWalletState();
    setNotice("");
  } catch (error) {
    setNotice(errorMessage(error));
  } finally {
    appState.walletBusy = false;
    renderWallet();
  }
}

async function ensureSepolia() {
  const chainId = await walletRequest("eth_chainId");
  appState.wallet.chainId = chainId;
  if (String(chainId).toLowerCase() === SEPOLIA_CHAIN_ID) {
    return;
  }

  try {
    await walletRequest("wallet_switchEthereumChain", [{ chainId: SEPOLIA_CHAIN_ID }]);
  } catch (error) {
    if (error && error.code === 4902) {
      await walletRequest("wallet_addEthereumChain", [{
        chainId: SEPOLIA_CHAIN_ID,
        chainName: "Sepolia",
        nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
        rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
        blockExplorerUrls: ["https://sepolia.etherscan.io"]
      }]);
    } else {
      throw error;
    }
  }
  appState.wallet.chainId = await walletRequest("eth_chainId");
}

async function refreshWalletState({ silent = false } = {}) {
  if (!appState.wallet.account || !appState.status || !window.ethereum) {
    return;
  }
  try {
    const contracts = appState.status.contracts || {};
    const [balanceHex, allowanceHex, chainId] = await Promise.all([
      ethCall(contracts.wrappedBitcoin, encodeBalanceOf(appState.wallet.account)),
      ethCall(contracts.wrappedBitcoin, encodeAllowance(appState.wallet.account, contracts.burnGateway)),
      walletRequest("eth_chainId")
    ]);
    appState.wallet.chainId = chainId;
    appState.wallet.balanceSats = hexToBigInt(balanceHex).toString();
    appState.wallet.allowanceSats = hexToBigInt(allowanceHex).toString();
  } catch (error) {
    appState.wallet.balanceSats = null;
    appState.wallet.allowanceSats = null;
    if (!silent) {
      setNotice(errorMessage(error));
    }
  }
}

async function ethCall(to, data) {
  if (!to) {
    throw new Error("Contract address is not loaded yet.");
  }
  return walletRequest("eth_call", [{ to, data }, "latest"]);
}

async function approveRedeem(event) {
  if (event) {
    event.preventDefault();
  }
  try {
    const amountSats = redeemAmountValue();
    validateRedeemAmount(amountSats);
    await ensureRedeemWallet();
    await approveRedeemAmount(amountSats);
  } catch (error) {
    setNotice(errorMessage(error));
  }
}

async function approveRedeemAmount(amountSats) {
  appState.walletBusy = true;
  elements.approveRedeemButton.textContent = "Approving...";
  renderWallet();
  try {
    const contracts = appState.status.contracts || {};
    const txHash = await walletRequest("eth_sendTransaction", [{
      from: appState.wallet.account,
      to: contracts.wrappedBitcoin,
      data: encodeApprove(contracts.burnGateway, amountSats),
      value: "0x0"
    }]);
    setNotice(`Approve submitted: ${shortHex(txHash)}`, "info");
    await waitForReceipt(txHash);
    await refreshWalletState();
    setNotice("bbBTC approved for redeem.", "success");
  } finally {
    appState.walletBusy = false;
    elements.approveRedeemButton.textContent = "Approve";
    renderWallet();
  }
}

async function createRedeem(event) {
  event.preventDefault();
  if (appState.busy || appState.walletBusy) {
    return;
  }

  let values;
  try {
    values = redeemFormValues();
    await ensureRedeemWallet();
    validateRedeem(values);
  } catch (error) {
    setNotice(errorMessage(error));
    return;
  }

  appState.busy = true;
  elements.createRedeemButton.disabled = true;
  elements.createRedeemButton.textContent = "Redeeming...";
  renderWallet();

  try {
    await refreshWalletState();
    if (BigInt(appState.wallet.allowanceSats || "0") < values.amountSats) {
      await approveRedeemAmount(values.amountSats);
    }

    const contracts = appState.status.contracts || {};
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 24 * 60 * 60);
    const txHash = await walletRequest("eth_sendTransaction", [{
      from: appState.wallet.account,
      to: contracts.burnGateway,
      data: encodeBurn(values.destinationScript, values.amountSats, values.maxMinerFeeSats, deadline),
      value: "0x0"
    }]);

    const latestRedeem = {
      status: "burn submitted",
      destinationAddress: values.destinationAddress,
      amountSats: values.amountSats.toString(),
      maxMinerFeeSats: values.maxMinerFeeSats.toString(),
      burnTxHash: txHash
    };
    appState.latestRedeem = latestRedeem;
    appState.latestTicketType = "redeem";
    appState.selectedTab = "redeems";
    sessionStorage.setItem("latestRedeem", JSON.stringify(latestRedeem));
    sessionStorage.setItem("latestTicketType", "redeem");
    render();
    setNotice(`Redeem burn submitted: ${shortHex(txHash)}`, "info");
    await waitForReceipt(txHash);
    await refreshAll();
    setNotice("Redeem burn confirmed. The worker will pick it up after Sepolia finality.", "success");
  } catch (error) {
    setNotice(errorMessage(error));
  } finally {
    appState.busy = false;
    elements.createRedeemButton.disabled = false;
    elements.createRedeemButton.textContent = "Redeem";
    renderWallet();
  }
}

function redeemFormValues() {
  const destinationAddress = elements.redeemDestinationInput.value.trim();
  const amountSats = redeemAmountValue();
  const feeText = elements.redeemFeeInput.value.trim();
  if (!isWholeNumber(feeText) || BigInt(feeText) === 0n) {
    elements.redeemFeeInput.focus();
    throw new Error("Max miner fee must be a whole number of sats.");
  }
  return {
    destinationAddress,
    destinationScript: signetAddressToScriptPubKey(destinationAddress),
    amountSats,
    maxMinerFeeSats: BigInt(feeText)
  };
}

function redeemAmountValue() {
  const amountText = elements.redeemAmountInput.value.trim();
  if (!isWholeNumber(amountText) || BigInt(amountText) === 0n) {
    elements.redeemAmountInput.focus();
    throw new Error("Redeem amount must be a whole number of sats.");
  }
  return BigInt(amountText);
}

function validateRedeemAmount(amountSats) {
  const limits = appState.status && appState.status.limits;
  if (!limits) {
    throw new Error("Live limits are not loaded yet.");
  }
  requireUint64(amountSats, "Redeem amount");
  if (exceedsCap(amountSats, limits.maxRedeemSats)) {
    throw new Error(`Redeem amount must be at most ${limits.maxRedeemSats} sats.`);
  }
}

function validateRedeem({ amountSats, maxMinerFeeSats }) {
  const limits = appState.status && appState.status.limits;
  validateRedeemAmount(amountSats);
  requireUint64(maxMinerFeeSats, "Max miner fee");
  if (exceedsCap(maxMinerFeeSats, limits.maxRedeemMinerFeeSats)) {
    throw new Error(`Max miner fee must be at most ${limits.maxRedeemMinerFeeSats} sats.`);
  }
  if (maxMinerFeeSats >= amountSats) {
    throw new Error("Max miner fee must be lower than the redeem amount.");
  }
  if (BigInt(appState.wallet.balanceSats || "0") < amountSats) {
    throw new Error("Wallet does not have enough bbBTC.");
  }
}

async function ensureRedeemWallet() {
  if (!appState.wallet.account) {
    await connectWallet();
  }
  if (!appState.wallet.account) {
    throw new Error("Connect a Sepolia wallet first.");
  }
  await ensureSepolia();
}

async function waitForReceipt(txHash) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const receipt = await walletRequest("eth_getTransactionReceipt", [txHash]);
    if (receipt) {
      if (receipt.status && receipt.status !== "0x1") {
        throw new Error(`Transaction reverted: ${txHash}`);
      }
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for transaction: ${txHash}`);
}

function cleanHex(value) {
  return String(value || "").replace(/^0x/i, "").toLowerCase();
}

function pad64(hex) {
  const clean = cleanHex(hex);
  if (clean.length > 64) {
    throw new Error("ABI value is too large.");
  }
  return clean.padStart(64, "0");
}

function padAddress(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) {
    throw new Error("Invalid EVM address.");
  }
  return pad64(cleanHex(address));
}

function uintHex(value) {
  const big = BigInt(value);
  if (big < 0n) {
    throw new Error("Negative ABI integer.");
  }
  return pad64(big.toString(16));
}

function encodeBalanceOf(account) {
  return FUNCTION_SELECTORS.balanceOf + padAddress(account);
}

function encodeAllowance(owner, spender) {
  return FUNCTION_SELECTORS.allowance + padAddress(owner) + padAddress(spender);
}

function encodeApprove(spender, amount) {
  return FUNCTION_SELECTORS.approve + padAddress(spender) + uintHex(amount);
}

function encodeBurn(destinationScript, amountSats, maxMinerFeeSats, deadline) {
  const script = cleanHex(destinationScript);
  if (!script || script.length % 2 !== 0) {
    throw new Error("Invalid BTC destination script.");
  }
  const byteLength = script.length / 2;
  const paddedScript = script.padEnd(Math.ceil(script.length / 64) * 64, "0");
  return [
    FUNCTION_SELECTORS.burn,
    uintHex(128),
    uintHex(amountSats),
    uintHex(maxMinerFeeSats),
    uintHex(deadline),
    uintHex(byteLength),
    paddedScript
  ].join("");
}

function hexToBigInt(value) {
  const clean = cleanHex(value || "0x0") || "0";
  return BigInt(`0x${clean}`);
}

function signetAddressToScriptPubKey(address) {
  const decoded = decodeSegwitAddress(address);
  if (decoded.hrp !== "tb") {
    throw new Error("Use a Bitcoin signet address starting with tb1.");
  }
  if (decoded.version === 0 && decoded.program.length !== 20 && decoded.program.length !== 32) {
    throw new Error("Unsupported v0 signet witness program.");
  }
  if (decoded.version === 1 && decoded.program.length !== 32) {
    throw new Error("Unsupported taproot signet witness program.");
  }
  if (decoded.version > 1) {
    throw new Error("Use a P2WPKH, P2WSH, or P2TR signet address.");
  }
  const opcode = decoded.version === 0 ? 0 : 0x50 + decoded.version;
  return bytesToHex([opcode, decoded.program.length, ...decoded.program]);
}

function decodeSegwitAddress(address) {
  const decoded = decodeBech32(address);
  if (!decoded.data.length) {
    throw new Error("Invalid signet address.");
  }
  const version = decoded.data[0];
  const program = convertBits(decoded.data.slice(1), 5, 8, false);
  if (version === 0 && decoded.encoding !== "bech32") {
    throw new Error("Invalid v0 signet checksum.");
  }
  if (version > 0 && decoded.encoding !== "bech32m") {
    throw new Error("Invalid signet checksum.");
  }
  return { hrp: decoded.hrp, version, program };
}

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function decodeBech32(value) {
  const address = String(value || "");
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) {
    throw new Error("Signet address cannot mix letter case.");
  }
  const normalized = address.toLowerCase();
  const separator = normalized.lastIndexOf("1");
  if (separator < 1 || separator + 7 > normalized.length) {
    throw new Error("Invalid signet address.");
  }
  const hrp = normalized.slice(0, separator);
  const chars = normalized.slice(separator + 1);
  const data = [];
  for (const char of chars) {
    const index = BECH32_CHARSET.indexOf(char);
    if (index === -1) {
      throw new Error("Invalid signet address character.");
    }
    data.push(index);
  }
  const checksum = bech32Polymod([...bech32HrpExpand(hrp), ...data]);
  const encoding = checksum === 1 ? "bech32" : checksum === 0x2bc830a3 ? "bech32m" : null;
  if (!encoding) {
    throw new Error("Invalid signet address checksum.");
  }
  return { hrp, data: data.slice(0, -6), encoding };
}

function bech32HrpExpand(hrp) {
  const values = [];
  for (let i = 0; i < hrp.length; i += 1) {
    values.push(hrp.charCodeAt(i) >> 5);
  }
  values.push(0);
  for (let i = 0; i < hrp.length; i += 1) {
    values.push(hrp.charCodeAt(i) & 31);
  }
  return values;
}

function bech32Polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = (chk & 0x1ffffff) << 5 ^ value;
    for (let i = 0; i < 5; i += 1) {
      if ((top >> i) & 1) {
        chk ^= generators[i];
      }
    }
  }
  return chk;
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0;
  let bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  const maxAcc = (1 << (fromBits + toBits - 1)) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) {
      throw new Error("Invalid signet address data.");
    }
    acc = ((acc << fromBits) | value) & maxAcc;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) {
      ret.push((acc << (toBits - bits)) & maxv);
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    throw new Error("Invalid signet address padding.");
  }
  return ret;
}

function bytesToHex(bytes) {
  return `0x${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

document.addEventListener("click", (event) => {
  const copyButton = event.target.closest("[data-copy]");
  if (copyButton) {
    copyText(copyButton.dataset.copy, copyButton).catch((error) => setNotice(errorMessage(error)));
    return;
  }

  const quickAmount = event.target.closest("[data-sats]");
  if (quickAmount) {
    elements.amountInput.value = quickAmount.dataset.sats;
    return;
  }

  const redeemQuickAmount = event.target.closest("[data-redeem-sats]");
  if (redeemQuickAmount) {
    elements.redeemAmountInput.value = redeemQuickAmount.dataset.redeemSats;
    return;
  }

  const contractRow = event.target.closest("[data-contract]");
  if (contractRow && appState.status && appState.status.contracts) {
    const address = appState.status.contracts[contractRow.dataset.contract];
    if (address) {
      window.open(sepoliaAddressUrl(address), "_blank", "noreferrer");
    }
  }
});

elements.refreshButton.addEventListener("click", refreshAll);
elements.connectWalletButton.addEventListener("click", connectWallet);
elements.depositForm.addEventListener("submit", createDeposit);
elements.approveRedeemButton.addEventListener("click", approveRedeem);
elements.redeemForm.addEventListener("submit", createRedeem);
elements.depositsTab.addEventListener("click", () => {
  appState.selectedTab = "deposits";
  renderActivity();
});
elements.redeemsTab.addEventListener("click", () => {
  appState.selectedTab = "redeems";
  renderActivity();
});

if (window.ethereum && typeof window.ethereum.on === "function") {
  window.ethereum.on("accountsChanged", async (accounts) => {
    appState.wallet.account = accounts && accounts[0] ? accounts[0] : null;
    await refreshWalletState({ silent: true });
    render();
  });
  window.ethereum.on("chainChanged", async (chainId) => {
    appState.wallet.chainId = chainId;
    await refreshWalletState({ silent: true });
    render();
  });
}

refreshAll();
setInterval(refreshAll, 15000);
