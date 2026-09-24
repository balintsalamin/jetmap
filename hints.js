// hints.js — segítségkérések beküldése/élő szinkronja és az automatikus
// válaszszámítás a hivatalos (lifack.ch) szabályok szerint.
//
// FONTOS: a bujkáló nyers GPS-koordinátája SOHA nem kerül fel a Firestore-ba.
// A választ mindig a bujkáló saját böngészője számolja ki helyben, és csak a
// KÉSZ eredményt küldi el.

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
  milesToMeters,
  perpendicularBisector,
  colderHalfPlanePolygon,
  nearestOfCategory,
  nearestDistanceToLineFeature,
  nearestNamedWay,
  reverseGeocode,
  adminDivisionValue,
  MEASURING_CATEGORIES,
  MATCHING_CATEGORIES,
  TENTACLE_CATEGORIES,
} from "./geo.js";

// Mérföld-opciók a hivatalos kártyák szerint.
export const RADAR_DISTANCES_MILES = [0.25, 0.5, 1, 3, 5, 10, 25, 50, 100];
export const THERMOMETER_DISTANCES = [
  { miles: 0.5, tier: "kicsi" },
  { miles: 3, tier: "kicsi" },
  { miles: 10, tier: "kozepes" },
  { miles: 50, tier: "nagy" },
];

// Kártyahúzás-emlékeztető (csak tájékoztató szöveg, az app nem kezeli a paklit).
export const CARD_INFO = {
  radar: { draw: 2, keep: 1 },
  thermometer: { draw: 2, keep: 1 },
  measuring: { draw: 3, keep: 1 },
  matching: { draw: 3, keep: 1 },
  tentacle: { draw: 4, keep: 2 },
  photo: { draw: 1, keep: 1 },
  custom: null,
};

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
// Automatikus válaszszámítás — ezt csak a bujkáló böngészője futtatja.
// hiderPos: a bujkáló saját, helyi pozíciója. Visszaadhat null-t, ha a
// kategória nem automatizálható (pl. Jelenlegi járat vonala) — ilyenkor az
// UI kézi (szöveges) válaszadásra vált.
// ---------------------------------------------------------------------------

