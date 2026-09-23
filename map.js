// map.js — Leaflet térkép létrehozása és a keresők/segítségek megjelenítése.
// A globális `L` a Leaflet CDN <script>-ből érkezik (lásd index.html).

const COLOR_MATCH = "#ff9d42"; // borostyán — a helyes/találó sáv
const COLOR_NOMATCH = "#5b6b78"; // tompa szürkéskék — kizárt terület
const COLOR_SEEKER = "#4fd7e0"; // cián — kereső jelölő

let currentMap = null;
let seekerMarkers = new Map(); // uid -> L.CircleMarker
let hintLayer = null; // L.LayerGroup a segítség-átfedéseknek
let tempPickMarker = null;

const DEFAULT_CENTER = [47.4979, 19.0402]; // Budapest — csak amíg nincs GPS-fix

export function createMap(elId) {
  currentMap = L.map(elId, { zoomControl: true, attributionControl: true }).setView(
    DEFAULT_CENTER,
    13
  );
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

/** Egy pont kiválasztása térképkattintással — Promise-t ad vissza. */
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

/** A keresők élő pozíciója — a lobby minden tagja látja (a bujkálóé sosem kerül ide). */
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
          .bindTooltip(p.name, {
            permanent: true,
            direction: "top",
            className: "map-label",
            offset: [0, -6],
          });
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
    .filter((h) => h.status === "answered" && h.answer)
    .forEach((h) => {
      try {
        if (h.type === "radar") drawRadar(h);
        else if (h.type === "thermometer") drawThermometer(h);
        else if (h.type === "measuring") drawMeasuring(h);
        else if (h.type === "matching") drawMatching(h);
      } catch {
        /* egy hibás bejegyzés ne akassza meg a többi rajzolását */
      }
    });
}

function drawRadar(hint) {
  const { params, answer } = hint;
  const rings = answer.ringsMeters;
  const matchIndex = answer.bandIndex;

  L.circleMarker([params.lat, params.lng], {
    radius: 5,
    color: "#e7edf2",
    weight: 2,
    fillColor: "#e7edf2",
    fillOpacity: 1,
  })
    .bindTooltip(params.label || "Rádár középpont")
    .addTo(hintLayer);

  // Nagytól a kicsi felé rajzolva minden kisebb kör "kilyukasztja" a nagyobbat,
  // így pontosan a helyes gyűrűsáv marad kiszínezve — lásd geo.js megjegyzés.
  for (let i = rings.length - 1; i >= 0; i--) {
    const isMatch = i === matchIndex;
    L.circle([params.lat, params.lng], {
      radius: rings[i],
      color: isMatch ? COLOR_MATCH : COLOR_NOMATCH,
      weight: isMatch ? 2 : 1,
      dashArray: isMatch ? null : "4 5",
      fillColor: isMatch ? COLOR_MATCH : COLOR_NOMATCH,
      fillOpacity: isMatch ? 0.28 : 0.07,
    }).addTo(hintLayer);
  }

  if (matchIndex === rings.length) {
    L.circle([params.lat, params.lng], {
      radius: rings[rings.length - 1],
      color: COLOR_MATCH,
      weight: 3,
      dashArray: "2 6",
      fill: false,
    })
      .bindTooltip("A bujkáló ezen a körön kívül van")
      .addTo(hintLayer);
  }
}

function drawThermometer(hint) {
  const { params, answer } = hint;
  const a = params.a;
  const b = params.b;

  L.marker([a.lat, a.lng]).bindTooltip("A pont").addTo(hintLayer);
  L.marker([b.lat, b.lng]).bindTooltip("B pont").addTo(hintLayer);
  L.polyline([a, b], { color: "#e7edf2", weight: 1, dashArray: "3 5" }).addTo(hintLayer);

  const { p1, p2 } = answer.bisector;
  L.polyline([p1, p2], { color: COLOR_MATCH, weight: 3 }).addTo(hintLayer);

  // A colderHalfPlanePolygon-t map.js nem importálja geo-ból (elkerülve a
  // körkörös függést) — helyette a hint mentése előtt kiszámolt sarokpontokat
  // várjuk az answer.coldPolygon mezőben, ha app.js azt is elmentette.
  if (answer.coldPolygon) {
    L.polygon(answer.coldPolygon, {
      color: COLOR_NOMATCH,
      weight: 0,
      fillColor: COLOR_NOMATCH,
      fillOpacity: 0.15,
    }).addTo(hintLayer);
  }
}

function drawMeasuring(hint) {
  const { params, answer } = hint;
  L.marker([params.lat, params.lng]).bindTooltip(params.label || "Mérési pont").addTo(hintLayer);
  L.circle([params.lat, params.lng], {
    radius: answer.distance,
    color: COLOR_MATCH,
    weight: 2,
    fill: false,
  }).addTo(hintLayer);
}

function drawMatching(hint) {
  const { answer } = hint;
  if (answer.hiderNearest) {
    L.circleMarker([answer.hiderNearest.lat, answer.hiderNearest.lng], {
      radius: 7,
      color: answer.same ? COLOR_MATCH : COLOR_NOMATCH,
      fillColor: answer.same ? COLOR_MATCH : COLOR_NOMATCH,
      fillOpacity: 0.6,
    })
      .bindTooltip(`Bujkáló legközelebbije: ${answer.hiderNearest.name}`)
      .addTo(hintLayer);
  }
  if (answer.refNearest) {
    L.circleMarker([answer.refNearest.lat, answer.refNearest.lng], {
      radius: 7,
      color: "#e7edf2",
      fillColor: "#e7edf2",
      fillOpacity: 0.4,
    })
      .bindTooltip(`Referenciapont legközelebbije: ${answer.refNearest.name}`)
      .addTo(hintLayer);
  }
}
