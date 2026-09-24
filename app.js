// app.js — a teljes alkalmazás összekötése: képernyők, lobby, játékmenet,
// helymeghatározás és a segítségkérés/válasz UI (a hivatalos lifack.ch
// szabályok szerint: Rádár, Hőmérő, Mérés, Egyezés, Tentakel, Fotó).

import { ensureSignedIn } from "./firebase-config.js";
import { state, goTo, toast, currentPosition } from "./state.js";
import * as Lobby from "./lobby.js";
import * as Hints from "./hints.js";
import * as Geo from "./geo.js";
import * as MapUI from "./map.js";

// ---------------------------------------------------------------------------
// Modul szintű futásidejű állapot
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
const pointPickerValues = {}; // prefix -> {lat, lng, label} — csak a Hőmérő A/B pontjaihoz

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
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function hintTypeLabel(type) {
  return (
    {
      radar: "📡 Rádár",
      thermometer: "🌡️ Hőmérő",
      measuring: "📏 Mérés",
      matching: "🔎 Egyezés",
      tentacle: "🐙 Tentakel",
      photo: "📷 Fotó",
      custom: "❓ Egyéni kérdés",
    }[type] || type
  );
}

function categoryLabelFor(type, key) {
  if (type === "measuring") return Geo.MEASURING_CATEGORIES[key]?.label || key;
  if (type === "matching") return Geo.MATCHING_CATEGORIES[key]?.label || key;
  if (type === "tentacle") return Geo.TENTACLE_CATEGORIES[key]?.label || key;
  if (type === "photo") return Geo.PHOTO_CATEGORIES[key]?.label || key;
  return key;
}

function hintRequestSummary(hint) {
  const p = hint.params || {};
  if (hint.type === "radar") return `Belül vagy-e ${p.milesLabel}? (a kérő pozíciójától mérve)`;
  if (hint.type === "thermometer") return `A → B mozgás alapján (${Geo.formatMiles(p.sizeMiles)}-es kártya)`;
  if (hint.type === "measuring") {
    if (p.category === "sea_level") return `Tengerszinthez képest — kereső magassága: ${p.seekerAltitude} m`;
    return `${categoryLabelFor("measuring", p.category)} — közelebb vagy távolabb?`;
  }
  if (hint.type === "matching") return `${categoryLabelFor("matching", p.category)} — ugyanaz-e?`;
  if (hint.type === "tentacle") return `${categoryLabelFor("tentacle", p.category)} (${p.radiusMiles} mérföldön belül)`;
  if (hint.type === "photo") return `${categoryLabelFor("photo", p.category)} — ${p.instructions || ""}`;
  if (hint.type === "custom") return `„${p.question}”`;
  return "";
}

