const SESSION_KEY = "party-money-keeper-session";
const POLL_INTERVAL_MS = 3000;
const GAME_NAME = "大富翁";

const ui = {
  authScreen: document.getElementById("auth-screen"),
  dashboardScreen: document.getElementById("dashboard-screen"),
  authMessage: document.getElementById("auth-message"),
  bankMessage: document.getElementById("bank-message"),
  adminMessage: document.getElementById("admin-message"),
  roomTitle: document.getElementById("room-title"),
  roomMeta: document.getElementById("room-meta"),
  myBalance: document.getElementById("my-balance"),
  myRank: document.getElementById("my-rank"),
  bankAdminName: document.getElementById("bank-admin-name"),
  playerCount: document.getElementById("player-count"),
  playersList: document.getElementById("players-list"),
  transactionsList: document.getElementById("transactions-list"),
  syncStatus: document.getElementById("sync-status"),
  bankTarget: document.getElementById("bank-target"),
  bankPanel: document.getElementById("bank-panel"),
  adminPanel: document.getElementById("admin-panel"),
  bankAdminSelect: document.getElementById("bank-admin-select"),
  copyCodeBtn: document.getElementById("copy-code-btn"),
  leaveRoomBtn: document.getElementById("leave-room-btn"),
  monopolyGameBtn: document.getElementById("monopoly-game-btn"),
  gameForms: document.getElementById("game-forms"),
  transferModal: document.getElementById("transfer-modal"),
  transferTargetName: document.getElementById("transfer-target-name"),
  transferPlayerId: document.getElementById("transfer-player-id"),
  transferAmount: document.getElementById("transfer-amount"),
  transferMessage: document.getElementById("transfer-message"),
  closeTransferBtn: document.getElementById("close-transfer-btn"),
  cancelTransferBtn: document.getElementById("cancel-transfer-btn"),
};

const forms = {
  create: document.getElementById("create-form"),
  join: document.getElementById("join-form"),
  transfer: document.getElementById("transfer-form"),
  bankTransfer: document.getElementById("bank-transfer-form"),
  bankAdmin: document.getElementById("bank-admin-form"),
};

let session = loadSession();
let currentState = null;
let pollTimer = null;

forms.create.addEventListener("submit", handleCreateRoom);
forms.join.addEventListener("submit", handleJoinRoom);
forms.transfer.addEventListener("submit", handlePlayerTransfer);
forms.bankTransfer.addEventListener("submit", handleBankTransfer);
forms.bankAdmin.addEventListener("submit", handleAssignBankAdmin);
ui.copyCodeBtn.addEventListener("click", handleCopyRoomCode);
ui.leaveRoomBtn.addEventListener("click", handleLeaveRoom);
ui.monopolyGameBtn.addEventListener("click", activateMonopolyGame);
ui.playersList.addEventListener("click", handlePlayerCardClick);
ui.closeTransferBtn.addEventListener("click", closeTransferModal);
ui.cancelTransferBtn.addEventListener("click", closeTransferModal);
ui.transferModal.addEventListener("click", handleBackdropClick);

boot();

async function boot() {
  activateMonopolyGame();

  if (!session) {
    showAuth();
    return;
  }

  try {
    await fetchState({ showSyncPulse: false });
  } catch (_error) {
    clearSession();
    showAuth("登录状态已失效，请重新进入房间。", "error");
  }
}

function activateMonopolyGame() {
  ui.monopolyGameBtn.classList.add("is-active");
  ui.gameForms.classList.remove("hidden");
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_error) {
    return null;
  }
}

function saveSession(nextSession) {
  session = nextSession;
  localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
}

function clearSession() {
  session = null;
  currentState = null;
  localStorage.removeItem(SESSION_KEY);
  stopPolling();
}

function showAuth(message = "", tone = "") {
  activateMonopolyGame();
  ui.authScreen.classList.remove("hidden");
  ui.dashboardScreen.classList.add("hidden");
  closeTransferModal();
  setMessage(ui.authMessage, message, tone);
}

function showDashboard() {
  ui.authScreen.classList.add("hidden");
  ui.dashboardScreen.classList.remove("hidden");
}

function setMessage(element, message, tone = "") {
  element.textContent = message;
  element.className = `inline-message${tone ? ` ${tone}` : ""}`;
}

function formatMoney(amount) {
  return Number(amount || 0).toLocaleString("zh-CN");
}

function formatDateTime(isoText) {
  if (!isoText) return "-";
  const date = new Date(isoText);
  if (Number.isNaN(date.getTime())) return isoText;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    month: "numeric",
    day: "numeric",
  }).format(date);
}

function api(path, options = {}) {
  return fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "请求失败。");
    }
    return data;
  });
}

