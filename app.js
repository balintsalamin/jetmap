// app.js — a teljes alkalmazás összekötése: képernyők, lobby, játékmenet,
// helymeghatározás és a segítségkérés/válasz UI.

import { ensureSignedIn } from "./firebase-config.js";
import { state, goTo, toast, currentPosition } from "./state.js";
import * as Lobby from "./lobby.js";
import * as Hints from "./hints.js";
import * as Geo from "./geo.js";
import * as MapUI from "./map.js";

// ---------------------------------------------------------------------------
// Modul szintű futásidejű állapot (nem a state.js-ben, mert csak ide tartozik)
// ---------------------------------------------------------------------------

let currentLobbyData = null;
let currentPlayers = [];
let currentHints = [];
let gameScreenActive = false;
let hasMapCentered = false;
let lastLocationSentAt = 0;
let timerInterval = null;
let heartbeatInterval = null;
let hintsUnsub = null;
const suggestionCache = new Map(); // hintId -> kiszámolt válasz-objektum
const pointPickerValues = {}; // prefix -> {lat, lng, label}

// ---------------------------------------------------------------------------
// Indulás
// ---------------------------------------------------------------------------

async function init() {
  try {
    state.uid = await ensureSignedIn();
  } catch (err) {
    toast("Nem sikerült csatlakozni a szerverhez — ellenőrizd a firebase-config.js beállításait.", "error");
    return;
  }
  wireHomeScreen();
  wireLobbyScreen();
  wireGameScreen();
  wireDevPanel();
}

init();

// ---------------------------------------------------------------------------
// Segéd
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function hintTypeLabel(type) {
  return (
    {
      radar: "📡 Rádár",
      thermometer: "🌡️ Hőmérő",
      measuring: "📏 Mérés",
      matching: "🔎 Egyezés",
      custom: "❓ Egyéni kérdés",
    }[type] || type
  );
}

function hintRequestSummary(hint) {
  const p = hint.params || {};
  if (hint.type === "radar") return `Középpont: ${p.label || "kijelölt pont"}`;
  if (hint.type === "thermometer") return "A → B mozgás alapján";
  if (hint.type === "measuring") return `Pont: ${p.label || "kijelölt pont"}`;
  if (hint.type === "matching")
    return `${Geo.MATCHING_CATEGORIES[p.category]?.label || p.category} — ref: ${p.label || "pont"}`;
  if (hint.type === "custom") return `„${p.question}”`;
  return "";
}

function hintAnswerSummary({ type, answer }) {
  if (!answer) return "";
  if (type === "radar") return `Sáv: ${answer.label}`;
  if (type === "thermometer")
    return answer.result === "melegebb" ? "🔥 Melegebb" : answer.result === "hidegebb" ? "❄️ Hidegebb" : "➖ Ugyanolyan";
  if (type === "measuring") return `≈ ${Geo.formatDistance(answer.rounded)}`;
  if (type === "matching")
    return answer.same
      ? `✅ Egyezik (${answer.hiderNearest?.name})`
      : `❌ Nem egyezik (${answer.hiderNearest?.name || "?"} / ${answer.refNearest?.name || "?"})`;
  if (type === "custom") return answer.text;
  return "";
}

// ---------------------------------------------------------------------------
// Kezdőképernyő
// ---------------------------------------------------------------------------

function wireHomeScreen() {
  const statusEl = document.getElementById("home-status");

  document.getElementById("form-create").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("create-name").value.trim();
    if (!name) return;
    statusEl.textContent = "";
    try {
      const code = await Lobby.createLobby(name);
      enterLobby(code);
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });

  document.getElementById("form-join").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("join-name").value.trim();
    const code = document.getElementById("join-code").value.trim();
    if (!name || !code) return;
    statusEl.textContent = "";
    try {
      const usedCode = await Lobby.joinLobby(code, name);
      enterLobby(usedCode);
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });
}

function enterLobby(code) {
  goTo("screen-lobby");
  document.getElementById("lobby-code-text").textContent = code;
  Lobby.subscribeLobby(code, onLobbyChange, onPlayersChange);
  heartbeatInterval = setInterval(() => Lobby.heartbeat(state.lobbyCode), 20000);
}

// ---------------------------------------------------------------------------
// Lobby képernyő
// ---------------------------------------------------------------------------