export async function computeSuggestedAnswer(hint, hiderPos) {
  if (!hiderPos) return null;
  const { type, params } = hint;

  if (type === "radar") {
    const distance = distanceMeters(hiderPos.lat, hiderPos.lng, params.seekerLocation.lat, params.seekerLocation.lng);
    const rangeMeters = milesToMeters(params.miles);
    return { within: distance <= rangeMeters, distance };
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
      travelledMeters: distanceMeters(params.a.lat, params.a.lng, params.b.lat, params.b.lng),
      bisector: { p1, p2 },
      coldPolygon: colderHalfPlanePolygon(params.a, params.b, colderIsA, p1, p2).map((pt) => [pt.lat, pt.lng]),
    };
  }

  if (type === "measuring") {
    const cat = MEASURING_CATEGORIES[params.category];
    if (!cat) return null;
    const seeker = params.seekerLocation;

    if (cat.kind === "manual-altitude") return null; // ezt a hider kézzel adja meg (app.js)

    if (cat.kind === "point") {
      const [hiderNearest, seekerNearest] = await Promise.all([
        nearestOfCategory(hiderPos.lat, hiderPos.lng, cat),
        nearestOfCategory(seeker.lat, seeker.lng, cat),
      ]);
      if (!hiderNearest || !seekerNearest) return { noData: true };
      return {
        hiderDistance: hiderNearest.distance,
        seekerDistance: seekerNearest.distance,
        closer: hiderNearest.distance < seekerNearest.distance,
        hiderNearest,
        seekerNearest,
      };
    }

    if (cat.kind === "line") {
      const [hiderResult, seekerResult] = await Promise.all([
        nearestDistanceToLineFeature(hiderPos.lat, hiderPos.lng, cat.filter, cat.radius),
        nearestDistanceToLineFeature(seeker.lat, seeker.lng, cat.filter, cat.radius),
      ]);
      if (!hiderResult || !seekerResult) return { noData: true };
      return {
        hiderDistance: hiderResult.distance,
        seekerDistance: seekerResult.distance,
        closer: hiderResult.distance < seekerResult.distance,
        hiderNearest: { name: cat.label, lat: hiderResult.point.lat, lng: hiderResult.point.lng },
        seekerNearest: { name: cat.label, lat: seekerResult.point.lat, lng: seekerResult.point.lng },
      };
    }

    return null;
  }

  if (type === "matching") {
    const cat = MATCHING_CATEGORIES[params.category];
    if (!cat) return null;
    const seeker = params.seekerLocation;

    if (cat.kind === "unsupported") return null;

    if (cat.kind === "point") {
      const [hiderNearest, seekerNearest] = await Promise.all([
        nearestOfCategory(hiderPos.lat, hiderPos.lng, cat),
        nearestOfCategory(seeker.lat, seeker.lng, cat),
      ]);
      const same = !!(hiderNearest && seekerNearest && hiderNearest.name === seekerNearest.name && hiderNearest.name !== "(névtelen)");
      return { hiderNearest, seekerNearest, same };
    }

    if (cat.kind === "derived-length") {
      const [hiderNearest, seekerNearest] = await Promise.all([
        nearestOfCategory(hiderPos.lat, hiderPos.lng, cat),
        nearestOfCategory(seeker.lat, seeker.lng, cat),
      ]);
      if (!hiderNearest || !seekerNearest) return { noData: true };
      const same = hiderNearest.name.length === seekerNearest.name.length;
      return { hiderNearest, seekerNearest, same, hiderLength: hiderNearest.name.length, seekerLength: seekerNearest.name.length };
    }

    if (cat.kind === "named-way") {
      const [hiderWay, seekerWay] = await Promise.all([
        nearestNamedWay(hiderPos.lat, hiderPos.lng, cat.radius),
        nearestNamedWay(seeker.lat, seeker.lng, cat.radius),
      ]);
      if (!hiderWay || !seekerWay) return { noData: true };
      const same = hiderWay.name === seekerWay.name;
      return { same, hiderNearest: { name: hiderWay.name }, seekerNearest: { name: seekerWay.name } };
    }

    if (cat.kind === "admin-area") {
      const [hiderAddr, seekerAddr] = await Promise.all([
        reverseGeocode(hiderPos.lat, hiderPos.lng),
        reverseGeocode(seeker.lat, seeker.lng),
      ]);
      const hiderVal = adminDivisionValue(hiderAddr, cat.level);
      const seekerVal = adminDivisionValue(seekerAddr, cat.level);
      if (!hiderVal || !seekerVal) return { noData: true };
      const same = hiderVal === seekerVal;
      return { same, hiderNearest: { name: hiderVal }, seekerNearest: { name: seekerVal } };
    }

    return null;
  }

  if (type === "tentacle") {
    const cat = TENTACLE_CATEGORIES[params.category];
    if (!cat || cat.kind === "unsupported") return null;
    const radiusM = milesToMeters(cat.radiusMiles);
    const hiderNearest = await nearestOfCategory(hiderPos.lat, hiderPos.lng, { filter: cat.filter, radius: radiusM });
    if (!hiderNearest || hiderNearest.distance > radiusM) return { inReach: false };
    const seekerDist = distanceMeters(params.seekerLocation.lat, params.seekerLocation.lng, hiderNearest.lat, hiderNearest.lng);
    if (seekerDist > radiusM) return { inReach: false };
    return { inReach: true, name: hiderNearest.name, lat: hiderNearest.lat, lng: hiderNearest.lng, distance: hiderNearest.distance };
  }

  return null; // 'photo' és 'custom' — a bujkáló mindig kézzel válaszol
}
