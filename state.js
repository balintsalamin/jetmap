// state.js — közös alkalmazásállapot + a .screen/.active navigációs segédlet

export const state = {
  uid: null,
  name: "",
  lobbyCode: null,
  isHost: false,
  role: null, // 'hider' | 'seeker' | null
  unsubscribers: [], // aktív Firestore onSnapshot leiratkozók, lobbielhagyáskor törölve
  watchId: null, // navigator.geolocation.watchPosition azonosítója
  lastKnownPosition: null, // {lat, lng, accuracy}
  // Fejlesztői panel: ha be van állítva, ez a pozíció használódik a valódi
  // GPS helyett — több böngészőfülben tesztelni a "terepen sétálást".
  devOverridePosition: null,
};

/** Az összes aktív Firestore-feliratkozás leállítása (lobbielhagyáskor hívd). */
export function clearSubscriptions() {
  state.unsubscribers.forEach((unsub) => {
    try {
      unsub();
    } catch {
      /* már leiratkozott, nem gond */
    }
  });
  state.unsubscribers = [];
}

/** A ténylegesen használandó pozíció — dev override, ha van, különben valódi GPS. */
export function currentPosition() {
  return state.devOverridePosition || state.lastKnownPosition;
}

// ---------------------------------------------------------------------------
// Képernyőváltás — .screen elemek közül az #id kap .active osztályt
// ---------------------------------------------------------------------------

export function goTo(screenId) {
  document.querySelectorAll(".screen").forEach((el) => {
    el.classList.toggle("active", el.id === screenId);
  });
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Toast értesítés
// ---------------------------------------------------------------------------

let toastTimer = null;

export function toast(message, kind = "info") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.className = `toast toast--${kind}`;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3600);
}