function wireLobbyScreen() {
  document.getElementById("lobby-code-copy").addEventListener("click", () => {
    const code = document.getElementById("lobby-code-text").textContent;
    navigator.clipboard?.writeText(code).then(() => toast("Kód a vágólapon!", "success"));
  });

  document.getElementById("radar-preset-select").addEventListener("change", (e) => {
    if (!state.isHost || !state.lobbyCode) return;
    Lobby.updateSettings(state.lobbyCode, { radarPreset: e.target.value });
  });

  document.getElementById("start-game-btn").addEventListener("click", async () => {
    try {
      await Lobby.startGame(state.lobbyCode);
    } catch (err) {
      toast("Nem sikerült elindítani: " + err.message, "error");
    }
  });

  document.getElementById("lobby-leave").addEventListener("click", async () => {
    await fullyLeave();
  });

  document.getElementById("player-list").addEventListener("click", async (e) => {
    const btn = e.target.closest('button[data-action="make-hider"]');
    if (!btn) return;
    try {
      await Lobby.assignHider(state.lobbyCode, btn.dataset.uid, currentPlayers);
    } catch (err) {
      toast("Hiba: " + err.message, "error");
    }
  });
}

function renderPlayerList(players, lobby) {
  const ul = document.getElementById("player-list");
  if (!players.length) {
    ul.innerHTML = '<li class="empty-text">Még senki sem csatlakozott.</li>';
    return;
  }
  ul.innerHTML = players
    .map((p) => {
      const isMe = p.uid === state.uid;
      const isHostP = lobby && lobby.hostUid === p.uid;
      const roleLabel =
        p.role === "hider" ? "🫥 Bujkáló" : p.role === "seeker" ? "🔭 Kereső" : "Nincs szerep";
      const canAssign = state.isHost && lobby && lobby.status === "lobby";
      return `
        <li class="player-card ${p.role ? "player-card--" + p.role : ""}">
          <span class="player-card__name">${isHostP ? "👑 " : ""}${escapeHtml(p.name)}${isMe ? " (te)" : ""}</span>
          <span class="player-card__role">${roleLabel}</span>
          ${canAssign ? `<button type="button" class="btn btn--tiny" data-action="make-hider" data-uid="${p.uid}">Ő bújik</button>` : ""}
        </li>`;
    })
    .join("");
}

function updateStartButtonEnabled() {
  const btn = document.getElementById("start-game-btn");
  if (!btn) return;
  btn.disabled = !(state.isHost && currentLobbyData?.hiderUid && currentPlayers.length >= 2);
}

function onLobbyChange(lobby) {
  currentLobbyData = lobby;
  document.getElementById("host-controls").classList.toggle("hidden", !state.isHost);
  document.getElementById("waiting-text").classList.toggle("hidden", state.isHost);
  const sel = document.getElementById("radar-preset-select");
  if (lobby.settings?.radarPreset) sel.value = lobby.settings.radarPreset;
  updateStartButtonEnabled();

  if (lobby.status === "playing" && !gameScreenActive) {
    startGameScreen();
  } else if (lobby.status === "lobby" && gameScreenActive) {
    teardownGameScreen();
    goTo("screen-lobby");
    toast("A kör véget ért.", "info");
  }
}

function onPlayersChange(players) {
  currentPlayers = players;
  renderPlayerList(players, currentLobbyData);
  MapUI.renderSeekerMarkers(players);
  updateStartButtonEnabled();
}

async function fullyLeave() {
  clearInterval(heartbeatInterval);
  heartbeatInterval = null;
  teardownGameScreen();
  await Lobby.leaveLobby();
  goTo("screen-home");
}

// ---------------------------------------------------------------------------
// Játékképernyő — közös rész
// ---------------------------------------------------------------------------

function wireGameScreen() {
  document.getElementById("game-leave").addEventListener("click", fullyLeave);

  document.getElementById("end-round-btn").addEventListener("click", async () => {
    if (!confirm("Biztosan vége a körnek? Mindenki visszakerül a váróterembe.")) return;
    try {
      await Lobby.endRound(state.lobbyCode, currentPlayers);
    } catch (err) {
      toast("Hiba: " + err.message, "error");
    }
  });

  document.getElementById("hint-type-select").addEventListener("change", (e) => {
    populateHintFields(e.target.value);
  });

  document.getElementById("hint-fields").addEventListener("click", onHintFieldsClick);

  document.getElementById("hint-submit-btn").addEventListener("click", onHintSubmit);
}

