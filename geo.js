// geo.js — földrajzi számítások, helymeghatározás és OpenStreetMap lekérdezések
// Ez a fájl nem nyúl a DOM-hoz, tisztán számítási/hálózati segédfüggvényeket tartalmaz.

const EARTH_RADIUS_M = 6371000;
export const MILE_M = 1609.344;
const toRad = (deg) => (deg * Math.PI) / 180;

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

export function milesToMeters(miles) {
  return miles * MILE_M;
}

/** Ember-barát távolság-formázás — mérföld az elsődleges (a fizikai kártyák
 * is mérföldben vannak), zárójelben a metrikus érték magyar közönségnek. */
export function formatDistance(meters) {
  const miles = meters / MILE_M;
  const milesStr = (miles < 10 ? miles.toFixed(2) : miles < 100 ? miles.toFixed(1) : Math.round(miles)).toString().replace(".", ",");
  const metric = meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1).replace(".", ",")} km`;
  return `${milesStr} mérföld (${metric})`;
}

export function formatMiles(miles) {
  return miles < 1 ? `${miles.toString().replace(".", ",")} mérföld` : `${miles} mérföld`;
}

function metersPerDeg(lat) {
  const latRad = toRad(lat);
  return { lat: 111320, lng: 111320 * Math.cos(latRad) };
}

export function offsetPoint(lat, lng, dEastMeters, dNorthMeters) {
  const mpd = metersPerDeg(lat);
  return { lat: lat + dNorthMeters / mpd.lat, lng: lng + dEastMeters / mpd.lng };
}

/** A és B pont felező merőlegesének két végpontja — a Hőmérő vágóvonalához. */
export function perpendicularBisector(a, b, halfLengthMeters = 150000) {
  const midLat = (a.lat + b.lat) / 2;
  const midLng = (a.lng + b.lng) / 2;
  const mpd = metersPerDeg(midLat);
  const dx = (b.lng - a.lng) * mpd.lng;
  const dy = (b.lat - a.lat) * mpd.lat;
  const len = Math.hypot(dx, dy) || 1;
  const perpX = -dy / len;
  const perpY = dx / len;
  const p1 = { lat: midLat + (perpY * halfLengthMeters) / mpd.lat, lng: midLng + (perpX * halfLengthMeters) / mpd.lng };
  const p2 = { lat: midLat - (perpY * halfLengthMeters) / mpd.lat, lng: midLng - (perpX * halfLengthMeters) / mpd.lng };
  return { p1, p2, mid: { lat: midLat, lng: midLng } };
}

export function colderHalfPlanePolygon(a, b, colderIsA, p1, p2, farExtendMeters = 400000) {
  const midLat = (a.lat + b.lat) / 2;
  const mpd = metersPerDeg(midLat);
  const dx = (b.lng - a.lng) * mpd.lng;
  const dy = (b.lat - a.lat) * mpd.lat;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const dir = colderIsA ? -1 : 1;
  const far1 = offsetPoint(p1.lat, p1.lng, ux * farExtendMeters * dir, uy * farExtendMeters * dir);
  const far2 = offsetPoint(p2.lat, p2.lng, ux * farExtendMeters * dir, uy * farExtendMeters * dir);
  return [p1, far1, far2, p2];
}

// ---------------------------------------------------------------------------
// Helymeghatározás
// ---------------------------------------------------------------------------

export function getCurrentPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Ez az eszköz nem támogatja a helymeghatározást."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000, ...options }
    );
  });
}

export function watchPosition(onUpdate, onError) {
  if (!navigator.geolocation) {
    onError?.(new Error("Ez az eszköz nem támogatja a helymeghatározást."));
    return null;
  }
  return navigator.geolocation.watchPosition(
    (pos) => onUpdate({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
    (err) => onError?.(err),
    { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 }
  );
}

export function clearWatch(id) {
  if (id != null) navigator.geolocation.clearWatch(id);
}

// ---------------------------------------------------------------------------
// Helyszín-keresés (Nominatim)
// ---------------------------------------------------------------------------

export async function searchPlace(query) {
  if (!query || query.trim().length < 2) return [];
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("A helykeresés nem sikerült.");
  const data = await res.json();
  return data.map((d) => ({ label: d.display_name, lat: parseFloat(d.lat), lng: parseFloat(d.lon) }));
}

/**
 * Visszakeresi egy pont közigazgatási cím-összetevőit (ország, megye,
 * település stb.) — a Közigazgatási egység Egyezés kérdésekhez.
 * A mezőnevek Nominatim generikus admin_level-hierarchiáját követik;
 * országonként (így Magyarországon is) lehet kisebb eltérés, ezért ez a
 * kategória mindig "approx" jelzéssel fut.
 */
export async function reverseGeocode(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("A cím-visszakeresés nem sikerült.");
  const data = await res.json();
  return data.address || {};
}

/** level: 1 (legnagyobb, pl. megye) .. 4 (legkisebb, pl. kerület) */
export function adminDivisionValue(address, level) {
  if (!address) return null;
  if (level === 1) return address.state || address.county || address.region || null;
  if (level === 2) return address.state_district || address.county || null;
  if (level === 3) return address.city || address.town || address.municipality || address.village || null;
  if (level === 4) return address.city_district || address.borough || address.suburb || address.quarter || null;
  return null;
}

// ---------------------------------------------------------------------------
// Overpass (OpenStreetMap) — pont jellegű helyek ("legközelebbi X")
// ---------------------------------------------------------------------------

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

function buildPointQuery(lat, lng, radius, filter) {
  return `[out:json][timeout:22];(node${filter}(around:${radius},${lat},${lng});way${filter}(around:${radius},${lat},${lng});relation${filter}(around:${radius},${lat},${lng}););out center tags;`;
}

/**
 * A megadott ponthoz legközelebbi, a kategóriának megfelelő OSM elem.
 * categoryDef: { filter, radius } — lásd a *_CATEGORIES objektumokat lent.
 * "Legjobb próbálkozás" jellegű — mindig a nevet is add vissza, hogy
 * szemmel ellenőrizhető legyen.
 */
export async function nearestOfCategory(lat, lng, categoryDef) {
  const query = buildPointQuery(lat, lng, categoryDef.radius, categoryDef.filter);
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

// ---------------------------------------------------------------------------
// Vonal/határ jellegű elemek ("mennyire vagy közel egy vonalhoz/területhez")
// — nemzetközi határ, közig. határ, partvonal, vízfelület. Ezekhez a
// legközelebbi PONTJUKAT kell megtalálni, nem a középpontjukat.
// ---------------------------------------------------------------------------

function toLocalXY(lat0, lng0, lat, lng) {
  const mpd = metersPerDeg(lat0);
  return [(lng - lng0) * mpd.lng, (lat - lat0) * mpd.lat];
}

function nearestPointOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: ax + t * dx, y: ay + t * dy };
}

/** Legkisebb távolság + a legközelebbi pont koordinátája (lat/lng-re visszaalakítva). */
function minDistanceToGeometries(lat, lng, geometries) {
  let minDist = Infinity;
  let bestXY = null;
  for (const geom of geometries) {
    for (let i = 0; i < geom.length - 1; i++) {
      if (!geom[i] || !geom[i + 1]) continue;
      const [ax, ay] = toLocalXY(lat, lng, geom[i].lat, geom[i].lon);
      const [bx, by] = toLocalXY(lat, lng, geom[i + 1].lat, geom[i + 1].lon);
      const nearest = nearestPointOnSegment(0, 0, ax, ay, bx, by);
      const d = Math.hypot(nearest.x, nearest.y);
      if (d < minDist) {
        minDist = d;
        bestXY = nearest;
      }
    }
  }
  if (!Number.isFinite(minDist)) return { distance: Infinity, point: null };
  const point = offsetPoint(lat, lng, bestXY.x, bestXY.y);
  return { distance: minDist, point };
}

/**
 * Legrövidebb távolság egy vonal/terület jellegű OSM elem-csoport
 * (partvonal, vízfelület, közigazgatási határ) legközelebbi pontjáig.
 * filter: Overpass QL szűrő, pl. '["natural"="coastline"]'.
 * Working-jal (way ÉS relation→tagvonalak) is próbálkozik, mert a
 * közigazgatási határok geometriája jellemzően relation tagjain van.
 */
export async function nearestDistanceToLineFeature(lat, lng, filter, radiusMeters) {
  const query = `
    [out:json][timeout:25];
    way${filter}(around:${radiusMeters},${lat},${lng});
    out geom;
    relation${filter}(around:${radiusMeters},${lat},${lng});
    way(r);
    out geom;
  `;
  const res = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    body: "data=" + encodeURIComponent(query),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error("Az Overpass-lekérdezés nem sikerült.");
  const data = await res.json();
  const geometries = (data.elements || [])
    .filter((el) => el.type === "way" && Array.isArray(el.geometry))
    .map((el) => el.geometry);
  if (!geometries.length) return null;
  const result = minDistanceToGeometries(lat, lng, geometries);
  return Number.isFinite(result.distance) ? result : null;
}

/** A legközelebbi elnevezett utca/ösvény neve — a "Utca vagy ösvény" Egyezéshez. */
export async function nearestNamedWay(lat, lng, radiusMeters = 600) {
  const query = `[out:json][timeout:20];way["highway"]["name"](around:${radiusMeters},${lat},${lng});out geom;`;
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
    if (el.type !== "way" || !Array.isArray(el.geometry) || !el.tags?.name) continue;
    const result = minDistanceToGeometries(lat, lng, [el.geometry]);
    if (result.distance < bestDist) {
      bestDist = result.distance;
      best = { name: el.tags.name, distance: result.distance, point: result.point };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Kategória-listák — a hivatalos (lifack.ch) kérdéskategóriák alapján.
// "approx: true" = OSM-alapú legjobb próbálkozás, nem szó szerinti szabály.
// "kind: 'unsupported'" = ezt az appon belül nem lehet automatizálni.
// ---------------------------------------------------------------------------

const P = (filter, radius) => ({ kind: "point", filter, radius }); // rövidítés

export const MEASURING_CATEGORIES = {
  commercial_airport: { label: "Kereskedelmi repülőtér", group: "Közlekedés", ...P('["aeroway"="aerodrome"]', 150000), approx: true },
  hst_line: { label: "Nagysebességű vasútvonal", group: "Közlekedés", kind: "line", filter: '["railway"="rail"]["highspeed"="yes"]', radius: 100000, approx: true },
  rail_station: { label: "Vasútállomás", group: "Közlekedés", ...P('["railway"~"station|halt"]', 40000) },
  international_border: { label: "Országhatár", group: "Határok", kind: "line", filter: '["boundary"="administrative"]["admin_level"="2"]', radius: 250000 },
  admin1_border: { label: "1. szintű közig. határ (megye)", group: "Határok", kind: "line", filter: '["boundary"="administrative"]["admin_level"="6"]', radius: 80000, approx: true },
  admin2_border: { label: "2. szintű közig. határ (járás)", group: "Határok", kind: "line", filter: '["boundary"="administrative"]["admin_level"="7"]', radius: 40000, approx: true },
  sea_level: { label: "Tengerszint (magasság)", group: "Természet", kind: "manual-altitude" },
  body_of_water: { label: "Vízfelület", group: "Természet", kind: "line", filter: '["natural"="water"]', radius: 20000 },
  coastline: { label: "Tengerpart", group: "Természet", kind: "line", filter: '["natural"="coastline"]', radius: 300000 },
  mountain: { label: "Hegycsúcs", group: "Természet", ...P('["natural"="peak"]', 60000) },
  park: { label: "Park", group: "Természet", ...P('["leisure"="park"]', 8000) },
  amusement_park: { label: "Vidámpark", group: "Látnivalók", ...P('["tourism"="theme_park"]', 150000) },
  zoo: { label: "Állatkert", group: "Látnivalók", ...P('["tourism"="zoo"]', 150000) },
  aquarium: { label: "Akvárium", group: "Látnivalók", ...P('["tourism"="aquarium"]', 150000) },
  golf_course: { label: "Golfpálya", group: "Látnivalók", ...P('["leisure"="golf_course"]', 60000) },
  museum: { label: "Múzeum", group: "Látnivalók", ...P('["tourism"="museum"]', 25000) },
  movie_theater: { label: "Mozi", group: "Látnivalók", ...P('["amenity"="cinema"]', 25000) },
  hospital: { label: "Kórház", group: "Közművek", ...P('["amenity"="hospital"]', 25000) },
  library: { label: "Könyvtár", group: "Közművek", ...P('["amenity"="library"]', 15000) },
  foreign_consulate: { label: "Külföldi konzulátus", group: "Közművek", ...P('["office"="diplomatic"]["diplomatic"="consulate"]', 120000), approx: true },
};

export const MATCHING_CATEGORIES = {
  commercial_airport: { label: "Kereskedelmi repülőtér", group: "Közlekedés", ...P('["aeroway"="aerodrome"]', 150000), approx: true },
  transit_line: { label: "Jelenlegi járat vonala", group: "Közlekedés", kind: "unsupported", note: "Valós idejű járat-egyeztetést igényel — ezt csak kézzel (Egyéni kérdés) lehet feltenni." },
  station_name_length: { label: "Legközelebbi állomás nevének hossza", group: "Közlekedés", kind: "derived-length", filter: '["railway"~"station|halt"]', radius: 40000 },
  street_or_path: { label: "Legközelebbi utca/ösvény", group: "Közlekedés", kind: "named-way", radius: 600, approx: true },
  admin1: { label: "1. szintű közig. egység (megye)", group: "Közigazgatás", kind: "admin-area", level: 1, approx: true },
  admin2: { label: "2. szintű közig. egység (járás)", group: "Közigazgatás", kind: "admin-area", level: 2, approx: true },
  admin3: { label: "3. szintű közig. egység (település)", group: "Közigazgatás", kind: "admin-area", level: 3, approx: true },
  admin4: { label: "4. szintű közig. egység (pl. kerület)", group: "Közigazgatás", kind: "admin-area", level: 4, approx: true },
  mountain: { label: "Hegycsúcs", group: "Természet", ...P('["natural"="peak"]', 60000) },
  landmass: { label: "Szárazföld-egység", group: "Természet", kind: "unsupported", note: "Topológiailag túl bonyolult az automatizáláshoz — kézi elbírálást igényel." },
  park: { label: "Park", group: "Természet", ...P('["leisure"="park"]', 8000) },
  amusement_park: { label: "Vidámpark", group: "Látnivalók", ...P('["tourism"="theme_park"]', 150000) },
  zoo: { label: "Állatkert", group: "Látnivalók", ...P('["tourism"="zoo"]', 150000) },
  aquarium: { label: "Akvárium", group: "Látnivalók", ...P('["tourism"="aquarium"]', 150000) },
  golf_course: { label: "Golfpálya", group: "Látnivalók", ...P('["leisure"="golf_course"]', 60000) },
  museum: { label: "Múzeum", group: "Látnivalók", ...P('["tourism"="museum"]', 25000) },
  movie_theater: { label: "Mozi", group: "Látnivalók", ...P('["amenity"="cinema"]', 25000) },
  hospital: { label: "Kórház", group: "Közművek", ...P('["amenity"="hospital"]', 25000) },
  library: { label: "Könyvtár", group: "Közművek", ...P('["amenity"="library"]', 15000) },
  foreign_consulate: { label: "Külföldi konzulátus", group: "Közművek", ...P('["office"="diplomatic"]["diplomatic"="consulate"]', 120000), approx: true },
};

export const TENTACLE_CATEGORIES = {
  museum: { label: "Múzeumok", radiusMiles: 1, tier: "kozepes", filter: '["tourism"="museum"]' },
  library: { label: "Könyvtárak", radiusMiles: 1, tier: "kozepes", filter: '["amenity"="library"]' },
  movie_theater: { label: "Mozik", radiusMiles: 1, tier: "kozepes", filter: '["amenity"="cinema"]' },
  hospital: { label: "Kórházak", radiusMiles: 1, tier: "kozepes", filter: '["amenity"="hospital"]' },
  metro_line: { label: "Metróvonalak", radiusMiles: 15, tier: "nagy", kind: "unsupported", note: "Vonal-egyeztetés kézi elbírálást igényel." },
  zoo: { label: "Állatkertek", radiusMiles: 15, tier: "nagy", filter: '["tourism"="zoo"]' },
  aquarium: { label: "Akváriumok", radiusMiles: 15, tier: "nagy", filter: '["tourism"="aquarium"]' },
  amusement_park: { label: "Vidámparkok", radiusMiles: 15, tier: "nagy", filter: '["tourism"="theme_park"]' },
};

export const PHOTO_CATEGORIES = {
  building_from_station: { label: "Épület a megállóból", tier: "kicsi", instructions: "Állj a megálló bejárata elé. A kép mutassa a tetőt és mindkét oldalfalat; a tető legyen a felső harmadban." },
  widest_street: { label: "A legszélesebb utca", tier: "kicsi", instructions: "Mindkét oldal látszódjon a képen." },
  tree: { label: "Egy fa", tier: "kicsi", instructions: "A teljes fa legyen a képen." },
  tallest_in_sightline: { label: "Legmagasabb épület a rálátásodból", tier: "kicsi", instructions: "A saját szemszögedből legmagasabb számít, nem az objektíven legmagasabb. Tető + mindkét oldal, a tető a felső harmadban." },
  selfie: { label: "Rólad (szelfi)", tier: "kicsi", instructions: "Szelfi mód, telefon merőlegesen, kar teljesen kinyújtva, zoom nélkül." },
  sky: { label: "Az égbolt", tier: "kicsi", instructions: "Telefon a földön, egyenesen fölfelé fotózva, zoom nélkül." },
  tallest_from_station: { label: "Legmagasabb épület a megállóból", tier: "kozepes", instructions: "Mint a sima 'legmagasabb épület', de a megálló bejáratától fotózva." },
  trace_street: { label: "Legközelebbi utca/ösvény kirajzolva", tier: "kozepes", instructions: "Kereszteződéstől kereszteződésig; csak az utca vonala látszódjon (pl. képszerkesztővel kitakarva)." },
  two_buildings: { label: "2 épület", tier: "kozepes", instructions: "Alulról, az első kb. 4 emeletig." },
  restaurant_interior: { label: "Étterem belseje", tier: "kozepes", instructions: "Kívülről, az ablakon át, zoom nélkül." },
  park_photo: { label: "Park", tier: "kozepes", instructions: "Zoom nélkül, telefon merőlegesen a földhöz, kb. 1,5 m-re bármilyen akadálytól." },
  grocery_aisle: { label: "Bolti sor", tier: "kozepes", instructions: "Zoom nélkül, a sor végéről egyenesen befotózva." },
  place_of_worship: { label: "Vallási épület", tier: "kozepes", instructions: "Kb. 1,5×1,5 m-es részlet, 3 jól felismerhető elemmel." },
  train_platform: { label: "Vasúti peron", tier: "kozepes", instructions: "Kb. 1,5×1,5 m-es részlet, 3 jól felismerhető elemmel." },
  half_mile_streets: { label: "~800 m kirajzolt utca", tier: "nagy", instructions: "Folyamatos vonal, 5 kanyarral, visszafordulás nélkül, észak-dél tájolással." },
  tallest_mountain_from_station: { label: "Legmagasabb hegy a megállóból", tier: "nagy", instructions: "Max 3x zoom, a csúcs a felső harmadban." },
  biggest_water: { label: "A zónád legnagyobb vízfelülete", tier: "nagy", instructions: "Max 3x zoom, mindkét part vagy a horizont látszódjon." },
  five_buildings: { label: "5 épület", tier: "nagy", instructions: "Alulról, az első kb. 4 emeletig." },
};

export const GAME_SIZES = { kicsi: "Kicsi", kozepes: "Közepes", nagy: "Nagy" };
const SIZE_ORDER = { kicsi: 0, kozepes: 1, nagy: 2 };
export function tierAvailable(currentSize, requiredTier) {
  return SIZE_ORDER[currentSize] >= SIZE_ORDER[requiredTier];
}