function hintAnswerSummary({ type, answer, params }) {
  if (!answer) return "";
  if (answer.noData) return "Nincs elég OpenStreetMap-adat a válaszhoz.";
  if (type === "radar") return answer.within ? `✅ Belül (${Geo.formatDistance(answer.distance)})` : `❌ Kívül (${Geo.formatDistance(answer.distance)})`;
  if (type === "thermometer") return answer.result === "melegebb" ? "🔥 Melegebb" : answer.result === "hidegebb" ? "❄️ Hidegebb" : "➖ Ugyanolyan";
  if (type === "measuring") {
    if (params?.category === "sea_level") {
      return answer.closer
        ? `✅ A bujkáló közelebb van a tengerszinthez (${answer.hiderAltitude} m vs ${answer.seekerAltitude} m)`
        : `❌ A bujkáló távolabb van a tengerszinttől (${answer.hiderAltitude} m vs ${answer.seekerAltitude} m)`;
    }
    return answer.closer
      ? `✅ A bujkáló közelebb van (${Geo.formatDistance(answer.hiderDistance)} vs ${Geo.formatDistance(answer.seekerDistance)})`
      : `❌ A bujkáló távolabb van (${Geo.formatDistance(answer.hiderDistance)} vs ${Geo.formatDistance(answer.seekerDistance)})`;
  }
  if (type === "matching") {
    return answer.same
      ? `✅ Egyezik (${answer.hiderNearest?.name || "?"})`
      : `❌ Nem egyezik (${answer.hiderNearest?.name || "?"} / ${answer.seekerNearest?.name || "?"})`;
  }
  if (type === "tentacle") return answer.inReach ? `🎯 Hatótávolságon belül: ${answer.name}` : "❌ Hatótávolságon kívül";
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

  document.getElementById("game-size-select").addEventListener("change", (e) => {
    if (!state.isHost || !state.lobbyCode) return;
    Lobby.updateSettings(state.lobbyCode, { gameSize: e.target.value });
  });

  document.getElementById("start-game-btn").addEventListener("click", async () => {
    try {
      await Lobby.startGame(state.lobbyCode);
    } catch (err) {
      toast("Nem sikerült elindítani: " + err.message, "error");
    }
  });

  document.getElementById("lobby-leave").addEventListener("click", fullyLeave);

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
      const roleLabel = p.role === "hider" ? "🫥 Bujkáló" : p.role === "seeker" ? "🔭 Kereső" : "Nincs szerep";
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
  const sel = document.getElementById("game-size-select");
  if (lobby.settings?.gameSize) sel.value = lobby.settings.gameSize;
  renderPlayerList(currentPlayers, lobby);
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

  document.getElementById("hint-type-select").addEventListener("change", (e) => populateHintFields(e.target.value));
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

  state.watchId = Geo.watchPosition(onPositionUpdate, (err) => toast("Helymeghatározási hiba: " + err.message, "error"));

  timerInterval = setInterval(updateTimerDisplay, 1000);
  updateTimerDisplay();

  hintsUnsub = Hints.subscribeHints(state.lobbyCode, onHintsChange);

  if (state.role === "seeker") populateHintFields(document.getElementById("hint-type-select").value);
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
  if (state.role === "hider") renderHiderFeed(currentHints);
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
    container.innerHTML = '<p class="empty-text">Egyelőre nincs kérés — a keresők innen fognak segítséget kérni.</p>';
    return;
  }
  const pending = hints.filter((h) => h.status === "pending");
  const answered = hints.filter((h) => h.status === "answered").slice().reverse();
  container.innerHTML = "";
  pending.forEach((h) => container.appendChild(buildHiderPendingCard(h)));
  answered.forEach((h) => container.appendChild(buildAnsweredCard(h)));
}

function cardHeadHTML(hint) {
  return `
    <div class="hint-card__head">
      <span class="hint-card__type">${hintTypeLabel(hint.type)}</span>
      <span class="hint-card__from">${escapeHtml(hint.requestedByName || "")}</span>
    </div>
    <p class="hint-card__req">${escapeHtml(hintRequestSummary(hint))}</p>
  `;
}

function manualAnswerFormHTML() {
  return `<textarea class="manual-answer-input" rows="2" placeholder="Válaszod…"></textarea><button type="button" class="btn btn--primary btn--small" data-action="send-manual">Válasz küldése</button>`;
}
function wireManualAnswerForm(container, hint) {
  container.querySelector('[data-action="send-manual"]')?.addEventListener("click", async () => {
    const text = container.querySelector(".manual-answer-input").value.trim();
    if (!text) {
      toast("Írj választ, mielőtt elküldöd.", "error");
      return;
    }
    await sendHiderAnswer(hint.id, { text });
  });
}

function altitudeAnswerFormHTML(seekerAltitude) {
  return `
    <p class="hint-text">A kereső magassága: ${seekerAltitude} m. Add meg a sajátodat (telefonod iránytű/magasságmérő appjából):</p>
    <input type="number" class="altitude-answer-input" step="1" placeholder="pl. 132" />
    <button type="button" class="btn btn--primary btn--small" data-action="send-altitude">Válasz küldése</button>
  `;
}
function wireAltitudeAnswerForm(div, hint) {
  div.querySelector('[data-action="send-altitude"]').addEventListener("click", async () => {
    const val = parseFloat(div.querySelector(".altitude-answer-input").value);
    if (Number.isNaN(val)) {
      toast("Adj meg egy érvényes magasságot.", "error");
      return;
    }
    const seekerAlt = hint.params.seekerAltitude;
    await sendHiderAnswer(hint.id, { closer: Math.abs(val) < Math.abs(seekerAlt), hiderAltitude: val, seekerAltitude: seekerAlt });
  });
}

