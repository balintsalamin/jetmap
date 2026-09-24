# 📡 RejtekRádár

Digitális terepasztal a **Jet Lag: Bújócska** (Hide and Seek) otthoni verziójához, a hivatalos
[lifack.ch](https://www.lifack.ch/docs/quick_start_guide/) szabálykönyv kérdéstípusai szerint. A
kártyákat és a "hider curse"-öket továbbra is a fizikai játék intézi — ez az eszköz a
térkép/helymeghatározás részt veszi le a válladról:

- A keresők folyamatosan megosztják a helyzetüket egymással **és** a bujkálóval.
- A bujkáló helyzetét **soha senki nem látja** — helyette mind a hat hivatalos kérdéstípust
  (Rádár, Hőmérő, Mérés, Egyezés, Tentakel, Fotó) fel lehet tenni, és amit csak lehet, a bujkáló
  telefonja automatikusan kiszámol a valódi pozíciójából — a bujkáló csak ránéz és elküldi.

Semmilyen szerverkód nincs benne — statikus fájlok, amiket a GitHub Pages ingyen kiszolgál, a
valós idejű szinkront pedig egy ingyenes Firebase-projekt adja.

## Fájlok

| Fájl | Mit csinál |
|---|---|
| `index.html` | Az oldal váza, minden képernyő |
| `styles.css` | Kinézet |
| `firebase-config.js` | **Ezt kell szerkesztened** — ide jön a saját Firebase kulcsaid |
| `state.js` | Közös állapot, képernyőváltás |
| `geo.js` | Távolságszámítás, helykeresés, OpenStreetMap lekérdezések, kérdéskategóriák |
| `lobby.js` | Parti létrehozása/csatlakozás, szerepkiosztás, játékméret beállítás |
| `hints.js` | A 6 kérdéstípus automatikus válaszszámítása |
| `map.js` | Térkép és a segítség-átfedések rajzolása |
| `app.js` | Mindent összeköt |
| `firestore.rules` | Biztonsági szabályok — bemásolandó a Firebase konzolba |

## 1. Firebase beállítása (~10 perc, ingyenes, nem kell bankkártya)

1. Nyisd meg: <https://console.firebase.google.com>, jelentkezz be, és hozz létre egy új projektet.
2. Keress rá a bal oldali **"Search for products"** mezőben az **Authentication**-re, nyisd meg,
   és a *Sign-in method* fülön kapcsold be az **Anonymous** (Névtelen) belépési módot. Ez adja
   minden játékosnak az egyedi azonosítót, ami nélkül a szabályok nem tudnák megkülönböztetni, ki
   a bujkáló. (A Firebase konzol felülete időnként változik — ha nem "Build" menü alatt van, a
   keresőmező mindig megtalálja.)
3. Ugyanígy keress rá a **Firestore Database**-re → **Create database**. Válassz egy hozzád közeli
   régiót, indulhat *production mode*-ban (a szabályokat úgyis felülírod a következő lépésben).
4. A Firestore **Rules** fülén cseréld le a teljes tartalmat a mellékelt `firestore.rules` fájl
   tartalmára, majd **Publish**.
5. **Project settings** (fogaskerék ikon) → görgess le **Your apps**-hez → kattints a `</>` (Web)
   ikonra → adj egy nevet az appnak → **NE** pipáld be a Firebase Hostingot.
6. A megjelenő `firebaseConfig` objektum **csak a hat mezőjét** (apiKey, authDomain, projectId,
   storageBucket, messagingSenderId, appId) másold át a `firebase-config.js` fájlba, a
   `"IDE_JÖN_..."` helyőrzők helyére — ne az egész kódrészletet, amit a Firebase mutat, mert az
   más importokat is tartalmaz, amik böngészőben nem működnek.

## 2. Feltöltés GitHub Pages-re

1. Hozz létre egy új, publikus GitHub repót (pl. `rejtekradar`).
2. Töltsd fel bele mind a 10 fájlt a repó gyökerébe (nem kell build lépés, nem kell `npm install`).
3. **Settings → Pages** → Branch: `main` / `(root)` → **Save**.
4. Pár perc múlva elérhető: `https://<felhasznalonev>.github.io/rejtekradar/`

## Játékmenet

1. Az egyik játékos megnyitja az oldalt, megadja a nevét, **Parti létrehozása** → megkapja az 5
   karakteres kódot.
2. A többiek a kóddal csatlakoznak.
3. A házigazda beállítja a **játék méretét** (Kicsi/Közepes/Nagy — ez szabja meg, mely Hőmérő-,
   Tentakel- és Fotó-kategóriák érhetők el, a hivatalos szabályok szerint), kiválasztja, ki bújik
   ("Ő bújik" gomb), majd **Indítás**.
4. Bújás/keresés a szokott fizikai szabályok szerint zajlik; a keresők a "Segítség kérése"
   dobozból mind a hat típust kérhetik:
   - **Rádár** — "Belül vagy-e X mérföldön TŐLEM?" — igen/nem, a kérő aktuális helyzetétől mérve.
   - **Hőmérő** — két pont (honnan indultatok, hova értetek) alapján melegebb/hidegebb.
   - **Mérés** — "Hozzám képest te közelebb vagy távolabb vagy egy adott kategóriától (pl.
     reptér, park, kórház)?" — a ti aktuális helyzetetek a viszonyítási alap.
   - **Egyezés** — "A legközelebbi X ugyanaz-e neked, mint nekem?" — szintén a ti helyzetetekhez
     képest.
   - **Tentakel** — "X mérföldön belül melyik Y-hoz vagy legközelebb?" (csak Közepes/Nagy méretű
     játékban érhető el).
   - **Fotó** — a bujkáló egy adott specifikációnak megfelelő fotót küld.

   A bujkáló képernyőjén megjelenik a kérés a kiszámolt javasolt válasszal — ránézésre
   ellenőrzi, majd elküldi. A kártyahúzás-jutalom (pl. "húzz 3 lapot, tarts 1-et") mindenhol ki
   van írva emlékeztetőnek, de magát a paklit továbbra is ti kezelitek.