function startGameScreen() {
  gameScreenActive = true;
  hasMapCentered = false;
  lastLocationSentAt = 0;
  suggestionCache.clear();
  goTo("screen-game");

  const roleBadge = document.getElementById("role-badge");
  roleBadge.textContent = state.role === "hider" ? "🫥 Te bújsz" : "🔭 Te keresel";
  roleBadge.className = "role-badge role-badge--" + state.role;
  document.getElementById("hider-panel").classList.toggle("hidden", state.role !== "hider");
  document.getElementById("seeker-panel").classList.toggle("hidden", state.role !== "seeker");
  document.getElementById("end-round-btn").classList.toggle("hidden", !state.isHost);

  MapUI.createMap("map");
  MapUI.renderSeekerMarkers(currentPlayers);

  state.watchId = Geo.watchPosition(onPositionUpdate, (err) =>
    toast("Helymeghatározási hiba: " + err.message, "error")
  );

  timerInterval = setInterval(updateTimerDisplay, 1000);
  updateTimerDisplay();

  hintsUnsub = Hints.subscribeHints(state.lobbyCode, onHintsChange);

  if (state.role === "seeker") {
    populateHintFields(document.getElementById("hint-type-select").value);
  }
}

function teardownGameScreen() {
  gameScreenActive = false;
  Geo.clearWatch(state.watchId);
  state.watchId = null;
  clearInterval(timerInterval);
  timerInterval = null;
  if (hintsUnsub) hintsUnsub();
  hintsUnsub = null;
  MapUI.destroyMap();
  currentHints = [];
  suggestionCache.clear();
}

function updateTimerDisplay() {
  const el = document.getElementById("round-timer");
  if (!el) return;
  if (!currentLobbyData?.roundStartedAt?.toDate) {
    el.textContent = "00:00";
    return;
  }
  const started = currentLobbyData.roundStartedAt.toDate().getTime();
  const elapsedSec = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");
  el.textContent = `${mm}:${ss}`;
}

function onPositionUpdate(pos) {
  state.lastKnownPosition = pos;
  if (!hasMapCentered) {
    MapUI.centerMapOnce(currentPosition());
    hasMapCentered = true;
  }
  applyPositionSideEffects();
}

function applyPositionSideEffects() {
  const pos = currentPosition();
  if (!pos) return;
  if (state.role === "seeker" && state.lobbyCode) {
    const now = Date.now();
    if (now - lastLocationSentAt > 6000) {
      lastLocationSentAt = now;
      Lobby.updateMyLocation(state.lobbyCode, pos);
    }
  }
  if (state.role === "hider") {
    renderHiderFeed(currentHints);
  }
  const devPosEl = document.getElementById("dev-current-pos");
  if (devPosEl) devPosEl.textContent = `Jelenlegi pozíció: ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`;
}

function onHintsChange(hints) {
  currentHints = hints;
  MapUI.renderHintOverlays(hints);
  if (state.role === "hider") renderHiderFeed(hints);
  else if (state.role === "seeker") renderSeekerFeed(hints);
}

// ---------------------------------------------------------------------------
// Bujkáló nézet — beérkező kérések, javasolt válaszok, küldés
// ---------------------------------------------------------------------------

function renderHiderFeed(hints) {
  const container = document.getElementById("hider-hint-feed");
  if (!container) return;
  if (!hints.length) {
    container.innerHTML =
      '<p class="empty-text">Egyelőre nincs kérés — a keresők innen fognak segítséget kérni.</p>';
    return;
  }
  const pending = hints.filter((h) => h.status === "pending");
  const answered = hints.filter((h) => h.status === "answered").slice().reverse();
  container.innerHTML = "";
  pending.forEach((h) => container.appendChild(buildHiderPendingCard(h)));
  answered.forEach((h) => container.appendChild(buildAnsweredCard(h)));
}