function photoAnswerFormHTML() {
  return `
    <input type="file" accept="image/*" capture="environment" class="photo-answer-input" />
    <img class="photo-answer-preview hidden" />
    <button type="button" class="btn btn--primary btn--small" data-action="send-photo" disabled>Fotó küldése</button>
  `;
}
function wirePhotoAnswerForm(div, hint) {
  const fileInput = div.querySelector(".photo-answer-input");
  const preview = div.querySelector(".photo-answer-preview");
  const sendBtn = div.querySelector('[data-action="send-photo"]');
  let compressed = null;
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    sendBtn.disabled = true;
    try {
      compressed = await compressImageFile(file);
      preview.src = compressed;
      preview.classList.remove("hidden");
      sendBtn.disabled = false;
    } catch (err) {
      toast("Nem sikerült feldolgozni a képet: " + err.message, "error");
    }
  });
  sendBtn.addEventListener("click", async () => {
    if (!compressed) return;
    await sendHiderAnswer(hint.id, { photoDataUrl: compressed });
  });
}

function compressImageFile(file, maxDim = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Nem sikerült beolvasni a fájlt."));
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => reject(new Error("Érvénytelen képfájl."));
    reader.readAsDataURL(file);
  });
}

function buildHiderPendingCard(hint) {
  const div = document.createElement("div");
  div.className = "hint-card hint-card--pending";
  div.dataset.hintId = hint.id;
  const head = cardHeadHTML(hint);

  if (hint.type === "photo") {
    div.innerHTML = head + photoAnswerFormHTML();
    wirePhotoAnswerForm(div, hint);
    return div;
  }
  if (hint.type === "custom") {
    div.innerHTML = head + manualAnswerFormHTML();
    wireManualAnswerForm(div, hint);
    return div;
  }

  const cat =
    hint.type === "matching"
      ? Geo.MATCHING_CATEGORIES[hint.params.category]
      : hint.type === "measuring"
      ? Geo.MEASURING_CATEGORIES[hint.params.category]
      : hint.type === "tentacle"
      ? Geo.TENTACLE_CATEGORIES[hint.params.category]
      : null;

  if (cat?.kind === "unsupported") {
    div.innerHTML = head + `<p class="hint-text">${escapeHtml(cat.note)}</p>` + manualAnswerFormHTML();
    wireManualAnswerForm(div, hint);
    return div;
  }
  if (cat?.kind === "manual-altitude") {
    div.innerHTML = head + altitudeAnswerFormHTML(hint.params.seekerAltitude);
    wireAltitudeAnswerForm(div, hint);
    return div;
  }

  // Automatikus típusok: radar, thermometer, tentacle, ill. measuring/matching
  // pont/vonal/derived-length/named-way/admin-area fajtái.
  div.innerHTML =
    head +
    `
    <p class="hint-card__suggestion" id="suggestion-${hint.id}">Számolás…</p>
    <div class="hint-card__actions">
      ${["measuring", "matching", "tentacle"].includes(hint.type) ? '<button type="button" class="btn btn--ghost btn--tiny" data-action="refresh">Frissítés</button>' : ""}
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
  const needsNetwork = ["measuring", "matching", "tentacle"].includes(hint.type);
  if (needsNetwork && suggestionCache.has(hint.id)) {
    renderSuggestionText(hint, suggestionCache.get(hint.id), cardEl);
    return;
  }
  try {
    const answer = await Hints.computeSuggestedAnswer(hint, pos);
    if (!answer) {
      if (suggestionEl) suggestionEl.textContent = "Ehhez kézi válasz szükséges.";
      return;
    }
    suggestionCache.set(hint.id, answer);
    renderSuggestionText(hint, answer, cardEl);
  } catch (err) {
    if (suggestionEl) suggestionEl.textContent = "Hiba a számításnál: " + err.message;
  }
}

function renderSuggestionText(hint, answer, cardEl) {
  const suggestionEl = cardEl.querySelector(`#suggestion-${hint.id}`);
  if (answer.noData) {
    if (suggestionEl) suggestionEl.textContent = "Nincs elég OpenStreetMap-adat a közelben — válaszolj kézzel:";
    const actionsEl = cardEl.querySelector(".hint-card__actions");
    if (actionsEl) {
      actionsEl.outerHTML = manualAnswerFormHTML();
      wireManualAnswerForm(cardEl, hint);
    }
    return;
  }
  if (suggestionEl) suggestionEl.textContent = "Javasolt válasz: " + hintAnswerSummary({ type: hint.type, answer, params: hint.params });
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
  const head = cardHeadHTML(hint);
  if (hint.type === "photo" && hint.answer?.photoDataUrl) {
    div.innerHTML = head + `<img class="hint-card__photo" src="${hint.answer.photoDataUrl}" alt="Bujkáló fotója" />`;
    return div;
  }
  div.innerHTML = head + `<p class="hint-card__answer">${escapeHtml(hintAnswerSummary({ type: hint.type, answer: hint.answer, params: hint.params }))}</p>`;
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

function groupedOptionsHTML(categories) {
  const groups = {};
  Object.entries(categories).forEach(([key, cat]) => {
    const g = cat.group || "";
    (groups[g] ??= []).push({ key, ...cat });
  });
  return Object.entries(groups)
    .map(([g, items]) => {
      const opts = items.map((it) => `<option value="${it.key}">${escapeHtml(it.label)}${it.approx ? " *" : ""}</option>`).join("");
      return `<optgroup label="${escapeHtml(g)}">${opts}</optgroup>`;
    })
    .join("");
}

function tierFilteredOptionsHTML(categories, gameSize) {
  return Object.entries(categories)
    .filter(([, cat]) => Geo.tierAvailable(gameSize, cat.tier))
    .map(([key, cat]) => `<option value="${key}">${escapeHtml(cat.label)}</option>`)
    .join("");
}

function populateHintFields(type) {
  Object.keys(pointPickerValues).forEach((k) => delete pointPickerValues[k]);
  MapUI.clearTempMarker();
  const el = document.getElementById("hint-fields");
  const gameSize = currentLobbyData?.settings?.gameSize || "kozepes";
  const cardInfo = Hints.CARD_INFO[type];
  const cardNote = cardInfo ? `<p class="hint-text">Megválaszolás után a bujkáló húz ${cardInfo.draw} lapot, tart ${cardInfo.keep}-et.</p>` : "";

  if (type === "radar") {
    const options = Hints.RADAR_DISTANCES_MILES.map((m) => `<option value="${m}">${Geo.formatMiles(m)}</option>`).join("");
    el.innerHTML = `
      <label>Táv <select id="radar-miles">${options}<option value="custom">Egyéni…</option></select></label>
      <div id="radar-custom-wrap" class="hidden"><label>Egyéni táv (mérföld) <input type="number" id="radar-custom-miles" step="0.1" min="0.05" /></label></div>
      <p class="hint-text">A kérdés a TE jelenlegi helyzetedtől méri: "Belül vagy-e ennyin?"</p>
      ${cardNote}
    `;
    document.getElementById("radar-miles").addEventListener("change", (e) => {
      document.getElementById("radar-custom-wrap").classList.toggle("hidden", e.target.value !== "custom");
    });
    return;
  }

  if (type === "thermometer") {
    const opts = Hints.THERMOMETER_DISTANCES.filter((d) => Geo.tierAvailable(gameSize, d.tier))
      .map((d) => `<option value="${d.miles}">${Geo.formatMiles(d.miles)}</option>`)
      .join("");
    el.innerHTML =
      `<label>Kártya mérete <select id="therm-size">${opts}</select></label>` +
      buildPointPickerHTML("therm-a", "A pont (ahonnan indultatok)") +
      buildPointPickerHTML("therm-b", "B pont (ahol most vagytok)") +
      `<p class="hint-text" id="therm-distance-check"></p>${cardNote}`;
    document.getElementById("therm-size").addEventListener("change", updateThermDistanceCheck);
    return;
  }

  if (type === "measuring") {
    el.innerHTML = `<label>Kategória <select id="measuring-category">${groupedOptionsHTML(Geo.MEASURING_CATEGORIES)}</select></label><div id="measuring-extra"></div><p class="hint-text">* = OSM-alapú becslés, nem szó szerinti szabály.</p>${cardNote}`;
    document.getElementById("measuring-category").addEventListener("change", renderMeasuringExtra);
    renderMeasuringExtra();
    return;
  }

  if (type === "matching") {
    el.innerHTML = `<label>Kategória <select id="matching-category">${groupedOptionsHTML(Geo.MATCHING_CATEGORIES)}</select></label><div id="matching-extra"></div><p class="hint-text">* = OSM-alapú becslés, nem szó szerinti szabály.</p>${cardNote}`;
    document.getElementById("matching-category").addEventListener("change", renderMatchingExtra);
    renderMatchingExtra();
    return;
  }

  if (type === "tentacle") {
    const options = tierFilteredOptionsHTML(Geo.TENTACLE_CATEGORIES, gameSize);
    if (!options) {
      el.innerHTML = `<p class="hint-text">Ehhez a játékmérethez (${Geo.GAME_SIZES[gameSize]}) nincs elérhető Tentakel kategória — legalább Közepes méret kell.</p>`;
      return;
    }
    el.innerHTML = `<label>Kategória <select id="tentacle-category">${options}</select></label>${cardNote}`;
    return;
  }

  if (type === "photo") {
    const options = tierFilteredOptionsHTML(Geo.PHOTO_CATEGORIES, gameSize);
    el.innerHTML = `<label>Kategória <select id="photo-category">${options}</select></label><p class="hint-text" id="photo-instructions"></p>${cardNote}`;
    document.getElementById("photo-category").addEventListener("change", renderPhotoInstructions);
    renderPhotoInstructions();
    return;
  }

  if (type === "custom") {
    el.innerHTML = `<label>Kérdésed <textarea id="custom-question" rows="3" placeholder="Írd le, mit szeretnél kérdezni…"></textarea></label>`;
  }
}

function renderPhotoInstructions() {
  const cat = Geo.PHOTO_CATEGORIES[document.getElementById("photo-category")?.value];
  const el = document.getElementById("photo-instructions");
  if (el && cat) el.textContent = cat.instructions;
}

function renderMeasuringExtra() {
  const cat = Geo.MEASURING_CATEGORIES[document.getElementById("measuring-category")?.value];
  const el = document.getElementById("measuring-extra");
  if (!el) return;
  el.innerHTML =
    cat?.kind === "manual-altitude"
      ? `<label>A TE jelenlegi magasságod (m, a telefonod iránytű/magasságmérő appjából) <input type="number" id="measuring-altitude" step="1" /></label>`
      : "";
}

function renderMatchingExtra() {
  const cat = Geo.MATCHING_CATEGORIES[document.getElementById("matching-category")?.value];
  const el = document.getElementById("matching-extra");
  if (!el) return;
  el.innerHTML = cat?.kind === "unsupported" ? `<p class="hint-text">${escapeHtml(cat.note)} A kérést így is elküldheted, a bujkáló kézzel válaszol majd.</p>` : "";
}

function updateThermDistanceCheck() {
  const a = pointPickerValues["therm-a"];
  const b = pointPickerValues["therm-b"];
  const el = document.getElementById("therm-distance-check");
  if (!el) return;
  if (!a || !b) {
    el.textContent = "";
    return;
  }
  const traveled = Geo.distanceMeters(a.lat, a.lng, b.lat, b.lng);
  const sizeMiles = parseFloat(document.getElementById("therm-size")?.value || "0");
  const requiredM = Geo.milesToMeters(sizeMiles);
  el.textContent =
    traveled < requiredM
      ? `⚠️ Eddig csak ${Geo.formatDistance(traveled)} mozogtatok — a ${Geo.formatMiles(sizeMiles)}-es kártyához ennyit kellene.`
      : `✅ ${Geo.formatDistance(traveled)} megtéve.`;
}

async function onHintFieldsClick(e) {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const prefix = btn.dataset.prefix;
  const action = btn.dataset.action;

  if (action === "search") {
    const results = await Geo.searchPlace(document.getElementById(`${prefix}-search`).value).catch(() => []);
    renderSearchResults(prefix, results);
  } else if (action === "select-result") {
    setPointPickerValue(prefix, { lat: parseFloat(btn.dataset.lat), lng: parseFloat(btn.dataset.lng), label: btn.dataset.label });
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
  if (prefix === "therm-a" || prefix === "therm-b") updateThermDistanceCheck();
}

function buildParamsForSubmit() {
  const type = document.getElementById("hint-type-select").value;

  if (type === "radar") {
    const pos = currentPosition();
    if (!pos) {
      toast("Még nincs GPS-jel.", "error");
      return null;
    }
    const sel = document.getElementById("radar-miles").value;
    let miles;
    if (sel === "custom") {
      miles = parseFloat(document.getElementById("radar-custom-miles").value);
      if (Number.isNaN(miles) || miles <= 0) {
        toast("Adj meg érvényes egyéni távot.", "error");
        return null;
      }
    } else {
      miles = parseFloat(sel);
    }
    return { type, params: { miles, milesLabel: Geo.formatMiles(miles), seekerLocation: { lat: pos.lat, lng: pos.lng } } };
  }

  if (type === "thermometer") {
    const a = pointPickerValues["therm-a"];
    const b = pointPickerValues["therm-b"];
    if (!a || !b) {
      toast("Válaszd ki mindkét pontot!", "error");
      return null;
    }
    return { type, params: { a: { lat: a.lat, lng: a.lng }, b: { lat: b.lat, lng: b.lng }, sizeMiles: parseFloat(document.getElementById("therm-size").value) } };
  }

  if (type === "measuring") {
    const category = document.getElementById("measuring-category").value;
    const cat = Geo.MEASURING_CATEGORIES[category];
    if (cat?.kind === "manual-altitude") {
      const alt = parseFloat(document.getElementById("measuring-altitude")?.value);
      if (Number.isNaN(alt)) {
        toast("Add meg a magasságodat.", "error");
        return null;
      }
      return { type, params: { category, seekerAltitude: alt } };
    }
    const pos = currentPosition();
    if (!pos) {
      toast("Még nincs GPS-jel.", "error");
      return null;
    }
    return { type, params: { category, seekerLocation: { lat: pos.lat, lng: pos.lng } } };
  }

  if (type === "matching") {
    const category = document.getElementById("matching-category").value;
    const pos = currentPosition();
    if (!pos) {
      toast("Még nincs GPS-jel.", "error");
      return null;
    }
    return { type, params: { category, seekerLocation: { lat: pos.lat, lng: pos.lng } } };
  }

  if (type === "tentacle") {
    const category = document.getElementById("tentacle-category")?.value;
    if (!category) {
      toast("Nincs elérhető kategória ehhez a játékmérethez.", "error");
      return null;
    }
    const pos = currentPosition();
    if (!pos) {
      toast("Még nincs GPS-jel.", "error");
      return null;
    }
    return { type, params: { category, radiusMiles: Geo.TENTACLE_CATEGORIES[category].radiusMiles, seekerLocation: { lat: pos.lat, lng: pos.lng } } };
  }

  if (type === "photo") {
    const category = document.getElementById("photo-category").value;
    return { type, params: { category, instructions: Geo.PHOTO_CATEGORIES[category].instructions } };
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
    MapUI.clearTempMarker();
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
    div.innerHTML = cardHeadHTML(h) + `<p class="hint-card__waiting">⏳ Várakozás a bujkálóra…</p>`;
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
