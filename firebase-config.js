// firebase-config.js
//
// ⚠️ EZT A FÁJLT KELL SZERKESZTENED. ⚠️
// Illeszd be ide a saját Firebase-projektod konfigurációját (lásd README.md
// "Firebase beállítása" szakaszát — 10 perc, ingyenes, nem kell bankkártya).
//
// Firebase konzol → Projekt beállításai → "Your apps" → Web app → a
// firebaseConfig objektum pont ide másolandó.
// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDi2-R1L0ie9WDoCld05A1V01YWkQcoQK0",
  authDomain: "jetmap-98897.firebaseapp.com",
  projectId: "jetmap-98897",
  storageBucket: "jetmap-98897.firebasestorage.app",
  messagingSenderId: "647856848354",
  appId: "1:647856848354:web:0237df0e56893c60f68dbb"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  enableIndexedDbPersistence,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "IDE_JÖN_AZ_API_KEY",
  authDomain: "IDE_JÖN.firebaseapp.com",
  projectId: "IDE_JÖN_A_PROJECT_ID",
  storageBucket: "IDE_JÖN.appspot.com",
  messagingSenderId: "IDE_JÖN",
  appId: "IDE_JÖN_AZ_APP_ID",
};

export const firebaseApp = initializeApp(firebaseConfig);
export const db = getFirestore(firebaseApp);
export const auth = getAuth(firebaseApp);

// Offline gyorsítótár — ha pillanatra megszakad a net (pl. alagút, rossz térerő
// terepen), a UI nem fagy le, csak a legutóbbi ismert adatot mutatja.
enableIndexedDbPersistence(db).catch(() => {
  /* több tab nyitva egyszerre — nem kritikus, csendben elnyeljük */
});

/**
 * Névtelen bejelentkezés — minden játékosnak stabil, egyedi azonosítót ad,
 * enélkül a Firestore biztonsági szabályok nem tudnák megkülönböztetni,
 * hogy ki a bujkáló (csak ő válaszolhat a segítségkérésekre).
 * Visszaad egy Promise-t, ami az uid-vel teljesül.
 */
export function ensureSignedIn() {
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        unsub();
        resolve(user.uid);
      }
    }, reject);
    signInAnonymously(auth).catch(reject);
  });
}
