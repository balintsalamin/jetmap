// geo.js — földrajzi számítások és helymeghatározási segédfüggvények
// Ez a fájl nem nyúl a DOM-hoz, tisztán számítási/hálózati segédfüggvényeket tartalmaz.

const EARTH_RADIUS_M = 6371000;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Két koordináta közti távolság méterben (haversine képlet). */
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/** Ember-barát távolság-formázás magyarul ("650 m", "3,2 km"). */
export function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km.toFixed(km < 10 ? 1 : 0).replace(".", ",")} km`;
}

/**
 * Sík közelítés méter/fok átváltáshoz — kis-közepes (városi/országos) léptékben
 * elég pontos, nem veszi figyelembe a Föld görbületét nagy (kontinentális) távokon.
 */
export function metersPerDeg(lat) {
  const latRad = toRad(lat);
  return {
    lat: 111320,
    lng: 111320 * Math.cos(latRad),
  };
}

/** Egy pont eltolása kelet/észak irányban méterben (negatív = nyugat/dél). */
export function offsetPoint(lat, lng, dEastMeters, dNorthMeters) {
  const mpd = metersPerDeg(lat);
  return {
    lat: lat + dNorthMeters / mpd.lat,
    lng: lng + dEastMeters / mpd.lng,
  };
}

/**
 * A és B pont felező merőlegesének két végpontja — ez a vonal osztja ketté
 * a térképet "melegebb" / "hidegebb" félre a Hőmérő (Thermometer) segítségnél.
 */
export function perpendicularBisector(a, b, halfLengthMeters = 50000) {
  const midLat = (a.lat + b.lat) / 2;
  const midLng = (a.lng + b.lng) / 2;
  const mpd = metersPerDeg(midLat);

  const dx = (b.lng - a.lng) * mpd.lng;
  const dy = (b.lat - a.lat) * mpd.lat;
  const len = Math.hypot(dx, dy) || 1;
  // 90°-kal elforgatott, normalizált irányvektor
  const perpX = -dy / len;
  const perpY = dx / len;

  const p1 = {
    lat: midLat + (perpY * halfLengthMeters) / mpd.lat,
    lng: midLng + (perpX * halfLengthMeters) / mpd.lng,
  };
  const p2 = {
    lat: midLat - (perpY * halfLengthMeters) / mpd.lat,
    lng: midLng - (perpX * halfLengthMeters) / mpd.lng,
  };
  return { p1, p2, mid: { lat: midLat, lng: midLng } };
}

/**
 * A hidegebb (távolabbi) fél térképfelületét lefedő nagy sokszög — ezt
 * satírozzuk be a Hőmérő válasz megjelenítésekor. A p1/p2 pontokat kívülről
 * kapja (ugyanaz a vonal, amit ki is rajzolunk), hogy a satírozás pontosan
 * a berajzolt vágóvonalból induljon.
 * `colderIsA`: true, ha az A pont van messzebb a bujkálótól.
 */
export function colderHalfPlanePolygon(a, b, colderIsA, p1, p2, farExtendMeters = 400000) {
  const midLat = (a.lat + b.lat) / 2;
  const mpd = metersPerDeg(midLat);
  const dx = (b.lng - a.lng) * mpd.lng;
  const dy = (b.lat - a.lat) * mpd.lat;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const dir = colderIsA ? -1 : 1; // A felé told, ha A a hidegebb, egyébként B felé
  const far1 = offsetPoint(p1.lat, p1.lng, ux * farExtendMeters * dir, uy * farExtendMeters * dir);
  const far2 = offsetPoint(p2.lat, p2.lng, ux * farExtendMeters * dir, uy * farExtendMeters * dir);
  return [p1, far1, far2, p2];
}

/** Böngésző GPS helyzet lekérése egyszer (Promise-ba csomagolva). */
export function getCurrentPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Ez az eszköz nem támogatja a helymeghatározást."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000, ...options }
    );
  });
}

/** Folyamatos helyzetkövetés indítása, callback-et hív minden frissítésnél. */
export function watchPosition(onUpdate, onError) {
  if (!navigator.geolocation) {
    onError?.(new Error("Ez az eszköz nem támogatja a helymeghatározást."));
    return null;
  }
  return navigator.geolocation.watchPosition(
    (pos) =>
      onUpdate({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
    (err) => onError?.(err),
    { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 }
  );
}

export function clearWatch(id) {
  if (id != null) navigator.geolocation.clearWatch(id);
}

// ---------------------------------------------------------------------------
// Helyszín-keresés (Nominatim) — egy hely nevének begépelésekor koordinátát ad
// ---------------------------------------------------------------------------

export async function searchPlace(query) {
  if (!query || query.trim().length < 2) return [];
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(
    query
  )}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error("A helykeresés nem sikerült.");
  const data = await res.json();
  return data.map((d) => ({
    label: d.display_name,
    lat: parseFloat(d.lat),
    lng: parseFloat(d.lon),
  }));
}

// ---------------------------------------------------------------------------
// Overpass (OpenStreetMap) — "legközelebbi X típusú hely" kereséshez, ez adja
// az automatikus Egyezés (Matching) találós kérdés alapját.
// ---------------------------------------------------------------------------

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

/** category -> { label, tagFilter (Overpass QL), radiusMeters } */
export const MATCHING_CATEGORIES = {
  vasutallomas: {
    label: "Legközelebbi vasútállomás",
    filter: '["railway"~"station|halt"]',
    radius: 30000,
  },
  repuloter: {
    label: "Legközelebbi (kereskedelmi) repülőtér",
    filter: '["aeroway"="aerodrome"]',
    radius: 150000,
  },
  park: {
    label: "Legközelebbi park",
    filter: '["leisure"="park"]',
    radius: 8000,
  },
  muzeum: {
    label: "Legközelebbi múzeum",
    filter: '["tourism"="museum"]',
    radius: 25000,
  },
  allatkert: {
    label: "Legközelebbi állatkert",
    filter: '["tourism"="zoo"]',
    radius: 150000,
  },
  korhaz: {
    label: "Legközelebbi kórház",
    filter: '["amenity"="hospital"]',
    radius: 25000,
  },
};

function buildOverpassQuery(lat, lng, radius, filter) {
  return `
    [out:json][timeout:20];
    (
      node${filter}(around:${radius},${lat},${lng});
      way${filter}(around:${radius},${lat},${lng});
      relation${filter}(around:${radius},${lat},${lng});
    );
    out center tags;
  `;
}

/**
 * A megadott ponthoz legközelebbi, a kategóriának megfelelő OSM elemet adja
 * vissza. "Legjobb próbálkozás" jellegű — az OpenStreetMap adatminősége
 * helyenként eltérő, ezért a névvel együtt mutasd meg a keresőnek, hogy
 * ránézésre ellenőrizhető legyen.
 */
export async function nearestOfCategory(lat, lng, categoryKey) {
  const cat = MATCHING_CATEGORIES[categoryKey];
  if (!cat) throw new Error("Ismeretlen kategória.");
  const query = buildOverpassQuery(lat, lng, cat.radius, cat.filter);
  const res = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    body: "data=" + encodeURIComponent(query),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error("Az Overpass-lekérdezés nem sikerült.");
  const data = await res.json();
  let best = null;
  let bestDist = Infinity;
  for (const el of data.elements || []) {
    const elLat = el.lat ?? el.center?.lat;
    const elLng = el.lon ?? el.center?.lon;
    if (elLat == null || elLng == null) continue;
    const name = el.tags?.name || el.tags?.["name:hu"] || "(névtelen)";
    const d = distanceMeters(lat, lng, elLat, elLng);
    if (d < bestDist) {
      bestDist = d;
      best = { name, lat: elLat, lng: elLng, distance: d };
    }
  }
  return best; // null, ha nem talált semmit a sugáron belül
}
