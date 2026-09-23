# 📡 RejtekRádár

Digitális terepasztal a **Jet Lag: Bújócska** (Hide and Seek) otthoni verziójához. A kártyákat, a
szabályokat és a "hider curse"-öket továbbra is a fizikai játék intézi — ez az eszköz csak a
térkép/helymeghatározás részt veszi le a válladról:

- A keresők folyamatosan megosztják a helyzetüket egymással **és** a bujkálóval.
- A bujkáló helyzetét **soha senki nem látja** — helyette segítségkéréseket (Rádár, Hőmérő, Mérés,
  Egyezés) lehet küldeni, amire a bujkáló telefonja automatikusan kiszámolja a választ a valódi
  pozíciójából, a bujkáló pedig egy gombnyomással elküldi.

Semmilyen szerverkód nincs benne — statikus fájlok, amiket a GitHub Pages ingyen kiszolgál, a
valós idejű szinkront pedig egy ingyenes Firebase-projekt adja.

## Fájlok

| Fájl | Mit csinál |
|---|---|
| `index.html` | Az oldal váza, minden képernyő |
| `styles.css` | Kinézet |
| `firebase-config.js` | **Ezt kell szerkesztened** — ide jön a saját Firebase kulcsaid |
| `state.js` | Közös állapot, képernyőváltás |
| `geo.js` | Távolságszámítás, helykeresés, OpenStreetMap lekérdezések |
| `lobby.js` | Parti létrehozása/csatlakozás, szerepkiosztás |
| `hints.js` | Segítségkérés/válasz logika, automatikus számítás |
| `map.js` | Térkép és a segítség-átfedések (rádárgyűrűk stb.) rajzolása |
| `app.js` | Mindent összeköt |
| `firestore.rules` | Biztonsági szabályok — bemásolandó a Firebase konzolba |

## 1. Firebase beállítása (~10 perc, ingyenes, nem kell bankkártya)

1. Nyisd meg: <https://console.firebase.google.com>, jelentkezz be, és hozz létre egy új projektet
   (tetszőleges néven, Google Analytics nem szükséges hozzá).
2. **Build → Authentication → Get started**, majd a *Sign-in method* fülön kapcsold be az
   **Anonymous** (Névtelen) belépési módot. Ez adja minden játékosnak az egyedi azonosítót, ami
   nélkül a szabályok nem tudnák megkülönböztetni, ki a bujkáló.
3. **Build → Firestore Database → Create database.** Válassz egy hozzád közeli régiót, indulhat
   *production mode*-ban (a szabályokat úgyis felülírod a következő lépésben).
4. A Firestore **Rules** fülén cseréld le a teljes tartalmat a mellékelt `firestore.rules` fájl
   tartalmára, majd **Publish**.
5. **Project settings** (fogaskerék ikon) → görgess le **Your apps**-hez → kattints a `</>` (Web)
   ikonra → adj egy nevet az appnak → **NE** pipáld be a Firebase Hostingot (a GitHub Pages-t
   használjuk helyette).
6. A megjelenő `firebaseConfig` objektumot másold be a `firebase-config.js` fájlba, a
   `"IDE_JÖN_..."` helyőrzők helyére.

## 2. Feltöltés GitHub Pages-re

1. Hozz létre egy új, publikus GitHub repót (pl. `rejtekradar`).
2. Töltsd fel bele mind a 10 fájlt a repó gyökerébe (nem kell build lépés, nem kell `npm install`).
3. **Settings → Pages** → Branch: `main` / `(root)` → **Save**.
4. Pár perc múlva elérhető: `https://<felhasznalonev>.github.io/rejtekradar/`

## Játékmenet

1. Az egyik játékos megnyitja az oldalt, megadja a nevét, **Parti létrehozása** → megkapja az 5
   karakteres kódot.
2. A többiek a kóddal csatlakoznak.
3. A házigazda a váróteremben kiválasztja, ki bújik ("Ő bújik" gomb) — a többiek automatikusan
   keresők lesznek — majd **Indítás**.
4. Bújás/keresés a szokott fizikai szabályok szerint zajlik; a keresők a "Segítség kérése" dobozból
   kérhetnek Rádárt / Hőmérőt / Mérést / Egyezést / Egyéni kérdést. A bujkáló képernyőjén megjelenik
   a kérés a kiszámolt javasolt válasszal — ránézésre ellenőrzi, majd elküldi.
5. Amikor megtalálják a bujkálót, a házigazda **Kör vége**-t nyom, és jöhet a következő kör új
   bujkálóval.

## Testreszabás

- **Rádár gyűrűtávolságok** (méterben): `hints.js` tetején a `RADAR_PRESETS` objektum.
- **Egyezés kategóriák** (mit keressen az OpenStreetMapon): `geo.js`-ben a `MATCHING_CATEGORIES`.
- **Kerekítés a Mérésnél**: `hints.js` → `roundDistance()`.

## Amit érdemes tudni

- A rádár-sávok és a kerekítési szabályok a nyilvánosan elérhető leírások alapján közelítő
  értékek, **nem** az eredeti kártyák szó szerinti szövege — ha a saját dobozodban más számok
  szerepelnek, bátran írd át őket a fenti helyeken.
- Az **Egyezés** az OpenStreetMap nyílt, közösségi adatbázisát kérdezi le — ez helyenként hiányos
  vagy pontatlan, ezért a talált helyek nevét mindig kiírja, hogy szemmel ellenőrizhető legyen.
- A bujkálónak nyitva/előtérben kell tartania az oldalt a kör alatt, hogy tudjon válaszolni — a
  mobil böngészők háttérben leállíthatják a helymeghatározást.
- Egy baráti társasághoz (kb. 6-8 fő) a Firestore ingyenes kerete (napi 50 000 olvasás / 20 000
  írás) bőven elég.

## Adatvédelem

A bujkáló GPS-koordinátája **soha nem kerül fel a szerverre**. A rádár/hőmérő/mérés/egyezés
válaszát mindig a bujkáló saját böngészője számolja ki helyben, a saját, csak nála elérhető
pozíciójából — a szinkronba csak a kész eredmény (pl. "3. sáv" vagy "melegebb") kerül fel.

## Fejlesztői panel

A logóra 10-szer gyorsan koppintva nyílik egy rejtett panel, ahol szimulált (lat/lng) pozíciót
állíthatsz be. Ezzel egyedül, több böngészőfülben is ki tudod próbálni az egész folyamatot, mielőtt
kiviszed a haverokkal terepre.