async function handleCreateRoom(event) {
  event.preventDefault();
  activateMonopolyGame();
  const formData = new FormData(forms.create);
  setMessage(ui.authMessage, "正在创建房间...", "");

  try {
    const result = await api("/api/rooms/create", {
      method: "POST",
      body: JSON.stringify({
        roomName: GAME_NAME,
        playerName: formData.get("playerName"),
        startingBalance: formData.get("startingBalance"),
      }),
    });
    saveSession(result.session);
    renderState(result.state);
    showDashboard();
    startPolling();
  } catch (error) {
    showAuth(error.message, "error");
  }
}

async function handleJoinRoom(event) {
  event.preventDefault();
  activateMonopolyGame();
  const formData = new FormData(forms.join);
  setMessage(ui.authMessage, "正在加入房间...", "");

  try {
    const result = await api("/api/rooms/join", {
      method: "POST",
      body: JSON.stringify({
        roomCode: String(formData.get("roomCode") || "").trim(),
        playerName: formData.get("playerName"),
      }),
    });
    saveSession(result.session);
    renderState(result.state);
    showDashboard();
    startPolling();
  } catch (error) {
    showAuth(error.message, "error");
  }
}

async function fetchState({ showSyncPulse = true } = {}) {
  if (!session) return;
  const query = new URLSearchParams({
    playerId: String(session.playerId),
    token: session.token,
  });
  const result = await api(`/api/rooms/${session.roomCode}/state?${query.toString()}`);
  renderState(result.state);
  showDashboard();
  if (showSyncPulse) {
    ui.syncStatus.textContent = `已同步 ${formatDateTime(result.state.serverTime)}`;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(() => {
    fetchState().catch((error) => {
      ui.syncStatus.textContent = error.message;
    });
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function renderState(state) {
  currentState = state;
  const bankAdmin = state.players.find((player) => player.id === state.bankAdminPlayerId);
  const roles = [];
  if (state.me.isHost) roles.push("房主");
  if (state.me.isBankAdmin) roles.push("银行管理员");

  ui.roomTitle.textContent = state.room.name || GAME_NAME;
  ui.roomMeta.textContent = `房间码 ${state.room.code} · 我是 ${state.me.name}${roles.length ? ` · ${roles.join(" / ")}` : ""}`;
  ui.myBalance.textContent = formatMoney(state.me.balance);
  ui.myRank.textContent = `排名 #${state.me.rank}`;
  ui.playerCount.textContent = String(state.stats.playerCount);
  ui.bankAdminName.textContent = `银行管理员 ${bankAdmin ? bankAdmin.name : "-"}`;
  ui.syncStatus.textContent = `最近同步 ${formatDateTime(state.serverTime)}`;

  renderPlayers(state.players, state.me.id);
  renderSelectors(state.players, state.bankAdminPlayerId);
  renderTransactions(state.transactions);
  syncTransferModal(state.players);

  ui.bankPanel.classList.toggle("hidden", !state.me.isBankAdmin);
  ui.adminPanel.classList.toggle("hidden", !state.me.isHost);
}

function renderPlayers(players, meId) {
  if (!players.length) {
    ui.playersList.innerHTML = '<p class="empty-state">还没有玩家加入。</p>';
    return;
  }

  ui.playersList.innerHTML = players
    .map((player, index) => {
      const badges = [];
      if (player.isHost) badges.push('<span class="role-chip host">房主</span>');
      if (player.isBankAdmin) badges.push('<span class="role-chip">银行</span>');
      if (player.id === meId) {
        badges.push('<span class="role-chip">我</span>');
      } else {
        badges.push('<span class="role-chip action">点此转账</span>');
      }

      const classes = ["player-item"];
      if (player.id === meId) {
        classes.push("is-self");
      } else {
        classes.push("clickable");
      }

      return `
        <article class="${classes.join(" ")}" ${player.id === meId ? "" : `data-player-id="${player.id}"`}>
          <div class="player-row">
            <div class="player-left">
              <span class="rank-chip">#${index + 1}</span>
              <strong>${escapeHtml(player.name)}</strong>
              ${badges.join("")}
            </div>
            <span class="player-balance">${formatMoney(player.balance)}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderSelectors(players, bankAdminPlayerId) {
  const previousBankTarget = ui.bankTarget.value;
  const previousAdminTarget = ui.bankAdminSelect.value;
  const bankOptions = [];
  const adminOptions = [];

  players.forEach((player) => {
    bankOptions.push(`<option value="${player.id}">${escapeHtml(player.name)}</option>`);
    adminOptions.push(`<option value="${player.id}">${escapeHtml(player.name)}</option>`);
  });

  ui.bankTarget.innerHTML = bankOptions.join("");
  ui.bankAdminSelect.innerHTML = adminOptions.join("");

  restoreSelectValue(ui.bankTarget, previousBankTarget);
  restoreSelectValue(ui.bankAdminSelect, previousAdminTarget || String(bankAdminPlayerId));
}

function restoreSelectValue(selectElement, preferredValue) {
  if (!preferredValue) return;
  const exists = Array.from(selectElement.options).some((option) => option.value === preferredValue);
  if (exists) {
    selectElement.value = preferredValue;
  }
}

function renderTransactions(transactions) {
  if (!transactions.length) {
    ui.transactionsList.innerHTML = '<p class="empty-state">还没有交易，先来第一笔吧。</p>';
    return;
  }

  ui.transactionsList.innerHTML = transactions
    .map((tx) => {
      const noteText = tx.note ? ` · ${escapeHtml(tx.note)}` : "";
      return `
        <article class="tx-item">
          <div class="tx-top">
            <span class="tx-route">${escapeHtml(tx.fromLabel)} → ${escapeHtml(tx.toLabel)}</span>
            <span class="tx-amount">${formatMoney(tx.amount)}</span>
          </div>
          <div class="tx-meta">
            操作人 ${escapeHtml(tx.actorName)}${noteText} · ${formatDateTime(tx.createdAt)}
          </div>
        </article>
      `;
    })
    .join("");
}

function handlePlayerCardClick(event) {
  const card = event.target.closest("[data-player-id]");
  if (!card || !currentState) {
    return;
  }

  const targetId = Number(card.dataset.playerId);
  const player = currentState.players.find((item) => item.id === targetId);
  if (!player) {
    return;
  }

  openTransferModal(player);
}

function openTransferModal(player) {
  ui.transferTargetName.textContent = player.name;
  ui.transferPlayerId.value = String(player.id);
  ui.transferAmount.value = "";
  setMessage(ui.transferMessage, "");
  ui.transferModal.classList.remove("hidden");
  window.setTimeout(() => ui.transferAmount.focus(), 0);
}

function closeTransferModal() {
  ui.transferModal.classList.add("hidden");
  forms.transfer.reset();
  setMessage(ui.transferMessage, "");
}

function handleBackdropClick(event) {
  if (event.target === ui.transferModal) {
    closeTransferModal();
  }
}

function syncTransferModal(players) {
  if (ui.transferModal.classList.contains("hidden")) {
    return;
  }

  const targetId = Number(ui.transferPlayerId.value);
  const player = players.find((item) => item.id === targetId);
  if (!player) {
    closeTransferModal();
    return;
  }

  ui.transferTargetName.textContent = player.name;
}

async function handlePlayerTransfer(event) {
  event.preventDefault();
  if (!session) return;
  const formData = new FormData(forms.transfer);
  setMessage(ui.transferMessage, "提交中...", "");

  try {
    const result = await api(`/api/rooms/${session.roomCode}/transfer`, {
      method: "POST",
      body: JSON.stringify({
        playerId: session.playerId,
        token: session.token,
        fromKind: "player",
        toKind: "player",
        toPlayerId: formData.get("targetPlayerId"),
        amount: formData.get("amount"),
        note: "",
      }),
    });
    renderState(result.state);
    setMessage(ui.transferMessage, "转账已完成。", "success");
    window.setTimeout(() => closeTransferModal(), 500);
  } catch (error) {
    setMessage(ui.transferMessage, error.message, "error");
  }
}

async function handleBankTransfer(event) {
  event.preventDefault();
  if (!session) return;
  const formData = new FormData(forms.bankTransfer);
  setMessage(ui.bankMessage, "提交中...", "");

  try {
    const result = await api(`/api/rooms/${session.roomCode}/transfer`, {
      method: "POST",
      body: JSON.stringify({
        playerId: session.playerId,
        token: session.token,
        fromKind: "bank",
        toKind: "player",
        toPlayerId: formData.get("target"),
        amount: formData.get("amount"),
        note: "",
      }),
    });
    forms.bankTransfer.reset();
    renderState(result.state);
    setMessage(ui.bankMessage, "银行发钱已完成。", "success");
  } catch (error) {
    setMessage(ui.bankMessage, error.message, "error");
  }
}

async function handleAssignBankAdmin(event) {
  event.preventDefault();
  if (!session) return;
  const formData = new FormData(forms.bankAdmin);
  setMessage(ui.adminMessage, "保存中...", "");

  try {
    const result = await api(`/api/rooms/${session.roomCode}/bank-admin`, {
      method: "POST",
      body: JSON.stringify({
        playerId: session.playerId,
        token: session.token,
        bankAdminPlayerId: formData.get("bankAdminPlayerId"),
      }),
    });
    renderState(result.state);
    setMessage(ui.adminMessage, "银行管理员已更新。", "success");
  } catch (error) {
    setMessage(ui.adminMessage, error.message, "error");
  }
}

async function handleCopyRoomCode() {
  if (!currentState) return;
  try {
    await navigator.clipboard.writeText(currentState.room.code);
    ui.syncStatus.textContent = "房间码已复制";
  } catch (_error) {
    ui.syncStatus.textContent = `房间码 ${currentState.room.code}`;
  }
}

function handleLeaveRoom() {
  clearSession();
  forms.create.reset();
  forms.join.reset();
  forms.bankTransfer.reset();
  forms.bankAdmin.reset();
  showAuth("已退出当前房间。");
}

function escapeHtml(raw) {
  return String(raw ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
