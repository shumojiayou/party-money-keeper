const SESSION_KEY = "party-money-keeper-session";
const POLL_INTERVAL_MS = 3000;

const ui = {
  authScreen: document.getElementById("auth-screen"),
  dashboardScreen: document.getElementById("dashboard-screen"),
  authMessage: document.getElementById("auth-message"),
  transferMessage: document.getElementById("transfer-message"),
  bankMessage: document.getElementById("bank-message"),
  adminMessage: document.getElementById("admin-message"),
  roomTitle: document.getElementById("room-title"),
  roomMeta: document.getElementById("room-meta"),
  myBalance: document.getElementById("my-balance"),
  myRank: document.getElementById("my-rank"),
  bankBalance: document.getElementById("bank-balance"),
  bankAdminName: document.getElementById("bank-admin-name"),
  playerCount: document.getElementById("player-count"),
  totalAssets: document.getElementById("total-assets"),
  playersList: document.getElementById("players-list"),
  transactionsList: document.getElementById("transactions-list"),
  syncStatus: document.getElementById("sync-status"),
  transferTarget: document.getElementById("transfer-target"),
  bankTarget: document.getElementById("bank-target"),
  bankPanel: document.getElementById("bank-panel"),
  adminPanel: document.getElementById("admin-panel"),
  bankAdminSelect: document.getElementById("bank-admin-select"),
  copyCodeBtn: document.getElementById("copy-code-btn"),
  leaveRoomBtn: document.getElementById("leave-room-btn"),
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

boot();

async function boot() {
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
  ui.authScreen.classList.remove("hidden");
  ui.dashboardScreen.classList.add("hidden");
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
  const formData = new FormData(forms.create);
  setMessage(ui.authMessage, "正在创建房间...", "");

  try {
    const result = await api("/api/rooms/create", {
      method: "POST",
      body: JSON.stringify({
        roomName: formData.get("roomName"),
        playerName: formData.get("playerName"),
        startingBalance: formData.get("startingBalance"),
        bankBalance: formData.get("bankBalance"),
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
  const formData = new FormData(forms.join);
  setMessage(ui.authMessage, "正在加入房间...", "");

  try {
    const result = await api("/api/rooms/join", {
      method: "POST",
      body: JSON.stringify({
        roomCode: String(formData.get("roomCode") || "").trim().toUpperCase(),
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
  const roomCode = state.room.code;
  const bankAdmin = state.players.find((player) => player.id === state.bankAdminPlayerId);
  const myBadges = [];
  if (state.me.isHost) myBadges.push("房主");
  if (state.me.isBankAdmin) myBadges.push("银行管理员");

  ui.roomTitle.textContent = state.room.name;
  ui.roomMeta.textContent = `房间码 ${roomCode} · 我是 ${state.me.name}${myBadges.length ? ` · ${myBadges.join(" / ")}` : ""}`;
  ui.myBalance.textContent = formatMoney(state.me.balance);
  ui.myRank.textContent = `排名 #${state.me.rank}`;
  ui.bankBalance.textContent = formatMoney(state.room.bankBalance);
  ui.bankAdminName.textContent = `银行管理员 ${bankAdmin ? bankAdmin.name : "未设置"}`;
  ui.playerCount.textContent = String(state.stats.playerCount);
  ui.totalAssets.textContent = `玩家总资产 ${formatMoney(state.stats.totalPlayerAssets)}`;
  ui.syncStatus.textContent = `最近同步 ${formatDateTime(state.serverTime)}`;

  renderPlayers(state.players, state.me.id);
  renderTransferTargets(state.players, state.me.id, state.bankAdminPlayerId);
  renderTransactions(state.transactions);
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
      const roleBadges = [];
      if (player.isHost) roleBadges.push('<span class="role-chip host">房主</span>');
      if (player.isBankAdmin) roleBadges.push('<span class="role-chip">银行</span>');
      return `
        <article class="player-item ${player.id === meId ? "me-highlight" : ""}">
          <div class="player-top">
            <div class="player-name-row">
              <span class="rank-chip">#${index + 1}</span>
              <strong>${escapeHtml(player.name)}</strong>
            </div>
            <span class="player-balance">${formatMoney(player.balance)}</span>
          </div>
          <div class="badge-row">
            ${roleBadges.join("")}
            ${player.id === meId ? '<span class="role-chip">我</span>' : ""}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderTransferTargets(players, meId, bankAdminPlayerId) {
  const currentTransferTarget = ui.transferTarget.value;
  const currentBankTarget = ui.bankTarget.value;
  const currentBankAdminTarget = ui.bankAdminSelect.value;

  const options = ['<option value="bank">银行</option>'];
  const bankOptions = [];
  const adminOptions = [];

  players.forEach((player) => {
    adminOptions.push(
      `<option value="${player.id}" ${player.id === bankAdminPlayerId ? "selected" : ""}>${escapeHtml(player.name)}</option>`
    );

    if (player.id !== meId) {
      options.push(`<option value="player:${player.id}">${escapeHtml(player.name)}</option>`);
    }

    bankOptions.push(`<option value="${player.id}">${escapeHtml(player.name)}</option>`);
  });

  ui.transferTarget.innerHTML = options.join("");
  ui.bankTarget.innerHTML = bankOptions.join("");
  ui.bankAdminSelect.innerHTML = adminOptions.join("");

  restoreSelectValue(ui.transferTarget, currentTransferTarget || "bank");
  restoreSelectValue(ui.bankTarget, currentBankTarget);
  restoreSelectValue(ui.bankAdminSelect, currentBankAdminTarget || String(bankAdminPlayerId));
}

function restoreSelectValue(selectElement, preferredValue) {
  if (!preferredValue) {
    return;
  }

  const hasMatchingOption = Array.from(selectElement.options).some(
    (option) => option.value === preferredValue
  );

  if (hasMatchingOption) {
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

async function handlePlayerTransfer(event) {
  event.preventDefault();
  if (!session || !currentState) return;

  const formData = new FormData(forms.transfer);
  const targetValue = String(formData.get("target"));
  const [targetKind, targetPlayerId] = targetValue.includes(":") ? targetValue.split(":") : [targetValue, ""];
  setMessage(ui.transferMessage, "提交中...", "");

  try {
    const result = await api(`/api/rooms/${session.roomCode}/transfer`, {
      method: "POST",
      body: JSON.stringify({
        playerId: session.playerId,
        token: session.token,
        fromKind: "player",
        toKind: targetKind === "bank" ? "bank" : "player",
        toPlayerId: targetPlayerId,
        amount: formData.get("amount"),
        note: formData.get("note"),
      }),
    });
    forms.transfer.reset();
    renderState(result.state);
    setMessage(ui.transferMessage, "转账已完成。", "success");
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
        note: formData.get("note"),
      }),
    });
    forms.bankTransfer.reset();
    renderState(result.state);
    setMessage(ui.bankMessage, "银行付款已完成。", "success");
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
  forms.transfer.reset();
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
