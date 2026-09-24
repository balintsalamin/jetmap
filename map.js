// map.js — Leaflet térkép létrehozása és a keresők/segítségek megjelenítése.
// A globális `L` a Leaflet CDN <script>-ből érkezik (lásd index.html).

import { milesToMeters } from "./geo.js";

const COLOR_MATCH = "#ff9d42"; // borostyán — bujkálóhoz kötött / pozitív találat
const COLOR_SEEKER = "#4fd7e0"; // cián — kereső jelölő / keresőkhöz kötött
const COLOR_NOMATCH = "#5b6b78"; // tompa szürkéskék — kizárt terület / negatív találat

let currentMap = null;
let seekerMarkers = new Map(); // uid -> L.CircleMarker
let hintLayer = null;
let tempPickMarker = null;

const DEFAULT_CENTER = [47.4979, 19.0402]; // Budapest — csak amíg nincs GPS-fix

export function createMap(elId) {
  currentMap = L.map(elId, { zoomControl: true, attributionControl: true }).setView(DEFAULT_CENTER, 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap közreműködők",
  }).addTo(currentMap);
  hintLayer = L.layerGroup().addTo(currentMap);
  seekerMarkers = new Map();
  tempPickMarker = null;
  return currentMap;
}

export function destroyMap() {
  if (currentMap) currentMap.remove();
  currentMap = null;
  hintLayer = null;
  seekerMarkers = new Map();
  tempPickMarker = null;
}

export function centerMapOnce(pos, zoom = 15) {
  if (currentMap && pos) currentMap.setView([pos.lat, pos.lng], zoom);
}

export function pickPointOnMap() {
  return new Promise((resolve) => {
    if (!currentMap) {
      resolve(null);
      return;
    }
    currentMap.getContainer().classList.add("picking");
    currentMap.once("click", (e) => {
      currentMap.getContainer().classList.remove("picking");
      resolve({ lat: e.latlng.lat, lng: e.latlng.lng });
    });
  });
}

export function setTempMarker(lat, lng, label) {
  if (!currentMap) return;
  if (tempPickMarker) currentMap.removeLayer(tempPickMarker);
  tempPickMarker = L.marker([lat, lng]).addTo(currentMap);
  if (label) tempPickMarker.bindTooltip(label, { permanent: false });
}

export function clearTempMarker() {
  if (tempPickMarker && currentMap) currentMap.removeLayer(tempPickMarker);
  tempPickMarker = null;
}

/** A keresők élő pozíciója — mindenki látja (a bujkálóé sosem kerül ide). */
export function renderSeekerMarkers(players) {
  if (!currentMap) return;
  const seen = new Set();
  players
    .filter((p) => p.role === "seeker" && p.lastLocation)
    .forEach((p) => {
      seen.add(p.uid);
      const latlng = [p.lastLocation.lat, p.lastLocation.lng];
      if (seekerMarkers.has(p.uid)) {
        seekerMarkers.get(p.uid).setLatLng(latlng);
      } else {
        const marker = L.circleMarker(latlng, {
          radius: 9,
          color: COLOR_SEEKER,
          weight: 2,
          fillColor: COLOR_SEEKER,
          fillOpacity: 0.85,
        })
          .addTo(currentMap)
          .bindTooltip(p.name, { permanent: true, direction: "top", className: "map-label", offset: [0, -6] });
        seekerMarkers.set(p.uid, marker);
      }
    });
  for (const [uid, marker] of seekerMarkers.entries()) {
    if (!seen.has(uid)) {
      currentMap.removeLayer(marker);
      seekerMarkers.delete(uid);
    }
  }
}

// ---------------------------------------------------------------------------
// Segítség-átfedések (csak megválaszolt kérésekre)
// ---------------------------------------------------------------------------

export function renderHintOverlays(hints) {
  if (!currentMap || !hintLayer) return;
  hintLayer.clearLayers();
  hints
    .filter((h) => h.status === "answered" && h.answer && !h.answer.noData)
    .forEach((h) => {
      try {
        if (h.type === "radar") drawRadar(h);
        else if (h.type === "thermometer") drawThermometer(h);
        else if (h.type === "measuring" || h.type === "matching") drawComparisonOverlay(h);
        else if (h.type === "tentacle") drawTentacle(h);
      } catch {
        /* egy hibás bejegyzés ne akassza meg a többi rajzolását */
      }
    });
}