function buildHiderPendingCard(hint) {
  const div = document.createElement("div");
  div.className = "hint-card hint-card--pending";
  div.dataset.hintId = hint.id;

  if (hint.type === "custom") {
    div.innerHTML = `
      <div class="hint-card__head">
        <span class="hint-card__type">${hintTypeLabel(hint.type)}</span>
        <span class="hint-card__from">${escapeHtml(hint.requestedByName || "")}</span>
      </div>
      <p class="hint-card__req">${escapeHtml(hintRequestSummary(hint))}</p>
      <textarea class="custom-answer-input" rows="2" placeholder="Válaszod…"></textarea>
      <button type="button" class="btn btn--primary btn--small" data-action="send-custom">Válasz küldése</button>
    `;
    div.querySelector('[data-action="send-custom"]').addEventListener("click", async () => {
      const text = div.querySelector(".custom-answer-input").value.trim();
      if (!text) {
        toast("Írj választ, mielőtt elküldöd.", "error");
        return;
      }
      await sendHiderAnswer(hint.id, { text });
    });
    return div;
  }

  div.innerHTML = `
    <div class="hint-card__head">
      <span class="hint-card__type">${hintTypeLabel(hint.type)}</span>
      <span class="hint-card__from">${escapeHtml(hint.requestedByName || "")}</span>
    </div>
    <p class="hint-card__req">${escapeHtml(hintRequestSummary(hint))}</p>
    <p class="hint-card__suggestion" id="suggestion-${hint.id}">Számolás…</p>
    <div class="hint-card__actions">
      ${hint.type === "matching" ? '<button type="button" class="btn btn--ghost btn--tiny" data-action="refresh">Frissítés</button>' : ""}
      <button type="button" class="btn btn--primary btn--small" data-action="send" disabled>Válasz küldése</button>
    </div>
  `;
  div.querySelector('[data-action="send"]').addEventListener("click", async () => {
    const cached = suggestionCache.get(hint.id);
    if (!cached) return;
    await sendHiderAnswer(hint.id, cached);
  });
  div.querySelector('[data-action="refresh"]')?.addEventListener("click", () => {
    suggestionCache.delete(hint.id);
    fillSuggestion(hint, div);
  });
  fillSuggestion(hint, div);
  return div;
}

async function fillSuggestion(hint, cardEl) {
  const pos = currentPosition();
  const suggestionEl = cardEl.querySelector(`#suggestion-${hint.id}`);
  if (!pos) {
    if (suggestionEl) suggestionEl.textContent = "Várakozás GPS-jelre…";
    return;
  }
  if (hint.type === "matching" && suggestionCache.has(hint.id)) {
    renderSuggestionText(hint, suggestionCache.get(hint.id), cardEl);
    return;
  }
  try {
    const answer = await Hints.computeSuggestedAnswer(hint, pos);
    suggestionCache.set(hint.id, answer);
    renderSuggestionText(hint, answer, cardEl);
  } catch (err) {
    if (suggestionEl) suggestionEl.textContent = "Hiba a számításnál: " + err.message;
  }
}

function renderSuggestionText(hint, answer, cardEl) {
  const suggestionEl = cardEl.querySelector(`#suggestion-${hint.id}`);
  if (suggestionEl) {
    suggestionEl.textContent = "Javasolt válasz: " + hintAnswerSummary({ type: hint.type, answer });
  }
  const sendBtn = cardEl.querySelector('[data-action="send"]');
  if (sendBtn) sendBtn.disabled = false;
}

async function sendHiderAnswer(hintId, answer) {
  try {
    await Hints.submitAnswer(state.lobbyCode, hintId, answer);
    toast("Válasz elküldve.", "success");
  } catch (err) {
    toast("Hiba a küldésnél: " + err.message, "error");
  }
}

function buildAnsweredCard(hint) {
  const div = document.createElement("div");
  div.className = "hint-card hint-card--answered";
  div.innerHTML = `
    <div class="hint-card__head">
      <span class="hint-card__type">${hintTypeLabel(hint.type)}</span>
      <span class="hint-card__from">${escapeHtml(hint.requestedByName || "")}</span>
    </div>
    <p class="hint-card__req">${escapeHtml(hintRequestSummary(hint))}</p>
    <p class="hint-card__answer">${escapeHtml(hintAnswerSummary(hint))}</p>
  `;
  return div;
}

// ---------------------------------------------------------------------------
// Kereső nézet — kérés-összeállító űrlap + előzmények
// ---------------------------------------------------------------------------

