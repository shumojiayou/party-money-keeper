const SESSION_KEY = "party-money-keeper-session";
const SAVED_ROOMS_KEY = "party-money-keeper-saved-rooms";
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
  playersList: document.getElementById("players-list"),
  transactionsList: document.getElementById("transactions-list"),
  syncStatus: document.getElementById("sync-status"),
  bankTarget: document.getElementById("bank-target"),
  bankPanel: document.getElementById("bank-panel"),
  adminPanel: document.getElementById("admin-panel"),
  bankAdminSelect: document.getElementById("bank-admin-select"),
  monopolyGameBtn: document.getElementById("monopoly-game-btn"),
  gameForms: document.getElementById("game-forms"),
  transferModal: document.getElementById("transfer-modal"),
  transferTargetName: document.getElementById("transfer-target-name"),
  transferPlayerId: document.getElementById("transfer-player-id"),
  transferAmount: document.getElementById("transfer-amount"),
  transferMessage: document.getElementById("transfer-message"),
  closeTransferBtn: document.getElementById("close-transfer-btn"),
  cancelTransferBtn: document.getElementById("cancel-transfer-btn"),
  recentRoomsPanel: document.getElementById("recent-rooms-panel"),
  recentRoomsList: document.getElementById("recent-rooms-list"),
  pauseRoomBtn: document.getElementById("pause-room-btn"),
  exitRoomBtn: document.getElementById("exit-room-btn"),
  dissolveRoomBtn: document.getElementById("dissolve-room-btn"),
};

const forms = {
  create: document.getElementById("create-form"),
  join: document.getElementById("join-form"),
  transfer: document.getElementById("transfer-form"),
  bankTransfer: document.getElementById("bank-transfer-form"),
  bankAdmin: document.getElementById("bank-admin-form"),
};

let session = loadSession();
let savedRooms = loadSavedRooms();
let currentState = null;
let pollTimer = null;

forms.create.addEventListener("submit", handleCreateRoom);
forms.join.addEventListener("submit", handleJoinRoom);
forms.transfer.addEventListener("submit", handlePlayerTransfer);
forms.bankTransfer.addEventListener("submit", handleBankTransfer);
forms.bankAdmin.addEventListener("submit", handleAssignBankAdmin);
ui.pauseRoomBtn.addEventListener("click", handlePauseRoom);
ui.exitRoomBtn.addEventListener("click", handleExitRoom);
ui.dissolveRoomBtn.addEventListener("click", handleDissolveRoom);
ui.monopolyGameBtn.addEventListener("click", activateMonopolyGame);
ui.playersList.addEventListener("click", handlePlayerCardClick);
ui.closeTransferBtn.addEventListener("click", closeTransferModal);
ui.cancelTransferBtn.addEventListener("click", closeTransferModal);
ui.transferModal.addEventListener("click", handleBackdropClick);
ui.recentRoomsList.addEventListener("click", handleSavedRoomClick);
document.addEventListener("visibilitychange", handleVisibilityRefresh);
window.addEventListener("focus", handleVisibilityRefresh);
window.addEventListener("pageshow", handleVisibilityRefresh);
window.addEventListener("popstate", handlePopState);

boot();

async function boot() {
  activateMonopolyGame();
  renderSavedRooms();
  ensureAuthHistoryState();

  if (!session) {
    showAuth();
    return;
  }

  try {
    await fetchState({ showSyncPulse: false });
  } catch (error) {
    if (handleFatalRoomError(error)) {
      return;
    }
    exitToAuth("登录状态已失效，请重新进入房间。", "error");
  }
}

function activateMonopolyGame() {
  ui.monopolyGameBtn.classList.add("is-active");
  ui.gameForms.classList.remove("hidden");
}

function ensureAuthHistoryState() {
  if (history.state?.screen === "auth") {
    return;
  }
  history.replaceState({ screen: "auth" }, "", window.location.pathname);
}

function ensureRoomHistoryState() {
  if (history.state?.screen === "room") {
    return;
  }
  history.pushState({ screen: "room" }, "", window.location.pathname);
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_error) {
    return null;
  }
}

