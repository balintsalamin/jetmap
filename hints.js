// hints.js — a segítségkérések (rádár / hőmérő / mérés / egyezés / egyéni)
// beküldése, élő szinkronja, és az automatikus válaszszámítás a bujkáló
// valós helyzete alapján.
//
// FONTOS: a bujkáló nyers GPS-koordinátája SOHA nem kerül fel a Firestore-ba.
// A választ mindig a bujkáló saját böngészője számolja ki helyben (a saját,
// csak nála elérhető pozíciójából), és csak a KÉSZ választ küldi el.

import {
  doc,
  addDoc,
  updateDoc,
  collection,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { db } from "./firebase-config.js";
import { state } from "./state.js";
import {
  distanceMeters,
  formatDistance,
  perpendicularBisector,
  colderHalfPlanePolygon,
  nearestOfCategory,
  MATCHING_CATEGORIES,
} from "./geo.js";

// Rádár gyűrűtávolságok (méterben) — közelítő értékek a publikus leírások
// alapján, nem az eredeti kártyák szó szerinti szövege. Ha a fizikai
// dobozodban más számok szerepelnek, itt bátran módosítsd őket.
export const RADAR_PRESETS = {
  kicsi: { label: "Kicsi (városrész)", ringsMeters: [500, 1000, 2000, 4000] },
  kozepes: { label: "Közepes (város)", ringsMeters: [1000, 3000, 6000, 12000] },
  nagy: { label: "Nagy (régió / ország)", ringsMeters: [5000, 15000, 30000, 60000] },
};

export function radarBandIndex(distance, rings) {
  for (let i = 0; i < rings.length; i++) {
    if (distance <= rings[i]) return i;
  }
  return rings.length; // hatótávolságon kívül
}

export function radarBandLabel(bandIndex, rings) {
  if (bandIndex === 0) return `0 – ${formatDistance(rings[0])}`;
  if (bandIndex === rings.length) {
    return `${formatDistance(rings[rings.length - 1])}-en túl`;
  }
  return `${formatDistance(rings[bandIndex - 1])} – ${formatDistance(rings[bandIndex])}`;
}

function roundDistance(meters) {
  const step = meters < 2000 ? 50 : meters < 20000 ? 500 : 5000;
  return Math.round(meters / step) * step;
}

// ---------------------------------------------------------------------------
// Beküldés / élő lista
// ---------------------------------------------------------------------------

export async function requestHint(code, type, params) {
  await addDoc(collection(db, "lobbies", code, "hints"), {
    type,
    requestedBy: state.uid,
    requestedByName: state.name,
    params,
    status: "pending",
    answer: null,
    createdAt: serverTimestamp(),
    answeredAt: null,
  });
}

// Megjegyzés: ez a leiratkozó FÜGGETLEN a state.unsubscribers listától, mert
// köre a játékkörhöz kötött (nem a teljes lobbyhoz) — a hívó (app.js) tárolja
// és állítja le kör végén, a lobby/players feliratkozások érintetlenül hagyása mellett.
export function subscribeHints(code, onChange) {
  const q = query(collection(db, "lobbies", code, "hints"), orderBy("createdAt", "asc"));
  return onSnapshot(q, (snap) => {
    const hints = [];
    snap.forEach((d) => hints.push({ id: d.id, ...d.data() }));
    onChange(hints);
  });
}

export async function submitAnswer(code, hintId, answer) {
  await updateDoc(doc(db, "lobbies", code, "hints", hintId), {
    status: "answered",
    answer,
    answeredAt: serverTimestamp(),
  });
}

// ---------------------------------------------------------------------------
// Automatikus válaszszámítás — ezt csak a bujkáló böngészője futtatja,
// a saját (helyi) pozíciójával.
// ---------------------------------------------------------------------------

export async function computeSuggestedAnswer(hint, hiderPos) {
  if (!hiderPos) return null;
  const { type, params } = hint;

  if (type === "radar") {
    const rings = RADAR_PRESETS[params.preset]?.ringsMeters || RADAR_PRESETS.kozepes.ringsMeters;
    const distance = distanceMeters(hiderPos.lat, hiderPos.lng, params.lat, params.lng);
    const bandIndex = radarBandIndex(distance, rings);
    return {
      bandIndex,
      ringsMeters: rings,
      label: radarBandLabel(bandIndex, rings),
    };
  }

  if (type === "thermometer") {
    const distA = distanceMeters(hiderPos.lat, hiderPos.lng, params.a.lat, params.a.lng);
    const distB = distanceMeters(hiderPos.lat, hiderPos.lng, params.b.lat, params.b.lng);
    const result = distB < distA ? "melegebb" : distB > distA ? "hidegebb" : "ugyanolyan";
    const colderIsA = distA > distB;
    const { p1, p2 } = perpendicularBisector(params.a, params.b, 150000);
    return {
      result,
      warmerSide: distA < distB ? "a" : "b",
      bisector: { p1, p2 },
      coldPolygon: colderHalfPlanePolygon(params.a, params.b, colderIsA, p1, p2).map((pt) => [
        pt.lat,
        pt.lng,
      ]),
    };
  }

  if (type === "measuring") {
    const distance = distanceMeters(hiderPos.lat, hiderPos.lng, params.lat, params.lng);
    return { distance, rounded: roundDistance(distance) };
  }

  if (type === "matching") {
    const [hiderNearest, refNearest] = await Promise.all([
      nearestOfCategory(hiderPos.lat, hiderPos.lng, params.category),
      nearestOfCategory(params.lat, params.lng, params.category),
    ]);
    const same = !!(
      hiderNearest &&
      refNearest &&
      hiderNearest.name === refNearest.name &&
      hiderNearest.name !== "(névtelen)"
    );
    return { hiderNearest, refNearest, same };
  }

  return null; // 'custom' típusnál a bujkáló maga gépeli be a választ
}

export function matchingCategoryLabel(key) {
  return MATCHING_CATEGORIES[key]?.label || key;
}