function buildPointPickerHTML(prefix, title) {
  return `
    <div class="point-picker" data-prefix="${prefix}">
      <span class="point-picker__title">${title}</span>
      <div class="point-picker__search">
        <input type="text" id="${prefix}-search" placeholder="Hely neve…" />
        <button type="button" class="btn btn--small" data-action="search" data-prefix="${prefix}">Keres</button>
      </div>
      <div id="${prefix}-results" class="point-picker__results"></div>
      <div class="point-picker__buttons">
        <button type="button" class="btn btn--small btn--ghost" data-action="pick-map" data-prefix="${prefix}">🗺️ Térképen kijelölöm</button>
        <button type="button" class="btn btn--small btn--ghost" data-action="use-my-location" data-prefix="${prefix}">📍 Saját helyzetem</button>
      </div>
      <p class="point-picker__chosen" id="${prefix}-chosen">Nincs pont kiválasztva.</p>
    </div>
  `;
}

function populateHintFields(type) {
  Object.keys(pointPickerValues).forEach((k) => delete pointPickerValues[k]);
  MapUI.clearTempMarker();
  const el = document.getElementById("hint-fields");
  if (type === "radar") {
    el.innerHTML = buildPointPickerHTML("radar-center", "Középpont");
  } else if (type === "thermometer") {
    el.innerHTML =
      buildPointPickerHTML("therm-a", "A pont (ahonnan indultatok)") +
      buildPointPickerHTML("therm-b", "B pont (ahol most vagytok)");
  } else if (type === "measuring") {
    el.innerHTML = buildPointPickerHTML("measure-point", "Mérési pont");
  } else if (type === "matching") {
    const options = Object.entries(Geo.MATCHING_CATEGORIES)
      .map(([k, v]) => `<option value="${k}">${escapeHtml(v.label)}</option>`)
      .join("");
    el.innerHTML =
      `<label>Kategória <select id="matching-category">${options}</select></label>` +
      buildPointPickerHTML("matching-ref", "Referenciapont (jellemzően a ti helyzetetek)");
  } else if (type === "custom") {
    el.innerHTML = `<label>Kérdésed <textarea id="custom-question" rows="3" placeholder="Írd le, mit szeretnél kérdezni…"></textarea></label>`;
  }
}

async function onHintFieldsClick(e) {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const prefix = btn.dataset.prefix;
  const action = btn.dataset.action;

  if (action === "search") {
    const input = document.getElementById(`${prefix}-search`);
    const results = await Geo.searchPlace(input.value).catch(() => []);
    renderSearchResults(prefix, results);
  } else if (action === "select-result") {
    setPointPickerValue(prefix, {
      lat: parseFloat(btn.dataset.lat),
      lng: parseFloat(btn.dataset.lng),
      label: btn.dataset.label,
    });
  } else if (action === "pick-map") {
    toast("Koppints a térképre a pont kijelöléséhez.", "info");
    const pt = await MapUI.pickPointOnMap();
    if (pt) setPointPickerValue(prefix, { ...pt, label: "Térképen kijelölt pont" });
  } else if (action === "use-my-location") {
    const pos = currentPosition();
    if (!pos) {
      toast("Még nincs GPS-jel.", "error");
      return;
    }
    setPointPickerValue(prefix, { lat: pos.lat, lng: pos.lng, label: "Saját helyzetem" });
  }
}

function renderSearchResults(prefix, results) {
  const box = document.getElementById(`${prefix}-results`);
  if (!box) return;
  if (!results.length) {
    box.innerHTML = '<p class="hint-text">Nincs találat.</p>';
    return;
  }
  box.innerHTML = results
    .map(
      (r) =>
        `<button type="button" class="result-item" data-action="select-result" data-prefix="${prefix}" data-lat="${r.lat}" data-lng="${r.lng}" data-label="${escapeHtml(r.label)}">${escapeHtml(r.label)}</button>`
    )
    .join("");
}

function setPointPickerValue(prefix, val) {
  pointPickerValues[prefix] = val;
  const chosenEl = document.getElementById(`${prefix}-chosen`);
  if (chosenEl) chosenEl.textContent = `📍 ${val.label} (${val.lat.toFixed(4)}, ${val.lng.toFixed(4)})`;
  MapUI.setTempMarker(val.lat, val.lng, val.label);
  const resultsEl = document.getElementById(`${prefix}-results`);
  if (resultsEl) resultsEl.innerHTML = "";
}