function loadSavedRooms() {
  try {
    const raw = localStorage.getItem(SAVED_ROOMS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function saveSession(nextSession) {
  session = nextSession;
  localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
}

function saveSavedRooms(nextRooms) {
  savedRooms = nextRooms;
  localStorage.setItem(SAVED_ROOMS_KEY, JSON.stringify(nextRooms));
  renderSavedRooms();
}

function savedRoomId(room) {
  return `${room.roomCode}:${room.playerId}`;
}

function rememberSavedRoom(room) {
  if (!room?.roomCode || !room?.playerId || !room?.token) return;
  const existingRoom = savedRooms.find((item) => savedRoomId(item) === savedRoomId(room));

  const nextRoom = {
    roomCode: String(room.roomCode),
    playerId: Number(room.playerId),
    token: String(room.token),
    roomName: room.roomName || GAME_NAME,
    playerName: room.playerName || "",
    updatedAt: room.updatedAt || existingRoom?.updatedAt || Date.now(),
  };

  const filtered = savedRooms.filter((item) => savedRoomId(item) !== savedRoomId(nextRoom));
  const nextRooms = [nextRoom, ...filtered].slice(0, 6);
  if (JSON.stringify(nextRooms) !== JSON.stringify(savedRooms)) {
    saveSavedRooms(nextRooms);
  }
}

function forgetSavedRoom(room) {
  if (!room?.roomCode || !room?.playerId) return;
  saveSavedRooms(savedRooms.filter((item) => savedRoomId(item) !== savedRoomId(room)));
}

function renderSavedRooms() {
  if (!savedRooms.length) {
    ui.recentRoomsPanel.classList.add("hidden");
    ui.recentRoomsList.innerHTML = "";
    return;
  }

  ui.recentRoomsPanel.classList.remove("hidden");
  ui.recentRoomsList.innerHTML = savedRooms
    .map((room) => {
      const roomId = savedRoomId(room);
      return `
        <button class="saved-room-card" type="button" data-saved-room-id="${escapeHtml(roomId)}">
          <div>
            <strong>${escapeHtml(room.roomName || GAME_NAME)}</strong>
            <p class="saved-room-meta">房间码 ${escapeHtml(room.roomCode)} · 我是 ${escapeHtml(room.playerName || "玩家")}</p>
          </div>
          <span class="role-chip action">重新进入</span>
        </button>
      `;
    })
    .join("");
}

function shouldForgetSavedRoom(error) {
  const message = String(error?.message || "");
  return (
    message.includes("重新加入房间") ||
    message.includes("登录状态已失效") ||
    message.includes("房间不存在")
  );
}

function clearSession({ forget = false } = {}) {
  const previousSession = session;
  session = null;
  currentState = null;
  localStorage.removeItem(SESSION_KEY);
  stopPolling();
  if (forget && previousSession) {
    forgetSavedRoom(previousSession);
  }
}

function showAuth(message = "", tone = "") {
  activateMonopolyGame();
  ui.authScreen.classList.remove("hidden");
  ui.dashboardScreen.classList.add("hidden");
  closeTransferModal();
  renderSavedRooms();
  setMessage(ui.authMessage, message, tone);
  ensureAuthHistoryState();
}

function showDashboard() {
  ui.authScreen.classList.add("hidden");
  ui.dashboardScreen.classList.remove("hidden");
  ensureRoomHistoryState();
}

function isFatalRoomError(error) {
  return shouldForgetSavedRoom(error) || String(error?.message || "").includes("房间已被解散");
}

function exitToAuth(message, tone = "", { forget = false } = {}) {
  clearSession({ forget });
  resetRoomForms();
  showAuth(message, tone);
}

function handleFatalRoomError(error) {
  if (!isFatalRoomError(error)) {
    return false;
  }
  exitToAuth(error.message, "error", { forget: true });
  return true;
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
    cache: "no-store",
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
        roomCode: String(formData.get("roomCode") || "").trim(),
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

async function handleSavedRoomClick(event) {
  const card = event.target.closest("[data-saved-room-id]");
  if (!card) return;

  const room = savedRooms.find((item) => savedRoomId(item) === card.dataset.savedRoomId);
  if (!room) return;

  saveSession({
    roomCode: room.roomCode,
    playerId: room.playerId,
    token: room.token,
  });
  setMessage(ui.authMessage, "正在重新进入房间...", "");

  try {
    await fetchState({ showSyncPulse: false });
    showDashboard();
    startPolling();
  } catch (error) {
    if (handleFatalRoomError(error)) {
      return;
    }
    exitToAuth(error.message, "error");
  }
}

async function fetchState({ showSyncPulse = true } = {}) {
  if (!session) return;
  const query = new URLSearchParams({
    playerId: String(session.playerId),
    token: session.token,
    _ts: String(Date.now()),
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
      if (handleFatalRoomError(error)) {
        return;
      }
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

function handleVisibilityRefresh() {
  if (!session) return;
  if (document.visibilityState && document.visibilityState !== "visible") return;

  fetchState({ showSyncPulse: false }).catch((error) => {
    if (handleFatalRoomError(error)) {
      return;
    }
    ui.syncStatus.textContent = error.message;
  });
}

function handlePopState() {
  if (!session || ui.dashboardScreen.classList.contains("hidden")) {
    return;
  }
  pauseRoomLocally("已暂离当前房间。");
}

function resetRoomForms() {
  forms.create.reset();
  forms.join.reset();
  forms.transfer.reset();
  forms.bankTransfer.reset();
  forms.bankAdmin.reset();
}

function renderState(state) {
  currentState = state;
  ui.roomTitle.textContent = state.room.name || GAME_NAME;
  ui.roomMeta.textContent = `房间码 ${state.room.code} · 我是 ${state.me.name}`;
  ui.myBalance.textContent = formatMoney(state.me.balance);
  ui.myRank.textContent = state.me.rank ? `#${state.me.rank}` : "-";
  ui.syncStatus.textContent = `最近同步 ${formatDateTime(state.serverTime)}`;
  if (session) {
    rememberSavedRoom({
      ...session,
      roomName: state.room.name || GAME_NAME,
      playerName: state.me.name,
      updatedAt: Date.now(),
    });
  }

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
      const actionBadge =
        player.id === meId ? "" : '<span class="role-chip action">点此转账</span>';
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
              ${actionBadge}
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
  restoreSelectValue(ui.bankTarget, previousBankTarget || String(bankAdminPlayerId));
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
  if (!card || !currentState) return;

  const targetId = Number(card.dataset.playerId);
  const player = currentState.players.find((item) => item.id === targetId);
  if (!player) return;
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
  if (ui.transferModal.classList.contains("hidden")) return;

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
  if (!session || !currentState) return;

  const formData = new FormData(forms.transfer);
  const amount = Number(formData.get("amount"));
  if (!Number.isFinite(amount) || amount <= 0) {
    setMessage(ui.transferMessage, "请输入有效金额。", "error");
    return;
  }
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
        amount,
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

function pauseRoomLocally(message) {
  if (session && currentState) {
    rememberSavedRoom({
      ...session,
      roomName: currentState.room.name || GAME_NAME,
      playerName: currentState.me.name,
      updatedAt: Date.now(),
    });
  }

  exitToAuth(message, "success");
}

function handlePauseRoom() {
  pauseRoomLocally("已暂离当前房间。");
}

async function handleExitRoom() {
  if (!session) return;
  if (!window.confirm("退出后会从房间中移除，需要重新加入。确定退出吗？")) {
    return;
  }

  try {
    await api(`/api/rooms/${session.roomCode}/leave`, {
      method: "POST",
      body: JSON.stringify({
        playerId: session.playerId,
        token: session.token,
      }),
    });
    exitToAuth("已退出房间。", "success", { forget: true });
  } catch (error) {
    if (handleFatalRoomError(error)) {
      return;
    }
    ui.syncStatus.textContent = error.message;
  }
}

async function handleDissolveRoom() {
  if (!session) return;
  if (!window.confirm("解散后会清空整个房间，所有玩家都会被移出。确定解散吗？")) {
    return;
  }

  setMessage(ui.adminMessage, "解散中...", "");

  try {
    await api(`/api/rooms/${session.roomCode}/dissolve`, {
      method: "POST",
      body: JSON.stringify({
        playerId: session.playerId,
        token: session.token,
      }),
    });
    exitToAuth("房间已解散。", "success", { forget: true });
  } catch (error) {
    if (handleFatalRoomError(error)) {
      return;
    }
    setMessage(ui.adminMessage, error.message, "error");
  }
}

function escapeHtml(raw) {
  return String(raw ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