5. Amikor megtalálják a bujkálót, a házigazda **Kör vége**-t nyom, és jöhet a következő kör új
   bujkálóval.

## Testreszabás

- **Rádár mérföld-opciók**: `hints.js` tetején `RADAR_DISTANCES_MILES`.
- **Hőmérő méretek/tiers**: `hints.js` → `THERMOMETER_DISTANCES`.
- **Mérés / Egyezés / Tentakel / Fotó kategóriák** (OSM-tagek, sugarak, leírások): `geo.js` →
  `MEASURING_CATEGORIES`, `MATCHING_CATEGORIES`, `TENTACLE_CATEGORIES`, `PHOTO_CATEGORIES`.
- **Kártyahúzás-szövegek**: `hints.js` → `CARD_INFO`.

## Amit érdemes tudni — közelítések és kézi esetek

A legtöbb kérdéstípus (Rádár, Hőmérő, Mérés/Egyezés pont-alapú kategóriái — hegy, park,
vidámpark, állatkert, akvárium, golfpálya, múzeum, mozi, kórház, könyvtár, reptér, vasútállomás,
Tentakel) **teljesen automatikus**, valódi OpenStreetMap-adatokból. Néhány kategóriánál viszont
tudatos egyszerűsítést vagy közelítést választottam — ezeket a kérdés-választóban `*` jelzi:

- **Országhatár / közigazgatási határ (Mérés)**, **partvonal / vízfelület (Mérés)**: ezekhez a
  legközelebbi PONTJukat kell megtalálni (nem a középpontjukat) — ez egy saját geometriai
  számítás OSM-vonaladatokból, működik, de ritkább/összetettebb határvonalaknál előfordulhat
  hibás vagy hiányzó találat.
- **Közigazgatási egység Egyezés (megye/járás/település/kerület)**: mivel a "hányadik szintű
  közigazgatási egység" országonként mást jelent, ezt a Nominatim cím-visszakeresés
  mezőneveiből próbálom kikövetkeztetni — **Magyarországra nem teszteltem élesben**, hogy a
  Nominatim pontosan a megyét/járást adja-e vissza a várt mezőben. Ha furcsa eredményt látsz,
  szólj, és pontosítom.
- **Jelenlegi járat vonala (Egyezés)**, **Szárazföld-egység (Egyezés)**, **Metróvonalak
  (Tentakel)**: ezeket **nem lehet** megbízhatóan automatizálni (valós idejű járat-egyeztetést
  vagy szárazföld-topológiát igényelnek) — az app ilyenkor a bujkálónak egy szövegdobozt ad, ahol
  kézzel válaszol.
- **Tengerszint (Mérés)**: a böngésző nem tud megbízhatóan magasságot mérni, ezért mindkét fél
  kézzel adja meg a saját magasságát (a telefonja iránytű/magasságmérő appjából) — az
  összehasonlítást az app már automatikusan elvégzi.
- **Kereskedelmi repülőtér / nagysebességű vasútvonal / külföldi konzulátus (nem tiszteletbeli)**:
  a hivatalos definíció (Google Flights, EU nagysebesség-küszöb, tiszteletbeli kizárás) nem
  kérdezhető le automatikusan — OSM-alapú legjobb közelítést használok, ami a legtöbb esetben jó,
  de érdemes szemmel ellenőrizni.
- Az összes ilyen kategóriánál a talált hely NEVÉT is kiírja az app, hogy szemmel
  ellenőrizhető legyen, és van egy "Frissítés" gomb, ha az OSM-lekérdezés üres/furcsa eredményt ad.
- A bujkálónak nyitva/előtérben kell tartania az oldalt a kör alatt, hogy tudjon válaszolni — a
  mobil böngészők háttérben leállíthatják a helymeghatározást.
- Egy baráti társasághoz (kb. 6-8 fő) a Firestore ingyenes kerete bőven elég.

## Adatvédelem

A bujkáló GPS-koordinátája **soha nem kerül fel a szerverre**. Minden válaszot a bujkáló saját
böngészője számol ki helyben, a saját, csak nála elérhető pozíciójából — a szinkronba csak a kész
eredmény (pl. "belül" vagy "melegebb") kerül fel. A Fotó válaszok (a fotó maga) értelemszerűen
felkerülnek, hiszen az a kérés lényege.

## Fejlesztői panel

A logóra 10-szer gyorsan koppintva nyílik egy rejtett panel, ahol szimulált (lat/lng) pozíciót
állíthatsz be. Ezzel egyedül, több böngészőfülben is ki tudod próbálni az egész folyamatot, mielőtt
kiviszed a haverokkal terepre.
