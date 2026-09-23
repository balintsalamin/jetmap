// lobby.js — parti létrehozása/csatlakozás, játékoslista szinkron, szerepkiosztás
//
// Firestore-modell:
//   lobbies/{code}                    { hostUid, hiderUid, status, settings, createdAt, roundStartedAt }
//   lobbies/{code}/players/{uid}      { name, role, joinedAt, lastSeen, lastLocation }
//   lobbies/{code}/hints/{hintId}     lásd hints.js

import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  collection,
  serverTimestamp,
  writeBatch,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { db } from "./firebase-config.js";
import { state, clearSubscriptions } from "./state.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // O/0, I/1 kihagyva
const CODE_LENGTH = 5;

function randomCode() {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

export const DEFAULT_SETTINGS = {
  radarPreset: "kozepes", // 'kicsi' | 'kozepes' | 'nagy' — lásd hints.js
};

/** Új parti létrehozása. Visszaadja a lobbykódot. */
export async function createLobby(name) {
  // Néhány próbálkozás ütköző kód esetén (rendkívül ritka, de biztos ami biztos).
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    const ref = doc(db, "lobbies", code);
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists()) throw new Error("CODE_TAKEN");
        tx.set(ref, {
          hostUid: state.uid,
          hiderUid: null,
          status: "lobby",
          settings: DEFAULT_SETTINGS,
          createdAt: serverTimestamp(),
          roundStartedAt: null,
        });
      });
      await setDoc(doc(db, "lobbies", code, "players", state.uid), {
        name,
        role: null,
        joinedAt: serverTimestamp(),
        lastSeen: serverTimestamp(),
        lastLocation: null,
      });
      state.lobbyCode = code;
      state.isHost = true;
      state.role = null;
      state.name = name;
      return code;
    } catch (err) {
      if (err.message !== "CODE_TAKEN") throw err;
      // próbáljuk újra másik kóddal
    }
  }
  throw new Error("Nem sikerült szabad lobbykódot találni, próbáld újra.");
}

/** Csatlakozás egy meglévő partihoz kód alapján. */
export async function joinLobby(codeRaw, name) {
  const code = codeRaw.trim().toUpperCase();
  const ref = doc(db, "lobbies", code);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Nincs ilyen lobbykód.");
  const lobby = snap.data();
  if (lobby.status === "playing") {
    throw new Error("Ez a parti már elindult — kérj új kört a házigazdától.");
  }
  await setDoc(doc(db, "lobbies", code, "players", state.uid), {
    name,
    role: null,
    joinedAt: serverTimestamp(),
    lastSeen: serverTimestamp(),
    lastLocation: null,
  });
  state.lobbyCode = code;
  state.isHost = lobby.hostUid === state.uid;
  state.role = null;
  state.name = name;
  return code;
}

/** Élő feliratkozás a lobby dokumentumra + a játékoslistára. */
export function subscribeLobby(code, onLobbyChange, onPlayersChange) {
  const lobbyRef = doc(db, "lobbies", code);
  const unsubLobby = onSnapshot(lobbyRef, (snap) => {
    if (!snap.exists()) return;
    const lobby = snap.data();
    state.isHost = lobby.hostUid === state.uid;
    const mySnap = lobby; // csak jelzés, a szerepet a players feed adja
    onLobbyChange(lobby);
  });

  const playersRef = collection(db, "lobbies", code, "players");
  const unsubPlayers = onSnapshot(playersRef, (snap) => {
    const players = [];
    snap.forEach((d) => players.push({ uid: d.id, ...d.data() }));
    const me = players.find((p) => p.uid === state.uid);
    if (me) state.role = me.role;
    onPlayersChange(players);
  });

  state.unsubscribers.push(unsubLobby, unsubPlayers);
}

/** Házigazda: egy adott játékos legyen a bujkáló, a többiek keresők. */
export async function assignHider(code, hiderUid, players) {
  const batch = writeBatch(db);
  players.forEach((p) => {
    batch.update(doc(db, "lobbies", code, "players", p.uid), {
      role: p.uid === hiderUid ? "hider" : "seeker",
    });
  });
  batch.update(doc(db, "lobbies", code), { hiderUid });
  await batch.commit();
}

export async function updateSettings(code, settings) {
  await updateDoc(doc(db, "lobbies", code), { settings });
}

export async function startGame(code) {
  await updateDoc(doc(db, "lobbies", code), {
    status: "playing",
    roundStartedAt: serverTimestamp(),
  });
}

/** Kör vége: mindenki visszakerül a lobbyba, szerepek törlődnek — jöhet az új bujkáló. */
export async function endRound(code, players) {
  const batch = writeBatch(db);
  players.forEach((p) => {
    batch.update(doc(db, "lobbies", code, "players", p.uid), { role: null });
  });
  batch.update(doc(db, "lobbies", code), {
    status: "lobby",
    hiderUid: null,
    roundStartedAt: null,
  });
  await batch.commit();
}

export async function heartbeat(code) {
  if (!code || !state.uid) return;
  try {
    await updateDoc(doc(db, "lobbies", code, "players", state.uid), {
      lastSeen: serverTimestamp(),
    });
  } catch {
    /* átmeneti hálózati hiba — nem kritikus */
  }
}

/** Kereső élő pozíciójának frissítése — a bujkáló ezt látja a térképen. */
export async function updateMyLocation(code, pos) {
  if (!code || !state.uid) return;
  try {
    await updateDoc(doc(db, "lobbies", code, "players", state.uid), {
      lastLocation: {
        lat: pos.lat,
        lng: pos.lng,
        accuracy: pos.accuracy ?? null,
        updatedAt: serverTimestamp(),
      },
    });
  } catch {
    /* átmeneti hálózati hiba — nem kritikus */
  }
}

export async function leaveLobby() {
  clearSubscriptions();
  if (state.lobbyCode && state.uid) {
    try {
      await deleteDoc(doc(db, "lobbies", state.lobbyCode, "players", state.uid));
    } catch {
      /* nem gond, ha ez nem sikerül — a lobby úgyis eltűnik idővel */
    }
  }
  state.lobbyCode = null;
  state.isHost = false;
  state.role = null;
}