function requestMarker(loc, label) {
  L.circleMarker([loc.lat, loc.lng], { radius: 5, color: "#e7edf2", weight: 2, fillColor: "#e7edf2", fillOpacity: 1 })
    .bindTooltip(label)
    .addTo(hintLayer);
}

function drawRadar(hint) {
  const { params, answer } = hint;
  const center = params.seekerLocation;
  const radiusM = milesToMeters(params.miles);
  const positive = answer.within;
  L.circle([center.lat, center.lng], {
    radius: radiusM,
    color: positive ? COLOR_MATCH : COLOR_NOMATCH,
    weight: 2,
    dashArray: positive ? null : "4 6",
    fillColor: positive ? COLOR_MATCH : COLOR_NOMATCH,
    fillOpacity: positive ? 0.2 : 0.06,
  })
    .bindTooltip(`${positive ? "Belül" : "Kívül"} — ${params.milesLabel}`)
    .addTo(hintLayer);
  requestMarker(center, `${hint.requestedByName} — kérés helye`);
}

function drawThermometer(hint) {
  const { params, answer } = hint;
  L.marker([params.a.lat, params.a.lng]).bindTooltip("A pont").addTo(hintLayer);
  L.marker([params.b.lat, params.b.lng]).bindTooltip("B pont").addTo(hintLayer);
  L.polyline([params.a, params.b], { color: "#e7edf2", weight: 1, dashArray: "3 5" }).addTo(hintLayer);
  const { p1, p2 } = answer.bisector;
  L.polyline([p1, p2], { color: COLOR_MATCH, weight: 3 }).addTo(hintLayer);
  if (answer.coldPolygon) {
    L.polygon(answer.coldPolygon, { color: COLOR_NOMATCH, weight: 0, fillColor: COLOR_NOMATCH, fillOpacity: 0.15 }).addTo(hintLayer);
  }
}

/** Közös rajzoló Egyezéshez és Méréshez — mindkettő {hiderNearest, seekerNearest} alakot ad. */
function drawComparisonOverlay(hint) {
  const { params, answer } = hint;
  if (params.seekerLocation) requestMarker(params.seekerLocation, `${hint.requestedByName} — kérés helye`);
  if (answer.hiderNearest?.lat != null) {
    L.circleMarker([answer.hiderNearest.lat, answer.hiderNearest.lng], {
      radius: 7,
      color: COLOR_MATCH,
      weight: 2,
      fillColor: COLOR_MATCH,
      fillOpacity: 0.55,
    })
      .bindTooltip(`Bujkáló legközelebbije: ${answer.hiderNearest.name}`)
      .addTo(hintLayer);
  }
  if (answer.seekerNearest?.lat != null) {
    L.circleMarker([answer.seekerNearest.lat, answer.seekerNearest.lng], {
      radius: 7,
      color: COLOR_SEEKER,
      weight: 2,
      fillColor: COLOR_SEEKER,
      fillOpacity: 0.55,
    })
      .bindTooltip(`Ti legközelebbi: ${answer.seekerNearest.name}`)
      .addTo(hintLayer);
  }
}

function drawTentacle(hint) {
  const { params, answer } = hint;
  const center = params.seekerLocation;
  const radiusM = milesToMeters(params.radiusMiles);
  L.circle([center.lat, center.lng], {
    radius: radiusM,
    color: answer.inReach ? COLOR_MATCH : COLOR_NOMATCH,
    weight: 2,
    dashArray: answer.inReach ? null : "4 6",
    fillColor: answer.inReach ? COLOR_MATCH : COLOR_NOMATCH,
    fillOpacity: answer.inReach ? 0.16 : 0.05,
  }).addTo(hintLayer);
  requestMarker(center, `${hint.requestedByName} — kérés helye`);
  if (answer.inReach && answer.lat != null) {
    L.circleMarker([answer.lat, answer.lng], { radius: 7, color: COLOR_MATCH, weight: 2, fillColor: COLOR_MATCH, fillOpacity: 0.6 })
      .bindTooltip(answer.name)
      .addTo(hintLayer);
  }
}