function buildParamsForSubmit() {
  const type = document.getElementById("hint-type-select").value;
  if (type === "radar") {
    const p = pointPickerValues["radar-center"];
    if (!p) {
      toast("Válassz középpontot!", "error");
      return null;
    }
    return {
      type,
      params: { lat: p.lat, lng: p.lng, label: p.label, preset: currentLobbyData?.settings?.radarPreset || "kozepes" },
    };
  }
  if (type === "thermometer") {
    const a = pointPickerValues["therm-a"];
    const b = pointPickerValues["therm-b"];
    if (!a || !b) {
      toast("Válaszd ki mindkét pontot!", "error");
      return null;
    }
    return { type, params: { a: { lat: a.lat, lng: a.lng }, b: { lat: b.lat, lng: b.lng } } };
  }
  if (type === "measuring") {
    const p = pointPickerValues["measure-point"];
    if (!p) {
      toast("Válassz pontot!", "error");
      return null;
    }
    return { type, params: { lat: p.lat, lng: p.lng, label: p.label } };
  }
  if (type === "matching") {
    const category = document.getElementById("matching-category").value;
    const p = pointPickerValues["matching-ref"];
    if (!p) {
      toast("Válassz referenciapontot!", "error");
      return null;
    }
    return { type, params: { category, lat: p.lat, lng: p.lng, label: p.label } };
  }
  if (type === "custom") {
    const q = document.getElementById("custom-question").value.trim();
    if (!q) {
      toast("Írd le a kérdésed!", "error");
      return null;
    }
    return { type, params: { question: q } };
  }
  return null;
}

async function onHintSubmit() {
  const built = buildParamsForSubmit();
  if (!built) return;
  const btn = document.getElementById("hint-submit-btn");
  btn.disabled = true;
  try {
    await Hints.requestHint(state.lobbyCode, built.type, built.params);
    toast("Kérés elküldve — várj a bujkálóra!", "success");
    populateHintFields(built.type);
  } catch (err) {
    toast("Hiba: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

function renderSeekerFeed(hints) {
  const container = document.getElementById("seeker-hint-feed");
  if (!container) return;
  if (!hints.length) {
    container.innerHTML = '<p class="empty-text">Még nem kértetek segítséget.</p>';
    return;
  }
  const ordered = hints.slice().reverse();
  container.innerHTML = "";
  ordered.forEach((h) => {
    if (h.status === "answered") {
      container.appendChild(buildAnsweredCard(h));
      return;
    }
    const div = document.createElement("div");
    div.className = "hint-card hint-card--waiting";
    div.innerHTML = `
      <div class="hint-card__head">
        <span class="hint-card__type">${hintTypeLabel(h.type)}</span>
        <span class="hint-card__from">${escapeHtml(h.requestedByName || "")}</span>
      </div>
      <p class="hint-card__req">${escapeHtml(hintRequestSummary(h))}</p>
      <p class="hint-card__waiting">⏳ Várakozás a bujkálóra…</p>
    `;
    container.appendChild(div);
  });
}

// ---------------------------------------------------------------------------
// Fejlesztői panel — 10 koppintás a logóra, szimulált pozíció teszteléshez
// ---------------------------------------------------------------------------

function wireDevPanel() {
  let tapCount = 0;
  let tapTimer = null;
  document.getElementById("logo-tap").addEventListener("click", () => {
    tapCount++;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => (tapCount = 0), 1500);
    if (tapCount >= 10) {
      tapCount = 0;
      document.getElementById("dev-panel").classList.remove("hidden");
    }
  });

  document.getElementById("dev-close").addEventListener("click", () => {
    document.getElementById("dev-panel").classList.add("hidden");
  });

  document.getElementById("dev-apply").addEventListener("click", () => {
    const lat = parseFloat(document.getElementById("dev-lat").value);
    const lng = parseFloat(document.getElementById("dev-lng").value);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      toast("Adj meg érvényes koordinátákat.", "error");
      return;
    }
    state.devOverridePosition = { lat, lng, accuracy: 5 };
    toast("Szimulált pozíció beállítva.", "success");
    applyPositionSideEffects();
  });

  document.getElementById("dev-clear").addEventListener("click", () => {
    state.devOverridePosition = null;
    toast("Valódi GPS-re váltva.", "info");
    applyPositionSideEffects();
  });
}
