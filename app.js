// Tippspiel Anni vs. Olaf - NFL 2026/27
// Statische Seite, Daten in Firebase Firestore, Ergebnisse live von ESPN.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup,
  signInWithRedirect, signOut, connectAuthEmulator, signInWithCredential,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, memoryLocalCache, connectFirestoreEmulator, collection, doc, getDoc, getDocs,
  onSnapshot, query, runTransaction, serverTimestamp, Timestamp, updateDoc,
  where, writeBatch, terminate, clearIndexedDbPersistence,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig as liveConfig } from "./firebase-config.js";

const PLAYERS = { anni: "Anni", olaf: "Olaf" };
const ROUND_LABEL = { REG: "Regular Season", WC: "Wild Card", DIV: "Divisional",
  CONF: "Conference Championship", SB: "Super Bowl LXI" };
const WEEKS = [...Array(18)].map((_, i) => [i + 1, `Woche ${i + 1}`])
  .concat([[19, "Wild Card"], [20, "Divisional"], [21, "Conference"], [22, "Super Bowl"]]);
const SEASON = 2026;
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const ESPN_TEAM = { WSH: "WAS" };                 // ESPN-Kürzel, die von unseren abweichen
const ESPN_PLAYOFF = { 19: 1, 20: 2, 21: 3, 22: 5 }; // ESPN-Woche 4 ist der Pro Bowl
const TZ = "Europe/Berlin";
// Papiertipps: Spiele vor dem Start der App lassen sich bis zum 18.10. nachtragen.
// Muss zu isBackfill() in firestore.rules passen.
const BACKFILL_BEFORE = new Date("2026-10-03T00:00:00Z");
const BACKFILL_UNTIL = new Date("2026-10-18T00:00:00Z");

const wrap = document.querySelector(".wrap");

// Lokaler Test gegen den Firebase-Emulator: http://localhost:5000/?emu=anni@test.de
const EMU = ["localhost", "127.0.0.1"].includes(location.hostname)
  && new URLSearchParams(location.search).get("emu");
const firebaseConfig = EMU
  ? { apiKey: "demo", authDomain: "localhost", projectId: "demo-tippspiel", appId: "demo" }
  : liveConfig;

if (!firebaseConfig || !firebaseConfig.apiKey) {
  wrap.innerHTML = `<header class="hero hero-login"><h1>Tippspiel</h1>
    <p class="lede">Firebase ist noch nicht eingerichtet. Trag die Zugangsdaten in
    <code>firebase-config.js</code> ein, siehe README.</p></header>`;
  throw new Error("firebase-config.js fehlt");
}

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = initializeFirestore(fb, { localCache: EMU ? memoryLocalCache() : persistentLocalCache() });
if (EMU) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

// ------------------------------------------------------------------ Zustand
const S = {
  user: null,
  players: {},        // {anni: uid, olaf: uid}
  me: null,           // "anni" | "olaf"
  games: new Map(),   // id -> Spiel
  mine: new Map(),    // id -> "away" | "home"
  tipped: new Set(),  // "<id>_<spieler>"
  theirs: new Map(),  // id -> Tipp des anderen, erst nach Anpfiff
  at: new Map(),      // "<id>_<spieler>" -> Zeitpunkt des Tipps (für die Statistik)
  sync: { at: null, ok: null },
  note: {},           // id -> Hinweis an einer Spielzeile
  wp: new Map(),      // id -> {home, away, live, at}  Siegchance von ESPN
  showWp: (() => { try { return localStorage.getItem("tippspiel:wp") === "1"; } catch { return false; } })(),
  filter: (() => {                   // {status: [...], tips: [...]}, leer = keine Einschränkung
    try {
      const f = JSON.parse(localStorage.getItem("tippspiel:filter") || "{}");
      return { status: Array.isArray(f.status) ? f.status : [], tips: Array.isArray(f.tips) ? f.tips : [] };
    } catch { return { status: [], tips: [] }; }
  })(),
};
const unsub = [];
const other = () => (S.me === "anni" ? "olaf" : "anni");

// ------------------------------------------------------------------- Helfer
const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const now = () => new Date();
const logo = t => t ? `<img class="logo" alt="" loading="lazy" onerror="this.style.visibility='hidden'"
  src="https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${encodeURIComponent(t.toLowerCase())}.png&h=80&w=80">` : "";

const fmtParts = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short",
  day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
function berlin(d) {
  const p = Object.fromEntries(fmtParts.formatToParts(d).map(x => [x.type, x.value]));
  return { wd: p.weekday.replace(".", ""), day: `${p.day}.${p.month}.`,
           time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` };
}
function fmtHint(s) {
  if (!s) return "";
  const d = new Date(`${s}T12:00:00Z`);
  const b = berlin(d);
  return `${b.wd} ${b.day}${s.slice(0, 4)}`;
}
// "2026-12-24T19:00" als deutsche Ortszeit -> Date
function fromBerlinLocal(s) {
  const [d, t] = s.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [h, min] = t.split(":").map(Number);
  let guess = Date.UTC(y, m - 1, day, h, min);
  for (let i = 0; i < 2; i++) {
    const b = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(guess));
    const q = Object.fromEntries(b.map(x => [x.type, x.value]));
    const shown = Date.UTC(+q.year, +q.month - 1, +q.day, +q.hour, +q.minute);
    guess += Date.UTC(y, m - 1, day, h, min) - shown;
  }
  return new Date(guess);
}

function started(g) {
  return (g.kickoff && now() >= g.kickoff) || g.winner != null
    || g.status === "in" || g.status === "post";
}

function isBackfill(g) {
  return !!g.kickoff && g.kickoff < BACKFILL_BEFORE && now() < BACKFILL_UNTIL;
}
const backfillOpen = () => now() < BACKFILL_UNTIL;

function currentWeek() {
  for (let w = 1; w <= 18; w++) {
    if ([...S.games.values()].some(g => g.week === w && !started(g))) return w;
  }
  return 19;
}

function fromDoc(id, d) {
  return { id, ...d, kickoff: d.kickoff ? d.kickoff.toDate() : null };
}

// ------------------------------------------------------------------- Punkte
function scores() {
  const perWeek = { anni: {}, olaf: {} };
  const reg = { anni: 0, olaf: 0 }, po = { anni: 0, olaf: 0 };
  const hit = { anni: [0, 0], olaf: [0, 0] };
  for (const g of S.games.values()) {
    if (!g.winner) continue;
    for (const p of Object.keys(PLAYERS)) {
      const c = p === S.me ? S.mine.get(g.id) : S.theirs.get(g.id);
      if (!c) continue;
      hit[p][1]++;
      perWeek[p][g.week] ??= 0;
      if (c === g.winner && g.winner !== "tie") {
        hit[p][0]++;
        perWeek[p][g.week]++;
        (g.round === "REG" ? reg : po)[p]++;
      }
    }
  }
  const wins = { anni: 0, olaf: 0, tie: 0 };
  for (const [w] of WEEKS) {
    const gs = [...S.games.values()].filter(g => g.week === w);
    if (!gs.length || gs.some(g => !g.winner)) continue;   // nur fertige Wochen
    const a = perWeek.anni[w] || 0, o = perWeek.olaf[w] || 0;
    wins[a > o ? "anni" : o > a ? "olaf" : "tie"]++;
  }
  return { perWeek, reg, po, hit, wins };
}

// ---------------------------------------------------------------- Anmelden
onAuthStateChanged(auth, async user => {
  unsub.splice(0).forEach(f => f());
  clearTimeout(syncTimer);
  syncTimer = null;
  Object.assign(S, { user, me: null, games: new Map(), mine: new Map(), tipped: new Set(),
    theirs: new Map(), at: new Map(), sync: { at: null, ok: null }, note: {} });
  if (!user) return renderLogin();
  wrap.innerHTML = `<p class="meta pad">Lade …</p>`;
  unsub.push(onSnapshot(doc(db, "meta", "players"), snap => {
    S.players = snap.exists() ? snap.data() : {};
    const me = Object.keys(PLAYERS).find(p => S.players[p] === user.uid) || null;
    if (me && me !== S.me) { S.me = me; start(); }
    if (!me) renderClaim();
  }, err => fail(err)));
});

async function login() {
  const provider = new GoogleAuthProvider();
  if (EMU) {
    return signInWithCredential(auth, GoogleAuthProvider.credential(
      JSON.stringify({ sub: EMU, email: EMU, email_verified: true })));
  }
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, provider);
    } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
      renderLogin(`Anmeldung fehlgeschlagen: ${e.code || e.message}`);
    }
  }
}

async function claim(p) {
  try {
    await runTransaction(db, async tx => {
      const ref = doc(db, "meta", "players");
      const snap = await tx.get(ref);
      const cur = snap.exists() ? snap.data() : {};
      if (cur[p]) throw new Error("vergeben");
      if (snap.exists()) tx.update(ref, { [p]: S.user.uid });
      else tx.set(ref, { [p]: S.user.uid });
    });
  } catch (e) {
    renderClaim(e.message === "vergeben" ? `${PLAYERS[p]} ist schon vergeben.`
      : "Das hat nicht geklappt. Bitte nochmal versuchen.");
  }
}

// ------------------------------------------------------------------- Laden
async function start() {
  unsub.push(onSnapshot(collection(db, "games"), { includeMetadataChanges: true }, async snap => {
    if (snap.empty && !snap.metadata.fromCache) return seed();
    snap.docChanges().forEach(ch => {
      if (ch.type === "removed") S.games.delete(+ch.doc.id);
      else S.games.set(+ch.doc.id, fromDoc(+ch.doc.id, ch.doc.data()));
    });
    await reveal();
    render();
    if (S.games.size && !S.sync.at && !syncTimer) loopSync();   // erster Abgleich gleich nach dem Laden
  }, err => fail(err)));

  unsub.push(onSnapshot(query(collection(db, "picks"), where("uid", "==", S.user.uid)), snap => {
    snap.docChanges().forEach(ch => {
      const d = ch.doc.data({ serverTimestamps: "estimate" });
      S.mine.set(+d.game, d.choice);
      if (d.at) S.at.set(`${d.game}_${S.me}`, d.at.toDate());
    });
    render();
  }, err => fail(err)));

  unsub.push(onSnapshot(collection(db, "tipped"), async snap => {
    snap.docChanges().forEach(ch => S.tipped.add(ch.doc.id));
    await reveal();
    render();
  }, err => fail(err)));

}

// Beim ersten Start den Spielplan aus schedule.json in die Datenbank schreiben.
let seeding = false;
async function seed() {
  if (seeding) return;
  seeding = true;
  wrap.innerHTML = `<p class="meta pad">Spielplan wird angelegt …</p>`;
  const rows = await (await fetch("schedule.json")).json();
  for (let i = 0; i < rows.length; i += 400) {
    const b = writeBatch(db);
    for (const r of rows.slice(i, i + 400)) {
      b.set(doc(db, "games", String(r.id)), {
        round: r.round, week: r.week, away: r.away, home: r.home,
        kickoff: r.kickoff ? Timestamp.fromDate(new Date(r.kickoff)) : null,
        date_hint: r.date_hint || null, info: r.info || "", winner: null,
        espn_id: null, away_score: null, home_score: null, status: null, detail: null, pre_wp: null,
      });
    }
    await b.commit();
  }
}

// Fremde Tipps einzeln holen, sobald das Spiel angepfiffen ist. Danach
// ändern sie sich nie mehr, deshalb merkt sich der Browser sie.
const cacheKey = () => `tippspiel:${firebaseConfig.projectId}:${other()}`;
// Papiertipps können sich bis zum 18.10. noch ändern, die nicht merken.
function loadCache() {
  try { return JSON.parse(localStorage.getItem(cacheKey()) || "{}"); } catch { return {}; }
}
function saveCache() {
  const o = other();
  const keep = [...S.theirs].filter(([id]) => !isBackfill(S.games.get(id) || {}))
    .map(([id, c]) => [id, [c, S.at.get(`${id}_${o}`)?.getTime() || 0]]);
  try { localStorage.setItem(cacheKey(), JSON.stringify(Object.fromEntries(keep))); } catch {}
}
let revealing = null, revealAgain = false;
async function reveal() {
  if (revealing) { revealAgain = true; return revealing; }   // läuft schon: danach nochmal
  revealing = (async () => {
    if (!S.theirs.size) {
      for (const [k, v] of Object.entries(loadCache())) {
        if (isBackfill(S.games.get(+k) || {})) continue;
        if (!Array.isArray(v) || !v[1]) continue;           // alte Einträge ohne Zeitpunkt neu holen
        S.theirs.set(+k, v[0]);
        S.at.set(`${k}_${other()}`, new Date(v[1]));
      }
    }
    const o = other();
    const todo = [...S.games.values()].filter(g =>
      started(g) && !S.theirs.has(g.id) && S.tipped.has(`${g.id}_${o}`));
    let got = false;
    for (let i = 0; i < todo.length; i += 20) {
      await Promise.all(todo.slice(i, i + 20).map(async g => {
        try {
          const snap = await getDoc(doc(db, "picks", `${g.id}_${o}`));
          if (snap.exists()) {
            S.theirs.set(g.id, snap.data().choice);
            if (snap.data().at) S.at.set(`${g.id}_${o}`, snap.data().at.toDate());
            got = true;
          }
        } catch { /* noch nicht freigegeben */ }
      }));
    }
    if (got) saveCache();
  })();
  try { await revealing; } finally { revealing = null; }
  if (revealAgain) { revealAgain = false; await reveal(); render(); }
}

// ------------------------------------------------------------ Live (ESPN)
function statusText(state, name, period, clock) {
  if (state === "in") {
    if (name === "STATUS_HALFTIME") return "Halbzeit";
    const q = period <= 4 ? `Q${period}` : "Verl.";
    if (name === "STATUS_END_PERIOD") return `Ende ${q}`;
    return `${q} · ${clock}`;
  }
  if (state === "post") return period > 4 ? "Ende n. V." : "Ende";
  if (name === "STATUS_POSTPONED" || name === "STATUS_DELAYED") return "verschoben";
  return null;
}

function parseEvent(e) {
  const c = e.competitions[0];
  const side = Object.fromEntries(c.competitors.map(t => [t.homeAway, t]));
  const typ = e.status.type;
  const team = k => { const a = side[k].team.abbreviation || ""; return ESPN_TEAM[a] || a; };
  const score = k => (typ.state !== "pre" && side[k].score !== undefined && side[k].score !== "")
    ? Number(side[k].score) : null;
  let winner = null;
  if (typ.completed) winner = side.home.winner ? "home" : side.away.winner ? "away" : "tie";
  return {
    espn_id: String(e.id), away: team("away"), home: team("home"),
    kickoff: c.timeValid === false ? null : new Date(e.date),
    state: typ.state, winner, away_score: score("away"), home_score: score("home"),
    detail: statusText(typ.state, typ.name, e.status.period || 0, e.status.displayClock || ""),
  };
}

async function syncWeek(w) {
  const [st, ew] = w <= 18 ? [2, w] : [3, ESPN_PLAYOFF[w]];
  const r = await fetch(`${ESPN}?seasontype=${st}&week=${ew}&dates=${SEASON}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  const events = ((await r.json()).events || []).map(parseEvent)
    .sort((a, b) => (a.kickoff || 0) - (b.kickoff || 0));
  const games = [...S.games.values()].filter(g => g.week === w).sort((a, b) => a.id - b.id);
  const byId = new Map(games.filter(g => g.espn_id).map(g => [g.espn_id, g]));
  const byTeams = new Map(games.filter(g => g.away).map(g => [`${g.away}@${g.home}`, g]));
  const free = games.filter(g => !g.away && !g.espn_id);
  const writes = [];
  for (const ev of events) {
    if (!ev.away || ev.away === "TBD" || ev.home === "TBD") continue;
    const g = byId.get(ev.espn_id) || byTeams.get(`${ev.away}@${ev.home}`) || free.shift();
    if (!g) continue;
    const patch = {};
    const set = (k, v) => { if ((g[k] ?? null) !== (v ?? null)) patch[k] = v ?? null; };
    set("espn_id", ev.espn_id); set("away", ev.away); set("home", ev.home);
    set("away_score", ev.away_score); set("home_score", ev.home_score);
    set("status", ev.state); set("detail", ev.detail);
    if (ev.winner) set("winner", ev.winner);
    if (ev.kickoff && ev.state === "pre" && !started(g)
        && (!g.kickoff || g.kickoff.getTime() !== ev.kickoff.getTime())) {
      patch.kickoff = Timestamp.fromDate(ev.kickoff);
    }
    if (Object.keys(patch).length) writes.push(updateDoc(doc(db, "games", String(g.id)), patch));
  }
  await Promise.all(writes);
}

// ESPN-Prognose vom Anpfiff einmal pro beendetem Spiel holen und speichern,
// für "ESPN als Mitspieler" und die Statistik.
async function fetchPreWp(espnId) {
  const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${espnId}`);
  if (!r.ok) return null;
  const d = await r.json();
  const wp = d.winprobability || [];
  if (wp.length) return Math.round(wp[0].homeWinPercentage * 1000) / 10;
  const h = parseFloat(d.predictor?.homeTeam?.gameProjection), a = parseFloat(d.predictor?.awayTeam?.gameProjection);
  return !isNaN(h) && !isNaN(a) && h + a > 0 ? Math.round(h / (h + a) * 1000) / 10 : null;
}
// Läuft nach dem eigentlichen Abgleich und nie mehr als 8 Spiele auf einmal,
// damit die Live-Stände nicht warten müssen. Lehnt die Datenbank das Feld ab
// (Regeln noch nicht veröffentlicht), wird es in dieser Sitzung nicht weiter versucht.
let preWpBlocked = false, preWpRunning = false;
const preWpTried = new Set();           // je Durchlauf nur einmal je Spiel versuchen
async function storePreWp() {
  if (preWpBlocked || preWpRunning) return;
  preWpRunning = true;
  preWpTried.clear();                   // Fehlgeschlagene beim nächsten Abgleich erneut versuchen
  try {
    // in Sechserpaketen, bis alles da ist; läuft im Hintergrund
    for (;;) {
      const todo = [...S.games.values()]
        .filter(g => g.status === "post" && g.espn_id && g.pre_wp == null && !preWpTried.has(g.id))
        .sort((a, b) => b.kickoff - a.kickoff).slice(0, 6);
      if (!todo.length || preWpBlocked) break;
      await Promise.all(todo.map(async g => {
        preWpTried.add(g.id);
        try {
          const v = await fetchPreWp(g.espn_id);
          if (v != null) await updateDoc(doc(db, "games", String(g.id)), { pre_wp: v });
        } catch (e) {
          if (e.code === "permission-denied") preWpBlocked = true;
        }
      }));
    }
  } finally { preWpRunning = false; }
}

function weeksToSync() {
  const soon = new Date(Date.now() + 8 * 864e5);
  const weeks = new Set();
  for (const g of S.games.values()) {
    const when = g.kickoff || (g.date_hint ? new Date(`${g.date_hint}T12:00:00Z`) : null);
    if (!g.winner && when && when <= soon) weeks.add(g.week);
  }
  // laufende und aktuelle Wochen zuerst, dann der Rest
  const live = w => [...S.games.values()].some(g => g.week === w && !g.winner && started(g));
  const cur = currentWeek();
  return [...weeks].sort((a, b) => (live(b) - live(a)) || ((b === cur) - (a === cur)) || a - b);
}

function somethingLive() {
  const since = Date.now() - 5 * 3600e3;
  return [...S.games.values()].some(g => !g.winner && (g.status === "in"
    || (g.kickoff && g.kickoff.getTime() > since && g.kickoff <= now())));
}

let syncing = false;
async function syncAll() {
  if (syncing) return;
  syncing = true;
  S.syncBusy = true;
  render();
  let ok = true;
  try {
    for (const w of weeksToSync()) {
      try { await syncWeek(w); } catch (e) { ok = false; console.warn(`ESPN Woche ${w}:`, e); }
    }
    S.sync = { at: now(), ok };
  } finally {
    syncing = false;
    S.syncBusy = false;
    render();
  }
  storePreWp();                          // im Hintergrund, blockiert nichts
}

let syncTimer = null;
async function loopSync() {
  clearTimeout(syncTimer);
  syncTimer = -1;
  if (!S.me) return;
  if (S.games.size && document.visibilityState === "visible") await syncAll();
  syncTimer = setTimeout(loopSync, (somethingLive() || !S.games.size) ? 60e3 : 15 * 60e3);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.me) loopSync();
});

// ------------------------------------------------------------ Wochensieger
function weekResult(w, sc = scores()) {
  const gs = [...S.games.values()].filter(g => g.week === w);
  const graded = gs.filter(g => g.winner).length;
  return { a: sc.perWeek.anni[w] || 0, o: sc.perWeek.olaf[w] || 0, graded,
           total: gs.length, done: gs.length > 0 && graded === gs.length };
}
function weekBanner(w, sc) {
  const r = weekResult(w, sc);
  if (!r.graded) return "";
  const name = w <= 18 ? `Woche ${w}` : (WEEKS.find(([x]) => x === w) || [, ""])[1];
  if (r.done) {
    if (r.a === r.o) return `<div class="banner tie">🤝 ${name} endet unentschieden, ${r.a}:${r.o}</div>`;
    const who = r.a > r.o ? "anni" : "olaf";
    return `<div class="banner win ${who}">🏆 <strong>${PLAYERS[who]}</strong> gewinnt ${name}
      mit ${Math.max(r.a, r.o)}:${Math.min(r.a, r.o)}</div>`;
  }
  return `<div class="banner live">Zwischenstand ${name}: <span class="anni">Anni ${r.a}</span> ·
    <span class="olaf">Olaf ${r.o}</span> <span class="muted">(${r.graded} von ${r.total} gewertet)</span></div>`;
}

// ESPN als dritter Mitspieler: tippt immer den Favoriten laut Prognose vom Anpfiff.
const espnPick = g => (g.pre_wp == null || g.pre_wp === 50) ? null : g.pre_wp > 50 ? "home" : "away";
function espnStats() {
  let ok = 0, n = 0;
  const perWeek = {};
  for (const g of S.games.values()) {
    const p = g.winner && espnPick(g);
    if (!p) continue;
    n++;
    perWeek[g.week] ??= 0;
    if (p === g.winner) { ok++; perWeek[g.week]++; }
  }
  return { hit: [ok, n], perWeek };
}

// ------------------------------------------------------------- Erinnerung
// Offene Spiele in den nächsten 36 Stunden ohne eigenen Tipp.
function reminder() {
  const soon = Date.now() + 36 * 3600e3;
  const due = [...S.games.values()].filter(g => g.away && g.home && g.kickoff && !started(g)
    && g.kickoff.getTime() <= soon && !S.mine.has(g.id)).sort((a, b) => a.kickoff - b.kickoff);
  if (!due.length) return "";
  const b = berlin(due[0].kickoff);
  const n = due.length === 1 ? "1 Spiel wartet" : `${due.length} Spiele warten`;
  return `<a class="banner remind" href="#woche=${due[0].week}">⏰ ${n} noch auf deinen Tipp,
    das erste beginnt ${b.wd} ${b.day} um ${b.time} Uhr</a>`;
}

// Kalenderdatei: pro Woche eine Erinnerung 2 Stunden vor dem ersten Spiel und,
// wenn das deutlich früher ist, eine weitere vor den Sonntagsspielen.
function icsFile() {
  const fmt = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const url = location.origin + location.pathname;
  const events = [];
  for (const [w, label] of WEEKS) {
    const gs = [...S.games.values()].filter(g => g.week === w && g.kickoff && g.kickoff > now())
      .sort((a, b) => a.kickoff - b.kickoff);
    if (!gs.length) continue;
    const times = [gs[0].kickoff];
    const sunday = gs.find(g => berlin(g.kickoff).wd === "So");
    if (sunday && sunday.kickoff - gs[0].kickoff > 24 * 3600e3) times.push(sunday.kickoff);
    for (const k of times) {
      const start = new Date(k.getTime() - 2 * 3600e3);
      events.push(["BEGIN:VEVENT", `UID:tippspiel-${w}-${k.getTime()}@nfl-gameplan`,
        `DTSTAMP:${fmt(now())}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(new Date(start.getTime() + 15 * 60e3))}`,
        `SUMMARY:🏈 Tippspiel: ${label} tippen`, `DESCRIPTION:Erstes Spiel um ${berlin(k).time} Uhr. ${url}`,
        `URL:${url}`, "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Tippspiel", "TRIGGER:PT0M",
        "END:VALARM", "END:VEVENT"].join("\r\n"));
    }
  }
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tippspiel Anni vs. Olaf//DE",
    "CALSCALE:GREGORIAN", "X-WR-CALNAME:NFL-Tippspiel", ...events, "END:VCALENDAR"].join("\r\n");
}
function downloadIcs() {
  const blob = new Blob([icsFile()], { type: "text/calendar;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "tippspiel-erinnerungen.ics";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ------------------------------------------------------ Bilanz & Siegchance
// Bilanz eines Teams vor diesem Spiel, aus den eingetragenen Ergebnissen der
// Regular Season. Für kommende Spiele ist das der aktuelle Stand.
function record(team, g) {
  const until = g.kickoff || (g.date_hint ? new Date(`${g.date_hint}T23:59:59Z`) : null);
  let w = 0, l = 0, t = 0;
  for (const x of S.games.values()) {
    if (x.round !== "REG" || !x.winner || x.id === g.id) continue;
    if (x.away !== team && x.home !== team) continue;
    if (until && x.kickoff && x.kickoff >= until) continue;
    if (x.winner === "tie") t++;
    else if (x[x.winner] === team) w++;
    else l++;
  }
  return t ? `${w}:${l}:${t}` : `${w}:${l}`;
}

// Vor dem Spiel ESPN-Prognose, währenddessen Live-Wert, danach der Wert vom Anpfiff.
async function loadWp(g) {
  const old = S.wp.get(g.id);
  const age = old ? Date.now() - old.at : Infinity;
  if (old && (old.final || age < (g.status === "in" ? 55e3 : 30 * 60e3))) return false;
  if (g.status === "post" && g.pre_wp != null) {
    S.wp.set(g.id, { home: g.pre_wp, away: 100 - g.pre_wp, pre: g.pre_wp, live: false, at: Date.now(), final: true });
    return true;
  }
  S.wp.set(g.id, { ...(old || { home: null }), at: Date.now() });   // nicht bei jedem Rendern neu fragen
  const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${g.espn_id}`);
  if (!r.ok) return false;
  const d = await r.json();
  const wp = d.winprobability || [];
  let home = null, live = false, pre = null;
  if (d.predictor && d.predictor.homeTeam) {
    const h = parseFloat(d.predictor.homeTeam.gameProjection), a = parseFloat(d.predictor.awayTeam.gameProjection);
    if (!isNaN(h) && !isNaN(a) && h + a > 0) pre = h / (h + a) * 100;
  }
  if (pre == null && wp.length) pre = wp[0].homeWinPercentage * 100;   // Wert zum Anpfiff
  if (g.status === "in" && wp.length) { home = wp[wp.length - 1].homeWinPercentage * 100; live = true; }
  else home = pre;
  if (home == null || isNaN(home)) return false;
  S.wp.set(g.id, { home, away: 100 - home, pre, live, at: Date.now(), final: g.status === "post" });
  return true;
}

let wpBusy = false;
// Lädt auch ohne den Siegchance-Knopf: die Wochen-Prognose braucht die Werte.
async function ensureWp(week) {
  if (wpBusy) return;
  wpBusy = true;
  try {
    const gs = [...S.games.values()].filter(g => g.week === week && g.espn_id);
    const got = await Promise.all(gs.map(g => loadWp(g).catch(() => false)));
    if (got.some(Boolean)) render();
  } finally { wpBusy = false; }
}

// ------------------------------------------------- Siegchance der Woche
// Wahrscheinlichkeit, dass Anni bzw. Olaf die Woche gewinnt. Pro Spiel zählt
// nur, ob die Tipps verschieden sind und wer davon richtig liegt; daraus
// ergibt sich die Verteilung der Punktdifferenz (exakt, per Faltung).
// Spiele vor Anpfiff zählen für beide gleich (beide Tipps unbekannt, auch der
// eigene): so haben vor der Woche beide exakt dieselbe Chance, nichts Geheimes
// fließt ein und beide Geräte zeigen dasselbe. Erst mit Anpfiff zählen die
// echten Tipps.
const preProb = g => g.pre_wp ?? S.wp.get(g.id)?.pre ?? 50;
function pickDist(p, g, q, actual) {
  if (!actual) return { home: q, away: 1 - q };
  const c = p === S.me ? S.mine.get(g.id) : S.theirs.get(g.id);
  if (c) return { [c]: 1 };
  const hidden = p !== S.me && S.tipped.has(`${g.id}_${p}`);   // getippt, aber noch nicht geladen
  if (!hidden) return {};                                        // kein Tipp
  return { home: q, away: 1 - q };
}
function weekOdds(games, probOf, resultOf, actualOf = g => started(g)) {
  let dist = new Map([[0, 1]]);
  for (const g of games) {
    if (!g.away || !g.home) continue;
    const res = resultOf(g), q = Math.min(1, Math.max(0, probOf(g) / 100));
    const act = actualOf(g);
    const pa = pickDist("anni", g, q, act), po = pickDist("olaf", g, q, act);
    const step = { 1: 0, 0: 0, [-1]: 0 };
    for (const [w, pw] of res ? [[res, 1]] : [["home", q], ["away", 1 - q]]) {
      const sa = w === "tie" ? 0 : pa[w] || 0, so = w === "tie" ? 0 : po[w] || 0;
      step[1] += pw * sa * (1 - so);
      step[-1] += pw * (1 - sa) * so;
      step[0] += pw * (sa * so + (1 - sa) * (1 - so));
    }
    const next = new Map();
    for (const [d, pd] of dist) for (const k of [1, 0, -1]) {
      if (step[k]) next.set(d + k, (next.get(d + k) || 0) + pd * step[k]);
    }
    dist = next;
  }
  let a = 0, o = 0, t = 0;
  for (const [d, pd] of dist) d > 0 ? (a += pd) : d < 0 ? (o += pd) : (t += pd);
  return { a: a * 100, o: o * 100, t: t * 100 };
}
// Verlauf: vor der Woche, nach jedem beendeten Spiel, live
function weekOddsSteps(week) {
  const games = [...S.games.values()].filter(g => g.week === week && g.away && g.home)
    .sort((a, b) => (a.kickoff || 0) - (b.kickoff || 0) || a.id - b.id);
  const done = games.filter(g => g.winner);
  // Historische Punkte: nur die bis dahin beendeten Spiele zählen mit echten Tipps
  const steps = [{ label: "Vor der Woche", ...weekOdds(games, preProb, () => null, () => false) }];
  done.forEach((g, i) => {
    const fixed = new Set(done.slice(0, i + 1).map(x => x.id));
    const win = g.winner === "tie" ? "Unentschieden" : g[g.winner];
    steps.push({ label: `nach ${g.away} @ ${g.home}`, sub: `Sieger ${win}`,
      ...weekOdds(games, preProb, x => (fixed.has(x.id) ? x.winner : null), x => fixed.has(x.id)) });
  });
  const running = games.filter(g => !g.winner && started(g));
  if (running.length) {
    steps.push({ label: "Jetzt (live)", sub: `${running.length} ${running.length === 1 ? "Spiel läuft" : "Spiele laufen"}`, live: true,
      ...weekOdds(games, g => (S.wp.get(g.id)?.live ? S.wp.get(g.id).home : preProb(g)), x => x.winner || null) });
  }
  return { steps, games, done: games.length > 0 && done.length === games.length };
}

function oddsCard(week) {
  const { steps, games, done } = weekOddsSteps(week);
  if (!games.length) return "";
  const anyPick = games.some(g => S.mine.has(g.id) || S.theirs.has(g.id));
  if (!anyPick) return "";
  const now = steps[steps.length - 1], first = steps[0];
  const pct = v => `${Math.round(v)} %`;
  let head;
  if (done) {
    const w = now.a > 50 ? "anni" : now.o > 50 ? "olaf" : null;
    // Auswertung: wie knapp war es? Tiefster Stand des Siegers im Verlauf
    const low = w ? steps.reduce((m, st, i) => (st[w === "anni" ? "a" : "o"] < m.v ? { v: st[w === "anni" ? "a" : "o"], i } : m), { v: 101, i: 0 }) : null;
    head = `<p class="oddsres">${w ? `<strong class="${w}">${PLAYERS[w]}</strong> hat die Woche gewonnen.
      ${low && low.v < 50 ? `Zwischendurch lag die Chance nur bei <strong>${pct(low.v)}</strong> (${esc(steps[low.i].label)}).`
        : "Die Chance lag nie unter 50 %."}` : "Die Woche endet unentschieden."}</p>`;
  } else {
    head = `<span class="oddsnum"><span class="anni">Anni ${pct(now.a)}</span>
      <span class="muted">Remis ${pct(now.t)}</span><span class="olaf">Olaf ${pct(now.o)}</span></span>
      ${!games.some(started) ? `<span class="muted oddssub">Noch kein Spiel angepfiffen – beide haben die gleiche Chance.</span>` : ""}`;
  }
  return `<div class="odds">
    <div class="oddshead"><span class="tl">Siegchance der Woche${now.live ? ` <i class="livedot"></i>live` : ""}</span>${head}</div>
    <div class="oddsbar" role="img" aria-label="Anni ${pct(now.a)}, Remis ${pct(now.t)}, Olaf ${pct(now.o)}">
      <i class="anni" style="width:${now.a}%"></i><i class="tie" style="width:${now.t}%"></i><i class="olaf" style="width:${now.o}%"></i></div>
    ${steps.length > 1 ? `<div class="chart oddschart" id="oddschart" data-keep></div>` : ""}
    <p class="meta oddsnote">Aus ESPN-Siegchancen und euren Tipps. Spiele zählen ab ihrem Anpfiff.</p>
  </div>`;
}

// Gestapelte Fläche wie der Balken: Anni oben, Remis in der Mitte, Olaf unten.
function drawOdds(el, steps) {
  const W = Math.max(280, el.clientWidth), H = 190;
  const key = JSON.stringify([W, steps.map(s => [s.label, Math.round(s.a), Math.round(s.o), Math.round(s.t)])]);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const m = { t: 10, r: 78, b: 22, l: 42 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = i => m.l + (steps.length === 1 ? iw / 2 : i * iw / (steps.length - 1));
  const y = v => m.t + ih - v / 100 * ih;
  // Grenzen von unten: 0 | Olaf | Olaf+Remis | 100
  const lo = steps.map(st => st.o), mid = steps.map(st => st.o + st.t);
  const band = (top, bot) => `M${top.map((v, i) => `${x(i)},${y(v)}`).join("L")}` +
    `L${[...bot].reverse().map((v, i) => `${x(bot.length - 1 - i)},${y(v)}`).join("L")}Z`;
  const ones = steps.map(() => 100), zeros = steps.map(() => 0);
  let grid = "";
  for (const v of [0, 50, 100]) grid += `<text class="ax" x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v} %</text>`;
  const xl = `<text class="ax" x="${m.l}" y="${H - 6}">Start</text>
    <text class="ax" x="${m.l + iw}" y="${H - 6}" text-anchor="end">${steps[steps.length - 1].live ? "jetzt" : "Ende"}</text>`;
  const last = steps[steps.length - 1];
  const tags = [
    { cls: "anni", name: "Anni", v: last.a, c: last.o + last.t + last.a / 2 },
    { cls: "espn", name: "Remis", v: last.t, c: last.o + last.t / 2 },
    { cls: "olaf", name: "Olaf", v: last.o, c: last.o / 2 },
  ].map(t => ({ ...t, y: y(t.c) }));
  for (let i = 1; i < tags.length; i++) if (tags[i].y - tags[i - 1].y < 14) tags[i].y = tags[i - 1].y + 14;
  const over = tags[tags.length - 1].y - (m.t + ih);
  if (over > 0) tags.forEach(t => (t.y -= over));
  el.innerHTML = `
    <div class="legend"><span class="lg anni"><i></i>Anni gewinnt</span><span class="lg tie"><i></i>Remis</span>
      <span class="lg olaf"><i></i>Olaf gewinnt</span></div>
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Siegchance der Woche: Anni ${Math.round(last.a)} Prozent, Remis ${Math.round(last.t)} Prozent, Olaf ${Math.round(last.o)} Prozent">
      <path class="area anni" d="${band(ones, mid)}"/>
      <path class="area tie" d="${band(mid, lo)}"/>
      <path class="area olaf" d="${band(lo, zeros)}"/>
      <path class="edge" d="M${mid.map((v, i) => `${x(i)},${y(v)}`).join("L")}"/>
      <path class="edge" d="M${lo.map((v, i) => `${x(i)},${y(v)}`).join("L")}"/>
      <line class="half" x1="${m.l}" x2="${m.l + iw}" y1="${y(50)}" y2="${y(50)}"/>
      ${grid}${xl}<line class="cross" y1="${m.t}" y2="${m.t + ih}" x1="-10" x2="-10"/>
      ${tags.map(t => `<text class="tag ${t.cls}" x="${m.l + iw + 8}" y="${t.y + 4}">${t.name} ${Math.round(t.v)} %</text>`).join("")}
      <rect class="hit" x="${m.l - 10}" y="0" width="${iw + 20}" height="${H}"/>
    </svg>
    <div class="tip" hidden></div>`;
  const svg = el.querySelector("svg"), tip = el.querySelector(".tip"), cross = el.querySelector(".cross");
  const show = ev => {
    const r = svg.getBoundingClientRect();
    const i = steps.length === 1 ? 0 : Math.max(0, Math.min(steps.length - 1, Math.round((ev.clientX - r.left - m.l) / iw * (steps.length - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
    const st = steps[i];
    tip.innerHTML = `<b>${esc(st.label)}</b>${st.sub ? `<small class="tsub">${esc(st.sub)}</small>` : ""}
      <span class="tr"><i class="anni"></i>Anni<em>${Math.round(st.a)} %</em></span>
      <span class="tr"><i class="tie"></i>Remis<em>${Math.round(st.t)} %</em></span>
      <span class="tr"><i class="olaf"></i>Olaf<em>${Math.round(st.o)} %</em></span>`;
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max(x(i) - tip.offsetWidth / 2, 0), W - tip.offsetWidth)}px`;
  };
  const hide = () => { tip.hidden = true; cross.setAttribute("x1", -10); cross.setAttribute("x2", -10); };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", hide);
}

// ------------------------------------------------------------ Neu laden
// Alles frisch: gemerkte Tipps des anderen, Datenbank-Zwischenspeicher und
// Browser-Caches weg, dann die Seite mit neuer Adresse laden (umgeht auch
// den Cache für index.html). Gemerkt bleiben nur Einstellungen.
let refreshing = false;
async function hardRefresh() {
  if (refreshing) return;
  refreshing = true;
  S.syncBusy = true;
  render();
  const keep = new Set(["tippspiel:intro", "tippspiel:wp", "tippspiel:filter"]);
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith("tippspiel:") && !keep.has(k)) localStorage.removeItem(k);
  } catch {}
  try { if (window.caches) for (const k of await caches.keys()) await caches.delete(k); } catch {}
  try { unsub.splice(0).forEach(f => f()); await terminate(db); await clearIndexedDbPersistence(db); } catch {}
  const q = new URLSearchParams(location.search);
  q.set("v", Date.now());
  location.replace(`${location.pathname}?${q}${location.hash}`);
}

// ---------------------------------------------------------------- Aktionen
async function pick(gid, choice) {
  const g = S.games.get(gid);
  if (!g || started(g)) return;
  const before = S.mine.get(gid);
  S.mine.set(gid, choice);
  delete S.note[gid];
  render();
  try {
    const b = writeBatch(db);
    b.set(doc(db, "picks", `${gid}_${S.me}`),
      { game: String(gid), player: S.me, uid: S.user.uid, choice, at: serverTimestamp() });
    b.set(doc(db, "tipped", `${gid}_${S.me}`), { game: String(gid), player: S.me });
    await b.commit();
  } catch (e) {
    if (before) S.mine.set(gid, before); else S.mine.delete(gid);
    S.note[gid] = e.code === "permission-denied" ? "Das Spiel läuft schon."
      : "Tipp konnte nicht gespeichert werden.";
    render();
  }
}

async function backfill(gid, p, choice) {
  const g = S.games.get(gid);
  if (!g || !isBackfill(g) || !S.players[p]) return;
  const map = p === S.me ? S.mine : S.theirs;
  const before = map.get(gid);
  map.set(gid, choice);
  S.tipped.add(`${gid}_${p}`);
  delete S.note[gid];
  render();
  try {
    const b = writeBatch(db);
    b.set(doc(db, "picks", `${gid}_${p}`),
      { game: String(gid), player: p, uid: S.players[p], choice, at: serverTimestamp() });
    b.set(doc(db, "tipped", `${gid}_${p}`), { game: String(gid), player: p });
    await b.commit();
  } catch {
    if (before) map.set(gid, before); else map.delete(gid);
    S.note[gid] = "Konnte nicht gespeichert werden.";
    render();
  }
}

// Einmaliger Import vom Papierzettel (Wochen 1-2 und erstes Spiel Woche 3),
// von Olaf bestätigt. Spiel-ID -> [Anni, Olaf]. Kann nach dem Import raus.
const ZETTEL = { 1: ["SEA", "NE"], 2: ["SF", "LAR"], 3: ["CHI", "CHI"], 4: ["TB", "CIN"], 5: ["BAL", "BAL"], 6: ["BUF", "BUF"], 7: ["DET", "NO"], 8: ["TEN", "TEN"], 9: ["PIT", "ATL"], 10: ["JAX", "JAX"], 11: ["LAC", "LAC"], 12: ["GB", "GB"], 13: ["MIA", "LV"], 14: ["PHI", "PHI"], 15: ["NYG", "NYG"], 16: ["KC", "KC"], 17: ["BUF", "BUF"], 18: ["MIN", "CHI"], 19: ["PHI", "PHI"], 20: ["GB", "GB"], 21: ["ATL", "CAR"], 22: ["BAL", "BAL"], 23: ["CIN", "CIN"], 24: ["TB", "TB"], 25: ["PIT", "NE"], 26: ["LAC", "LAC"], 27: ["DEN", "DEN"], 28: ["WAS", "DAL"], 29: ["SEA", "SEA"], 30: ["SF", "SF"], 31: ["KC", "KC"], 32: ["LAR", "NYG"], 33: ["GB", "GB"] };
function zettelPending() {
  return Object.entries(ZETTEL).filter(([id, [a, o]]) => {
    const g = S.games.get(+id);
    if (!g || !isBackfill(g)) return false;
    const want = t => (t === g.away ? "away" : t === g.home ? "home" : null);
    const cur = p => (p === S.me ? S.mine : S.theirs).get(+id);
    return cur("anni") !== want(a) || cur("olaf") !== want(o);
  }).length;
}
async function importZettel() {
  if (!S.players.anni || !S.players.olaf) {
    S.zettelMsg = "Beide müssen sich zuerst einmal angemeldet haben.";
    return render();
  }
  S.zettelMsg = "Wird übernommen …";
  render();
  // Pro Spiel ein eigener Schreibvorgang: Firestore erlaubt je Vorgang nur
  // wenige Regel-Lookups, alles auf einmal würde abgelehnt.
  let n = 0, failed = 0;
  await Promise.all(Object.entries(ZETTEL).map(async ([id, picks]) => {
    const g = S.games.get(+id);
    if (!g || !isBackfill(g)) return;
    const b = writeBatch(db);
    const done = [];
    ["anni", "olaf"].forEach((p, i) => {
      const choice = picks[i] === g.away ? "away" : picks[i] === g.home ? "home" : null;
      if (!choice) return;
      b.set(doc(db, "picks", `${id}_${p}`),
        { game: String(id), player: p, uid: S.players[p], choice, at: serverTimestamp() });
      b.set(doc(db, "tipped", `${id}_${p}`), { game: String(id), player: p });
      done.push([p, choice]);
    });
    try {
      await b.commit();
      for (const [p, choice] of done) {
        (p === S.me ? S.mine : S.theirs).set(+id, choice);
        S.tipped.add(`${id}_${p}`);
        n++;
      }
    } catch { failed++; }
  }));
  S.zettelMsg = failed ? `${n} Tipps übernommen, ${failed} Spiele hat die Datenbank abgelehnt. Bitte nochmal tippen.`
    : `✓ ${n} Tipps vom Zettel übernommen.`;
  render();
}

// Beim Öffnen der Nachtrage-Seite die Papiertipps des anderen frisch holen.
async function refreshBackfill() {
  const o = other();
  await Promise.all([...S.games.values()].filter(isBackfill).map(async g => {
    try {
      const snap = await getDoc(doc(db, "picks", `${g.id}_${o}`));
      if (snap.exists()) S.theirs.set(g.id, snap.data().choice);
    } catch { /* gibt es noch nicht */ }
  }));
  render();
}

async function patchGame(gid, patch) {
  try {
    await updateDoc(doc(db, "games", String(gid)), patch);
  } catch {
    S.note[gid] = "Konnte nicht gespeichert werden.";
    render();
  }
}

document.addEventListener("click", e => {
  const b = e.target.closest("[data-act]");
  if (!b || b.disabled || b.tagName === "FORM") return;
  if (b.tagName === "A") e.preventDefault();
  const gid = +b.dataset.game;
  const act = b.dataset.act;
  if (act === "login") login();
  else if (act === "logout") signOut(auth);
  else if (act === "claim") claim(b.dataset.player);
  else if (act === "pick") pick(gid, b.dataset.choice);
  else if (act === "winner") patchGame(gid, { winner: b.dataset.choice });
  else if (act === "backfill") backfill(gid, b.dataset.player, b.dataset.choice);
  else if (act === "zettel") importZettel();
  else if (act === "sync") hardRefresh();
  else if (act === "ics") downloadIcs();
  else if (act === "intro-done") {
    try { localStorage.setItem("tippspiel:intro", "1"); } catch {}
    if (location.hash === "#hilfe") location.hash = ""; else render();
  }
  else if (act === "filter") {
    const { group, filter } = b.dataset;
    if (filter === "all") S.filter = { status: [], tips: [] };
    else {
      const cur = S.filter[group];
      S.filter = { ...S.filter, [group]: cur.includes(filter) ? cur.filter(k => k !== filter) : [...cur, filter] };
    }
    try { localStorage.setItem("tippspiel:filter", JSON.stringify(S.filter)); } catch {}
    render();
  }
  else if (act === "wp") {
    S.showWp = !S.showWp;
    try { localStorage.setItem("tippspiel:wp", S.showWp ? "1" : "0"); } catch {}
    render();
  }
});

document.addEventListener("submit", e => {
  const f = e.target;
  e.preventDefault();
  const gid = +f.dataset.game;
  if (f.dataset.act === "zeit") {
    const v = f.elements.kickoff.value;
    if (v) patchGame(gid, { kickoff: Timestamp.fromDate(fromBerlinLocal(v)) });
  } else if (f.dataset.act === "teams") {
    const t = s => s.trim().toUpperCase().slice(0, 3);
    patchGame(gid, { away: t(f.elements.away.value), home: t(f.elements.home.value) });
  }
});

document.addEventListener("change", e => {
  if (e.target.id === "w") location.hash = `#woche=${e.target.value}`;
});
window.addEventListener("hashchange", () => {
  if (location.hash.startsWith("#nachtragen") && S.me) refreshBackfill();
  render();
});

function fail(err) {
  console.error(err);
  wrap.innerHTML = `<header class="hero hero-login"><h1>Tippspiel</h1>
    <p class="err">Keine Verbindung zur Datenbank (${esc(err.code || err.message)}).</p></header>
    <button data-act="logout">Abmelden</button>`;
}

// ------------------------------------------------------------------ Views
function renderLogin(err = "") {
  wrap.innerHTML = `
    <header class="hero hero-login">
      <p class="kicker">🏈 NFL 2026/27</p>
      <h1>Tippspiel</h1>
      <p class="versus"><span class="anni">Anni</span> <span class="vs">vs.</span> <span class="olaf">Olaf</span></p>
      <p class="lede">Jede Woche den Sieger tippen. Live-Ergebnisse, geheime Tipps bis zum Anpfiff.</p>
    </header>
    <div class="login">
      ${err ? `<p class="err">${esc(err)}</p>` : ""}
      <button class="google" data-act="login"><span class="g">G</span> Mit Google anmelden</button>
    </div>`;
}

function renderClaim(err = "") {
  const free = Object.keys(PLAYERS).filter(p => !S.players[p]);
  wrap.innerHTML = `
    <header class="hero hero-login">
      <h1>Tippspiel</h1>
      <p class="lede">Angemeldet als ${esc(S.user.email)}.</p>
    </header>
    <div class="login">
      ${free.length ? `
        <fieldset><legend>Wer bist du? Das legst du einmal fest.</legend>
          <div class="who">${free.map(p =>
            `<button class="whobtn ${p}" data-act="claim" data-player="${p}"><span>${PLAYERS[p]}</span></button>`
          ).join("")}</div>
        </fieldset>`
      : `<p class="err">Beide Plätze sind schon vergeben. Mit einem anderen Konto anmelden?</p>`}
      ${err ? `<p class="err">${esc(err)}</p>` : ""}
      <button class="quietbtn" data-act="logout">Abmelden</button>
    </div>`;
}

const WEEK_SHORT = { 19: "WC", 20: "DIV", 21: "CONF", 22: "SB" };

// Kopfzeile plus Wochenleiste. week = angezeigte Woche (null auf Tabelle/Statistik).
function nav(week) {
  const cur = currentWeek();
  const sc = scores();
  const pills = WEEKS.map(([w, l]) => {
    const r = weekResult(w, sc);
    const cls = ["wk"];
    if (w === cur) cls.push("cur");
    if (w === week) cls.push("sel");
    if (r.done) cls.push(r.a > r.o ? "won-anni" : r.o > r.a ? "won-olaf" : "won-tie");
    else if (w < cur) cls.push("past");
    return `<a class="${cls.join(" ")}" href="#woche=${w}" aria-label="${l}${w === cur ? ", aktuelle Woche" : ""}"
      ${w === week ? 'aria-current="page"' : ""}>${w === cur ? '<span class="now">jetzt</span>' : ""}${WEEK_SHORT[w] || w}</a>`;
  }).join("");
  return `
    <nav class="nav">
      <a href="#woche=${cur}" class="brand">🏈 Tippspiel</a>
      <a href="#tabelle" class="navlink${location.hash === "#tabelle" ? " on" : ""}">Tabelle</a>
      <a href="#statistik" class="navlink${location.hash === "#statistik" ? " on" : ""}">Statistik</a>
    </nav>
    <div class="weeks" role="navigation" aria-label="Spielwochen">${pills}</div>`;
}

// Die angezeigte Woche in der Leiste mittig halten.
// Nur wenn sich die Seite ändert, sonst nicht ins Wischen des Nutzers funken.
let centeredFor = null;
function centerWeek() {
  const strip = wrap.querySelector(".weeks");
  const el = strip && (strip.querySelector(".wk.sel") || strip.querySelector(".wk.cur"));
  const key = location.hash + "|" + (el && el.textContent);
  if (!el || key === centeredFor) return;
  centeredFor = key;
  strip.scrollLeft = el.offsetLeft - strip.clientWidth / 2 + el.offsetWidth / 2;
}

// Neue Ansicht einspielen, aber nur geänderte Knoten anfassen. So bleiben
// Logos, Fokus und Scrollpositionen stehen, statt bei jedem Abgleich neu zu laden.
function paint(html) {
  const next = document.createElement("div");
  next.innerHTML = html;
  morph(wrap, next);
}
function morph(from, to) {
  const a = [...from.childNodes], b = [...to.childNodes];
  b.forEach((y, i) => {
    const x = a[i];
    if (!x) return from.appendChild(y);
    if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName) return from.replaceChild(y, x);
    if (x.nodeType !== 1) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; return; }
    if (x.isEqualNode(y)) return;
    if (x.hasAttribute("data-keep") && y.hasAttribute("data-keep")) return;   // malt sich selbst (Diagramm)
    for (const { name } of [...x.attributes]) if (!y.hasAttribute(name)) x.removeAttribute(name);
    for (const { name, value } of [...y.attributes]) if (x.getAttribute(name) !== value) x.setAttribute(name, value);
    if ("disabled" in x) x.disabled = y.disabled;
    morph(x, y);
  });
  for (let i = a.length - 1; i >= b.length; i--) from.removeChild(a[i]);
}

function footer() {
  return `<p class="meta helplink"><a href="#hilfe">So funktioniert's</a>
    ${backfillOpen() ? ` · <a href="#nachtragen">Papiertipps</a>` : ""}
    · <a href="#" data-act="logout">Abmelden (${PLAYERS[S.me]})</a></p>`;
}

function scoreboard(sc) {
  const a = sc.reg.anni + sc.po.anni, o = sc.reg.olaf + sc.po.olaf;
  const pos = a + o === 0 ? 50 : Math.round(a / (a + o) * 100);
  const lead = a === o ? "Gleichstand" : a > o ? `Anni führt mit ${a - o}` : `Olaf führt mit ${o - a}`;
  return `
    <header class="hero board">
      <div class="duel">
        <div class="side anni${S.me === "anni" ? " isme" : ""}">
          <span class="pname">Anni</span><span class="pts">${a}</span></div>
        <div class="side olaf${S.me === "olaf" ? " isme" : ""}">
          <span class="pts">${o}</span><span class="pname">Olaf</span></div>
      </div>
      <div class="bar"><div class="fill" style="width:${pos}%"></div>
        <div class="knob" style="left:${pos}%"></div></div>
      <p class="lead">${lead}</p>
    </header>`;
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!S.me || !S.games.size) return;
    const focus = document.activeElement;
    if (focus && focus.matches("input") && wrap.contains(focus)) return; // nicht beim Tippen stören
    const h = location.hash;
    let seen = true;
    try { seen = localStorage.getItem("tippspiel:intro") === "1"; } catch {}
    if (h === "#hilfe" || !seen) renderIntro();
    else if (h === "#tabelle") renderTable();
    else if (h.startsWith("#nachtragen") && backfillOpen()) renderBackfill(+(h.match(/nachtragen=(\d+)/) || [])[1]);
    else if (h === "#statistik") renderStats();
    else renderWeek(+(h.match(/woche=(\d+)/) || [])[1] || currentWeek());
    centerWeek();
  });
}

// Filter für die Spielwoche: zwei Gruppen, innerhalb "oder", zwischen den
// Gruppen "und". Der fremde Tipp ist erst nach Anpfiff bekannt,
// "unterschiedlich"/"gleich" gelten deshalb nur für angepfiffene Spiele.
const FILTER_GROUPS = {
  status: [
    ["open", "Offen", g => !started(g)],
    ["live", "Läuft", g => started(g) && !g.winner],
    ["done", "Beendet", g => !!g.winner],
  ],
  tips: [
    ["todo", "Ohne Tipp", g => !started(g) && !S.mine.has(g.id)],
    ["diff", "Unterschiedlich", g => S.mine.has(g.id) && S.theirs.has(g.id) && S.mine.get(g.id) !== S.theirs.get(g.id)],
    ["same", "Gleich", g => S.mine.has(g.id) && S.theirs.has(g.id) && S.mine.get(g.id) === S.theirs.get(g.id)],
  ],
};
function groupTest(group, keys) {
  const tests = FILTER_GROUPS[group].filter(([k]) => keys.includes(k)).map(f => f[2]);
  return g => !tests.length || tests.some(t => t(g));
}
function filterTest(f = S.filter) {
  const a = groupTest("status", f.status), b = groupTest("tips", f.tips);
  return g => a(g) && b(g);
}
const filterActive = () => S.filter.status.length + S.filter.tips.length > 0;

function renderWeek(n) {
  const games = [...S.games.values()].filter(g => g.week === n).sort((a, b) =>
    (a.kickoff ? 0 : 1) - (b.kickoff ? 0 : 1) || (a.kickoff || 0) - (b.kickoff || 0) || a.id - b.id);
  if (!games.length) {
    paint(nav(n) + `<p>Diese Woche gibt es nicht.</p>`);
    return;
  }
  const sc = scores();
  const playableAll = games.filter(g => g.away && g.home);
  const shown = filterActive() ? playableAll.filter(filterTest()) : games;
  // Anzahl je Chip: Spiele, die dieser Filter zusammen mit der anderen Gruppe ergibt
  const chip = (group, [key, label]) => {
    const on = S.filter[group].includes(key);
    const count = playableAll.filter(filterTest({ ...S.filter, [group]: [key] })).length;
    const off = !on && !count;
    return `<button class="fchip${on ? " on" : ""}" data-act="filter" data-group="${group}" data-filter="${key}"
      aria-pressed="${on}"${off ? " disabled" : ""}>${label}<span>${count}</span></button>`;
  };
  const chips = `<button class="fchip${filterActive() ? "" : " on"}" data-act="filter" data-filter="all"
      aria-pressed="${!filterActive()}">Alle<span>${playableAll.length}</span></button>
    <span class="fsep" aria-hidden="true"></span>
    ${FILTER_GROUPS.status.map(f => chip("status", f)).join("")}
    <span class="fsep" aria-hidden="true"></span>
    ${FILTER_GROUPS.tips.map(f => chip("tips", f)).join("")}`;
  const fname = [...FILTER_GROUPS.status, ...FILTER_GROUPS.tips]
    .filter(([k]) => S.filter.status.includes(k) || S.filter.tips.includes(k)).map(f => f[1]).join(" + ");
  const rows = [];
  let lastDay = null;
  for (const g of shown) {
    const b = g.kickoff ? berlin(g.kickoff) : null;
    const head = b ? `${b.wd} ${b.day}` : fmtHint(g.date_hint);
    if (head !== lastDay) { rows.push(`<li class="dayhead">${head}</li>`); lastDay = head; }
    rows.push(gameRow(g, b && b.time));
  }
  const label = ROUND_LABEL[games[0].round] || "Regular Season";
  const title = n <= 18 ? `Woche ${n}` : label;
  const done = games.filter(g => g.winner).length;
  const playable = games.filter(g => g.away && g.home);
  const tipped = playable.filter(g => S.mine.has(g.id)).length;
  const open = playable.filter(g => !started(g) && !S.mine.has(g.id)).length;
  const stand = open === 1 ? "1 Spiel wartet noch auf deinen Tipp"
    : open ? `${open} Spiele warten noch auf deinen Tipp`
    : tipped ? `${tipped} von ${playable.length} getippt` : "";
  document.title = `${title} - Tippspiel`;
  // Papiertipps nur in den Wochen erwähnen, in denen wirklich welche fehlen
  const paperMissing = backfillOpen() ? games.filter(isBackfill).reduce((k, g) =>
    k + (S.mine.has(g.id) ? 0 : 1) + (S.theirs.has(g.id) ? 0 : 1), 0) : 0;
  const cur = currentWeek();
  const badge = n === cur ? `<span class="curbadge">Aktuelle Woche</span>`
    : `<a class="tocur" href="#woche=${cur}">${n < cur ? "Zur aktuellen Woche →" : "← Zur aktuellen Woche"}</a>`;
  paint(nav(n) + (n === cur ? reminder() : "") + scoreboard(sc) + `
    <section class="week${n === cur ? " is-cur" : ""}">
      <div class="weekhead">${badge}</div>
      <h2>${title}<span class="wsub">${stand || (n <= 18 ? label : "")}
        ${done ? `&nbsp;·&nbsp; ${done} gewertet` : ""}</span></h2>
      ${weekBanner(n, sc)}
      ${oddsCard(n)}
      ${paperMissing ? `<a class="note paper" href="#nachtragen=${n}">📝 ${paperMissing === 1 ? "1 Papiertipp fehlt"
        : `${paperMissing} Papiertipps fehlen`} in dieser Woche noch – nachtragen</a>` : ""}
      <div class="tools">
        <button class="toggle sync-btn${S.syncBusy ? " busy" : ""}" data-act="sync" title="Alles neu laden: neueste Version, Daten und Ergebnisse">
          <span class="spin">↻</span> ${S.syncBusy ? "lädt …" : S.sync.at ? `Stand ${berlin(S.sync.at).time}` : "Aktualisieren"}</button>
        <button class="toggle" data-act="ics">⏰ Erinnerung</button>
        <button class="toggle${S.showWp ? " on" : ""}" data-act="wp" aria-pressed="${S.showWp}">
          ${S.showWp ? "✓ " : ""}Siegchance</button>
      </div>
      <div class="filters" role="group" aria-label="Spiele filtern">${chips}</div>
      <ul class="games">${rows.join("") || `<li class="nofilter">Keine Spiele für „${fname}“.
        <button class="linkbtn" data-act="filter" data-filter="all">Alle zeigen</button></li>`}</ul>
      ${S.showWp ? `<p class="meta wpnote">Siegchance laut ESPN: vor dem Spiel die Prognose,
        während des Spiels live.</p>` : ""}
      ${footer()}
    </section>`);
  ensureWp(n);
  const oc = document.getElementById("oddschart");
  if (oc) drawOdds(oc, weekOddsSteps(n).steps);
}

function chip(who, g, live) {
  const name = PLAYERS[who];
  const mineSide = who === S.me;
  const choice = mineSide ? S.mine.get(g.id) : S.theirs.get(g.id);
  const did = mineSide ? !!choice : S.tipped.has(`${g.id}_${who}`);
  if (!did) {
    if (!live && !mineSide) return "";   // fremder Tipp fehlt noch - Privatsache
    return `<span class="chip ${who} none">${name} offen</span>`;
  }
  if (!choice) return `<span class="chip ${who} hid">${name} getippt</span>`;
  const mark = g.winner ? (choice === g.winner ? " ok" : " no") : "";
  return `<span class="chip ${who}${mark}">${name} ${esc(g[choice])}</span>`;
}

function gameRow(g, time) {
  const gid = g.id;
  const live = started(g);
  const win = g.winner;
  const note = S.note[gid] ? `<p class="meta rownote">${esc(S.note[gid])}</p>` : "";

  if (!(g.away && g.home)) {
    return `<li class="game empty">
      <div class="matchup">
        <form class="teamform" data-act="teams" data-game="${gid}">
          <input name="away" maxlength="3" placeholder="Gast">
          <span class="at">@</span>
          <input name="home" maxlength="3" placeholder="Heim">
          <button type="submit">Speichern</button>
        </form>
      </div>
      <p class="meta">${esc(g.info)} — Paarung kommt automatisch, sobald sie feststeht</p>${note}
    </li>`;
  }

  // Wer hat auf dieses Team getippt? Der fremde Tipp erst nach Anpfiff.
  const pickOf = p => (p === S.me ? S.mine.get(gid) : S.theirs.get(gid));
  const btn = side => {
    const cls = ["pick"];
    if (S.mine.get(gid) === side) cls.push("chosen");
    if (win === side) cls.push("winner");
    const by = Object.keys(PLAYERS).filter(p => pickOf(p) === side);
    by.forEach(p => cls.push(`by-${p}`));
    const who = by.length ? `<span class="who">${by.map(p =>
      `<i class="${p}" title="Tipp von ${PLAYERS[p]}">${PLAYERS[p][0]}</i>`).join("")}</span>` : "";
    const pts = g[`${side}_score`];
    const sc = pts != null ? `<span class="sc">${pts}</span>` : "";
    const wp = S.showWp && S.wp.get(gid)?.home != null && S.wp.get(gid);
    const pct = wp ? `<span class="sub wp${wp.live ? " live" : ""}">${Math.round(wp[side])} %</span>` : "";
    return `<button class="${cls.join(" ")}" data-act="pick" data-game="${gid}"
      data-choice="${side}"${live ? " disabled" : ""}>${logo(g[side])}<span class="tx">
      <span class="team">${esc(g[side])}</span><span class="sub">${record(g[side], g)}</span>${pct}</span>${sc}${who}</button>`;
  };

  let res = "";
  if (g.status === "in") {
    res = `<span class="res now">${esc(g.detail || "läuft")}</span>`;
  } else if (win) {
    const sieger = win === "tie" ? "Unentschieden" : esc(g[win]);
    res = `<span class="res">${esc(g.detail || "Sieger")} · ${sieger}</span>`;
  } else if (live) {
    res = `<span class="resform"><span>Sieger</span>
      <button data-act="winner" data-game="${gid}" data-choice="away">${esc(g.away)}</button>
      <button data-act="winner" data-game="${gid}" data-choice="home">${esc(g.home)}</button>
      <button data-act="winner" data-game="${gid}" data-choice="tie" class="tie">Unent.</button></span>`;
  }

  const zeit = time || `<form class="timeform" data-act="zeit" data-game="${gid}">
    <input type="datetime-local" name="kickoff" required><button type="submit">Zeit</button></form>`;
  return `<li class="game${live ? " live" : ""}${live && !win ? " running" : ""}">
    <div class="matchup">
      <span class="time">${zeit}</span>
      ${btn("away")}<span class="at">@</span>${btn("home")}
    </div>
    <div class="strip">${chip("anni", g, live)}${chip("olaf", g, live)}${res}</div>
    <p class="meta">${esc(g.info)}</p>${note}
  </li>`;
}

function renderTable() {
  const sc = scores();
  const pct = ([ok, n]) => (n ? `${Math.round(ok / n * 100)} %` : "–");
  const counted = {};
  for (const g of S.games.values()) if (g.winner) counted[g.week] = (counted[g.week] || 0) + 1;
  const es = espnStats();
  const espnPending = [...S.games.values()].filter(g => g.winner && g.winner !== "tie" && g.pre_wp == null).length;
  const body = WEEKS.filter(([w]) => counted[w]).map(([w, l]) => {
    const r = weekResult(w, sc);
    const cls = r.a > r.o ? "a" : r.o > r.a ? "o" : "t";
    const cup = who => r.done && ((who === "a" && r.a > r.o) || (who === "o" && r.o > r.a))
      ? `<span class="cup" title="Wochensieg">🏆</span>` : "";
    return `<tr class="${cls}${r.done ? "" : " open"}"><th>${l}</th><td>${cup("a")}${r.a}</td><td>${cup("o")}${r.o}</td>
      <td class="espn">${es.perWeek[w] ?? "–"}</td><td class="of">von ${counted[w]}${r.done ? "" : " …"}</td></tr>`;
  });
  const t = S.sync.at ? berlin(S.sync.at).time : null;
  const quelle = t ? `Ergebnisse von ESPN, zuletzt abgeglichen um ${t} Uhr`
    + (S.sync.ok ? "" : " (mit Fehlern, ggf. per Hand eintragen)")
    : "Ergebnisse von ESPN, der erste Abgleich läuft gleich";
  document.title = "Tabelle - Tippspiel";
  paint(nav(null) + scoreboard(sc) + `
    <section class="week">
      <h2>Auswertung</h2>
      <table class="tbl stats">
        <thead><tr><th></th><th>Anni</th><th>Olaf</th><th class="espn">ESPN</th></tr></thead>
        <tbody>
          <tr><th>Trefferquote</th><td>${pct(sc.hit.anni)}</td><td>${pct(sc.hit.olaf)}</td>
            <td class="espn">${pct(es.hit)}</td></tr>
          <tr><th>Richtig getippt</th><td>${sc.hit.anni[0]}</td><td>${sc.hit.olaf[0]}</td>
            <td class="espn">${es.hit[0]}</td></tr>
          <tr><th>Wochensiege</th><td>${sc.wins.anni}</td><td>${sc.wins.olaf}</td>
            <td class="of">${sc.wins.tie}× gleich</td></tr>
        </tbody>
      </table>
      <p class="meta bfintro">ESPN tippt immer den Favoriten laut eigener Prognose zum Anpfiff.
        ${espnPending ? `<strong>ESPN-Prognosen werden noch geladen: ${es.hit[1]} von ${es.hit[1] + espnPending}
          Spielen ausgewertet.</strong>` : ""}</p>
    </section>
    <section class="week">
      <h2>Bilanz<span class="wsub">Regular Season ${sc.reg.anni}:${sc.reg.olaf}
        &nbsp;·&nbsp; Playoffs ${sc.po.anni}:${sc.po.olaf}</span></h2>
      <table class="tbl">
        <thead><tr><th></th><th>Anni</th><th>Olaf</th><th class="espn">ESPN</th><th></th></tr></thead>
        <tbody>${body.join("") || `<tr><td colspan="5" class="none">Noch kein Spiel gewertet.
          Sobald das erste Ergebnis da ist, steht hier die Bilanz.</td></tr>`}</tbody>
      </table>
      <div class="sync">
        <p class="meta">${quelle}</p>
        <button data-act="sync">Jetzt aktualisieren</button>
      </div>
      ${footer()}
    </section>`);
}

function renderBackfill(want) {
  const all = [...S.games.values()].filter(isBackfill)
    .sort((a, b) => a.kickoff - b.kickoff || a.id - b.id);
  const has = (p, id) => (p === S.me ? S.mine : S.theirs).has(id);
  const missingIn = gs => gs.reduce((k, g) => k + (has("anni", g.id) ? 0 : 1) + (has("olaf", g.id) ? 0 : 1), 0);
  const weeks = [...new Set(all.map(g => g.week))];
  // ohne Angabe: erste Woche, in der noch etwas fehlt
  const week = weeks.includes(want) ? want
    : weeks.find(w => missingIn(all.filter(g => g.week === w))) ?? weeks[0];
  const games = all.filter(g => g.week === week);
  // Woche in der Adresse festhalten, damit die Seite beim Eintragen nicht weiterspringt
  if (want !== week) history.replaceState(null, "", `#nachtragen=${week}`);

  const tabs = weeks.map(w => {
    const m = missingIn(all.filter(g => g.week === w));
    return `<a class="bftab${w === week ? " sel" : ""}${m ? "" : " full"}" href="#nachtragen=${w}">
      Woche ${w}<span class="cnt">${m ? m : "✓"}</span></a>`;
  }).join("");

  const rows = games.map(g => {
    const b = berlin(g.kickoff);
    const sieger = g.winner ? (g.winner === "tie" ? "Unentschieden" : esc(g[g.winner])) : "offen";
    const line = p => {
      const c = (p === S.me ? S.mine : S.theirs).get(g.id);
      const btn = side => `<button class="bf${c === side ? ` chosen by-${p}` : ""}${g.winner === side ? " won" : ""}"
        data-act="backfill" data-game="${g.id}" data-player="${p}" data-choice="${side}"
        ${S.players[p] ? "" : "disabled"}>${logo(g[side])}${esc(g[side])}</button>`;
      return `<div class="bfline"><span class="bfname ${p}">${PLAYERS[p]}</span>${btn("away")}${btn("home")}</div>`;
    };
    const note = S.note[g.id] ? `<p class="meta rownote">${esc(S.note[g.id])}</p>` : "";
    return `<li class="game bfgame">
      <p class="bfhead"><span>${b.wd} ${b.day}</span> ${esc(g.away)} @ ${esc(g.home)}
        ${g.away_score != null ? `<span class="bfscore">${g.away_score}:${g.home_score}</span>` : ""}
        <span class="bfwin">Sieger ${sieger}</span></p>
      ${line("anni")}${line("olaf")}${note}
    </li>`;
  }).join("");

  const left = p => games.filter(g => !has(p, g.id)).length;
  const fehlt = Object.keys(PLAYERS).map(p => `${PLAYERS[p]} ${left(p) ? `${left(p)} offen` : "komplett ✓"}`).join(" · ");
  const ohne = Object.keys(PLAYERS).filter(p => !S.players[p]);
  const next = weeks.find(w => w > week && missingIn(all.filter(g => g.week === w)))
    ?? weeks.find(w => w !== week && missingIn(all.filter(g => g.week === w)));
  const done = !missingIn(games);
  document.title = `Papiertipps Woche ${week} - Tippspiel`;
  paint(nav(null) + `
    <section class="week">
      <h2>Papiertipps</h2>
      <p class="meta bfintro">Die Tipps vom Papier für die Spiele vor dem Start der App.
        Einer von euch kann beide eintragen, jeder Klick wird sofort gespeichert und zählt
        gleich in der Tabelle. Möglich bis einschließlich 17.10.2026.
        ${ohne.length ? `<br>${ohne.map(p => PLAYERS[p]).join(", ")} muss sich zuerst einmal anmelden.` : ""}</p>
      ${zettelPending() ? `<div class="banner zettel">📄 Euer Zettel für Woche 1, 2 und das erste Spiel von Woche 3
        ist ausgelesen (${Object.keys(ZETTEL).length * 2} Tipps).
        <button data-act="zettel">Zettel übernehmen</button></div>` : ""}
      ${S.zettelMsg ? `<p class="meta bfintro zmsg">${esc(S.zettelMsg)}</p>` : ""}
      <div class="bftabs">${tabs}</div>
      <h3 class="bfweek">Woche ${week}<span class="wsub">${fehlt}</span></h3>
      <ul class="games">${rows}</ul>
      ${done ? (next ? `<a class="banner next" href="#nachtragen=${next}">✓ Woche ${week} komplett – weiter zu Woche ${next} →</a>`
        : `<a class="banner next" href="#woche=${currentWeek()}">✓ Alle Papiertipps eingetragen – zur aktuellen Woche →</a>`) : ""}
      ${footer()}
    </section>`);
}

function renderIntro() {
  const o = PLAYERS[other()];
  const step = (n, title, text) => `<li class="step"><span class="num">${n}</span>
    <div><h3>${title}</h3><p>${text}</p></div></li>`;
  document.title = "So funktioniert's - Tippspiel";
  paint(`
    <header class="hero hero-login">
      <h1>Hallo ${PLAYERS[S.me]}!</h1>
      <p class="lede">So funktioniert das Tippspiel gegen ${o}, in einer Minute erklärt.</p>
    </header>
    <ol class="steps">
      ${step(1, "Sieger antippen",
        "Pro Spiel tippst du auf das Team, das deiner Meinung nach gewinnt. Gespeichert wird sofort, " +
        "umentscheiden kannst du dich bis zum Anpfiff beliebig oft.")}
      ${step(2, "Geheim bis zum Anpfiff",
        `Du siehst nur, <em>dass</em> ${o} getippt hat, aber nicht was. Mit dem Anpfiff wird der Tipp ` +
        "aufgedeckt und gesperrt, ab dann geht nichts mehr.")}
      ${step(3, "Live mitfiebern",
        "Spielstand, Viertel und Uhr kommen live von ESPN, die Seite aktualisiert sich von selbst. " +
        "Nach Abpfiff zählt die App die Punkte: einer pro richtigem Sieger, bei Unentschieden keiner.")}
      ${step(4, "Entscheidungshilfe",
        "Unter jedem Team steht seine Bilanz, z. B. 3:0. Mit dem Knopf <strong>Siegchance</strong> " +
        "blendest du zusätzlich die ESPN-Prognose ein.")}
      ${step(5, "Woche wechseln & Tabelle",
        "Oben links wählst du die Spielwoche, unter <strong>Tabelle</strong> stehen Trefferquote, " +
        "Wochensiege und die Bilanz jeder Woche." +
        (backfillOpen() ? " Unter <strong>Papiertipps</strong> tragt ihr die Tipps vom Zettel für die ersten Wochen nach." : ""))}
      ${step(6, "Als App speichern",
        "Im Browser auf Teilen bzw. ⋮ tippen und <strong>Zum Home-Bildschirm</strong> wählen, " +
        "dann öffnet sich das Tippspiel wie eine App.")}
    </ol>
    <button class="go" data-act="intro-done">Los geht's</button>
    <p class="meta helplink">Diese Anleitung findest du später unten auf jeder Spielwoche unter „So funktioniert's“.</p>`);
}

// ---------------------------------------------------------------- Statistik
const DIVISIONS = {
  "AFC East": ["BUF", "MIA", "NE", "NYJ"], "AFC North": ["BAL", "CIN", "CLE", "PIT"],
  "AFC South": ["HOU", "IND", "JAX", "TEN"], "AFC West": ["DEN", "KC", "LV", "LAC"],
  "NFC East": ["DAL", "NYG", "PHI", "WAS"], "NFC North": ["CHI", "DET", "GB", "MIN"],
  "NFC South": ["ATL", "CAR", "NO", "TB"], "NFC West": ["ARI", "LAR", "SF", "SEA"],
};
const DIV_OF = Object.fromEntries(Object.entries(DIVISIONS).flatMap(([d, ts]) => ts.map(t => [t, d])));

// Sendeplatz nach deutscher Zeit
function slotOf(g) {
  if (!g.kickoff) return null;
  const b = berlin(g.kickoff), h = +b.time.slice(0, 2);
  if (b.wd === "Do" || b.wd === "Fr") return "thu";
  if (b.wd === "Sa") return "sat";
  if (b.wd === "So") return h < 17 ? "intl" : h < 21 ? "early" : "late";
  if (b.wd === "Mo") return h < 8 ? "snf" : "other";
  if (b.wd === "Di") return "mnf";
  return "other";
}

function renderStats() {
  const sc = scores();
  const es = espnStats();
  const P = ["anni", "olaf"];
  const choiceOf = (p, id) => (p === "espn" ? espnPick(S.games.get(id)) : (p === S.me ? S.mine : S.theirs).get(id));
  const hit = (p, g) => !!g.winner && g.winner !== "tie" && choiceOf(p, g.id) === g.winner;
  const finished = [...S.games.values()].filter(g => g.winner).sort((a, b) => a.kickoff - b.kickoff || a.id - b.id);
  const pc = (a, b) => (b ? `${Math.round(a / b * 100)} %` : "–");
  const weekName = w => (w <= 18 ? `Woche ${w}` : (WEEKS.find(([k]) => k === w) || [, ""])[1]);

  // Punkteverlauf
  const weeks = WEEKS.map(([w]) => w).filter(w => finished.some(g => g.week === w));
  const series = [
    { key: "anni", name: "Anni", cls: "anni", per: sc.perWeek.anni },
    { key: "olaf", name: "Olaf", cls: "olaf", per: sc.perWeek.olaf },
    { key: "espn", name: "ESPN", cls: "espn", per: es.perWeek },
  ].map(s => { let sum = 0; return { ...s, pts: weeks.map(w => (sum += s.per[w] || 0)) }; });

  // Trefferquoten-Tabelle für beliebige Spielgruppen
  const rate = (p, test) => {
    let ok = 0, n = 0;
    for (const g of finished) {
      if (!test(g) || !choiceOf(p, g.id)) continue;
      n++;
      if (hit(p, g)) ok++;
    }
    return [ok, n];
  };
  const cell = ([ok, n]) => (n ? `${Math.round(ok / n * 100)} %<small>${ok}/${n}</small>` : `<span class="muted">–</span>`);
  const rateTable = (rows, espn = true) => `
    <table class="tbl duo rates">
      <thead><tr><th></th><th>Anni</th><th>Olaf</th>${espn ? `<th class="espn">ESPN</th>` : ""}</tr></thead>
      <tbody>${rows.map(r => `<tr><th>${r.label}${r.sub ? `<small>${r.sub}</small>` : ""}</th>
        <td>${cell(rate("anni", r.test))}</td><td>${cell(rate("olaf", r.test))}</td>
        ${espn ? `<td class="espn">${cell(rate("espn", r.test))}</td>` : ""}</tr>`).join("")}</tbody>
    </table>`;

  // --- Duell
  const duels = finished.filter(g => choiceOf("anni", g.id) && choiceOf("olaf", g.id)
    && choiceOf("anni", g.id) !== choiceOf("olaf", g.id));
  const duelA = duels.filter(g => hit("anni", g)).length, duelO = duels.filter(g => hit("olaf", g)).length;
  const both = finished.filter(g => choiceOf("anni", g.id) && choiceOf("olaf", g.id));
  const same = both.length - duels.length;

  const streaks = p => {
    let cur = 0, best = 0, run = 0;
    for (const g of finished) {
      if (!choiceOf(p, g.id)) continue;
      run = hit(p, g) ? run + 1 : 0;
      best = Math.max(best, run);
    }
    cur = run;
    return { cur, best };
  };
  const done = WEEKS.map(([w]) => w).filter(w => weekResult(w, sc).done);
  const weekStreak = p => {
    let run = 0, best = 0;
    for (const w of done) {
      const r = weekResult(w, sc);
      const won = p === "anni" ? r.a > r.o : r.o > r.a;
      run = won ? run + 1 : 0;
      best = Math.max(best, run);
    }
    return { cur: run, best };
  };
  const st = Object.fromEntries(P.map(p => [p, streaks(p)]));
  const ws = Object.fromEntries(P.map(p => [p, weekStreak(p)]));
  const fire = n => (n >= 5 ? " 🔥" : "");

  // Aufholpotenzial
  const cur = currentWeek();
  const rc = weekResult(cur, sc);
  const left = [...S.games.values()].filter(g => g.week === cur && g.away && g.home && !g.winner).length;
  const totA = sc.reg.anni + sc.po.anni, totO = sc.reg.olaf + sc.po.olaf;
  const lead = totA === totO ? null : totA > totO ? "anni" : "olaf";
  const trail = lead && (lead === "anni" ? "olaf" : "anni");
  const wLead = rc.a === rc.o ? null : rc.a > rc.o ? "anni" : "olaf";
  const wTrail = wLead && (wLead === "anni" ? "olaf" : "anni");
  const gapW = Math.abs(rc.a - rc.o);
  const potential = !left ? `${weekName(cur)} ist durch.`
    : !wLead ? `${weekName(cur)} steht ${rc.a}:${rc.o}, noch ${left} ${left === 1 ? "Spiel" : "Spiele"} offen – alles drin.`
    : left >= gapW ? `${weekName(cur)}: ${PLAYERS[wLead]} führt ${Math.max(rc.a, rc.o)}:${Math.min(rc.a, rc.o)},
        noch ${left} ${left === 1 ? "Spiel" : "Spiele"} offen – ${PLAYERS[wTrail]} kann die Woche noch drehen.`
    : `${weekName(cur)}: ${PLAYERS[wLead]} führt uneinholbar ${Math.max(rc.a, rc.o)}:${Math.min(rc.a, rc.o)}.`;
  const overall = lead ? `Gesamt führt ${PLAYERS[lead]} mit ${Math.abs(totA - totO)} ${Math.abs(totA - totO) === 1 ? "Punkt" : "Punkten"}.
      ${trail && left ? `Holt ${PLAYERS[trail]} alle ${left} offenen Spiele und ${PLAYERS[lead]} keins, sind es
      ${Math.abs(totA - totO) - left > 0 ? `noch ${Math.abs(totA - totO) - left}` : Math.abs(totA - totO) === left ? "Gleichstand" : `${left - Math.abs(totA - totO)} für ${PLAYERS[trail]}`}.` : ""}`
    : "Gesamt steht es unentschieden.";

  // --- Rekorde
  const records = p => {
    let best = null, worst = null, perfect = 0;
    for (const w of done) {
      const r = weekResult(w, sc), v = p === "anni" ? r.a : r.o;
      if (!best || v > best.v) best = { w, v, t: r.total };
      if (!worst || v < worst.v) worst = { w, v, t: r.total };
      if (v === r.total) perfect++;
    }
    return { best, worst, perfect };
  };
  const rec = Object.fromEntries(P.map(p => [p, records(p)]));
  const wk = x => (x ? `${x.v}<small>von ${x.t} · ${weekName(x.w)}</small>` : `<span class="muted">–</span>`);

  // --- Mut: Treffer mit der kleinsten Siegchance
  const bravest = p => {
    let pick = null;
    for (const g of finished) {
      if (!hit(p, g) || g.pre_wp == null) continue;
      const c = choiceOf(p, g.id), prob = c === "home" ? g.pre_wp : 100 - g.pre_wp;
      if (!pick || prob < pick.prob) pick = { g, c, prob };
    }
    return pick;
  };
  const brave = x => {
    if (!x) return `<span class="muted">noch kein Außenseiter-Treffer</span>`;
    const opp = x.c === "home" ? x.g.away : x.g.home;
    return `<span class="bravet">${logo(x.g[x.c])}<b>${esc(x.g[x.c])}</b></span>
      <span class="bravep">bei ${Math.round(x.prob)} %</span><small>gegen ${esc(opp)} · ${weekName(x.g.week)}</small>`;
  };

  // --- Früh- oder Spättipper (Tipps nach Anpfiff, z. B. Papiertipps, zählen nicht)
  const lead_h = (p, g) => {
    const at = S.at.get(`${g.id}_${p}`);
    return at && g.kickoff && at < g.kickoff ? (g.kickoff - at) / 3600e3 : null;
  };
  const median = xs => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const fmtLead = h => (h == null ? "–" : h < 1 ? `${Math.round(h * 60)} Min.` : h < 48 ? `${Math.round(h)} Std.` : `${Math.round(h / 24)} Tage`);
  const medLead = p => fmtLead(median(finished.map(g => lead_h(p, g)).filter(x => x != null)));
  const leadRow = (label, lo, hi) => ({ label, test: null, lo, hi });
  const leadRows = [leadRow("Kurz vor Anpfiff", 0, 2), leadRow("Am Spieltag", 2, 24), leadRow("Früher", 24, 1e9)];
  const leadCell = (p, lo, hi) => {
    let ok = 0, n = 0;
    for (const g of finished) {
      const h = lead_h(p, g);
      if (h == null || h < lo || h >= hi) continue;
      n++;
      if (hit(p, g)) ok++;
    }
    return cell([ok, n]);
  };

  // --- Team-Kacheln: Trefferquote in allen Spielen eines Teams
  const teamRate = (p, t) => rate(p, g => g.away === t || g.home === t);
  const bar = (p, t) => {
    const [ok, n] = teamRate(p, t);
    const v = n ? Math.round(ok / n * 100) : null;
    return `<div class="tb ${p}"><span class="tbl-l">${PLAYERS[p][0]}</span><span class="tbar"><i style="width:${v ?? 0}%"></i></span>
      <span class="tbv">${v == null ? "–" : `${v}%`}</span></div>`;
  };
  const tiles = Object.entries(DIVISIONS).map(([d, ts]) => `
    <div class="divrow"><span class="divname">${d}</span>
      <div class="ttiles">${ts.map(t => `<div class="ttile">${logo(t)}<b>${t}</b>${bar("anni", t)}${bar("olaf", t)}</div>`).join("")}</div>
    </div>`).join("");

  // --- bestehende Kennzahlen
  const per = p => {
    const mine = finished.filter(g => choiceOf(p, g.id));
    const fav = mine.filter(g => espnPick(g));
    const favPicked = fav.filter(g => choiceOf(p, g.id) === espnPick(g));
    const upset = fav.filter(g => choiceOf(p, g.id) !== espnPick(g) && choiceOf(p, g.id) === g.winner);
    const home = mine.filter(g => choiceOf(p, g.id) === "home");
    const teams = {};
    for (const g of mine) {
      const t = g[choiceOf(p, g.id)];
      teams[t] ??= { t, n: 0, ok: 0 };
      teams[t].n++;
      if (choiceOf(p, g.id) === g.winner) teams[t].ok++;
    }
    const list = Object.values(teams);
    const often = [...list].sort((a, b) => b.n - a.n || b.ok - a.ok)[0];
    const rated = list.filter(x => x.n >= 3);
    const best = [...rated].sort((a, b) => b.ok / b.n - a.ok / a.n || b.n - a.n)[0];
    const worst = [...rated].sort((a, b) => a.ok / a.n - b.ok / b.n || b.n - a.n)[0];
    return { fav: [favPicked.length, fav.length], upset: upset.length,
             home: [home.length, mine.length], often, best, worst };
  };
  const A = per("anni"), O = per("olaf");
  const team = x => x ? `${logo(x.t)}<span>${esc(x.t)}</span><small>${x.ok}/${x.n}</small>` : `<span class="muted">–</span>`;
  const favP = g => (g.pre_wp == null ? null : Math.max(g.pre_wp, 100 - g.pre_wp));
  const margin = g => (g.away_score == null ? null : Math.abs(g.away_score - g.home_score));
  const div = g => (DIV_OF[g.away] && DIV_OF[g.home] ? (DIV_OF[g.away] === DIV_OF[g.home] ? "div"
    : DIV_OF[g.away].slice(0, 3) === DIV_OF[g.home].slice(0, 3) ? "conf" : "inter") : null);
  const name = p => `<span class="pn ${p}">${PLAYERS[p]}</span>`;

  document.title = "Statistik - Tippspiel";
  paint(nav(null) + `
    <section class="week">
      <h2>Punkteverlauf<span class="wsub">richtige Tipps, aufsummiert</span></h2>
      ${weeks.length ? `<div class="chart" id="chart" data-keep></div>` : `<p class="meta bfintro">Sobald Ergebnisse da sind, erscheint hier der Verlauf.</p>`}
    </section>

    <section class="week">
      <h2>Duell<span class="wsub">nur Anni gegen Olaf</span></h2>
      <div class="banner live potential">${potential}<br><span class="muted">${overall}</span></div>
      <div class="tiles">
        <div class="tile"><span class="tl">Direkte Duelle</span>
          <span class="tv"><span class="anni">${duelA}</span><span class="muted">:</span><span class="olaf">${duelO}</span></span>
          <span class="ts">${duels.length} Spiele unterschiedlich getippt, ${same} gleich</span></div>
        <div class="tile"><span class="tl">Wochensieg-Serie</span>
          <span class="tv"><span class="anni">${ws.anni.cur}</span><span class="muted">:</span><span class="olaf">${ws.olaf.cur}</span></span>
          <span class="ts">aktuell · Rekord ${ws.anni.best}:${ws.olaf.best}</span></div>
      </div>
      <table class="tbl duo">
        <thead><tr><th></th><th>Anni</th><th>Olaf</th></tr></thead>
        <tbody>
          <tr><th>Aktuelle Serie<small>richtige Tipps in Folge</small></th>
            <td>${st.anni.cur}${fire(st.anni.cur)}</td><td>${st.olaf.cur}${fire(st.olaf.cur)}</td></tr>
          <tr><th>Längste Serie</th><td>${st.anni.best}</td><td>${st.olaf.best}</td></tr>
        </tbody>
      </table>
    </section>

    <section class="week">
      <h2>Rekorde<span class="wsub">abgeschlossene Wochen</span></h2>
      <table class="tbl duo">
        <thead><tr><th></th><th>Anni</th><th>Olaf</th></tr></thead>
        <tbody>
          <tr><th>Beste Woche</th><td>${wk(rec.anni.best)}</td><td>${wk(rec.olaf.best)}</td></tr>
          <tr><th>Schlechteste Woche</th><td>${wk(rec.anni.worst)}</td><td>${wk(rec.olaf.worst)}</td></tr>
          <tr><th>Perfekte Wochen<small>alle Spiele richtig</small></th><td>${rec.anni.perfect}</td><td>${rec.olaf.perfect}</td></tr>
        </tbody>
      </table>
    </section>

    <section class="week">
      <h2>Mut &amp; Riecher</h2>
      <div class="tiles">
        ${P.map(p => `<div class="tile brave"><span class="tl">Mutigster Treffer · ${name(p)}</span>${brave(bravest(p))}</div>`).join("")}
      </div>
      <h3 class="subh">Nach Favoritenstärke<span class="wsub">laut ESPN zum Anpfiff</span></h3>
      ${rateTable([
        { label: "Klarer Favorit", sub: "Siegchance ab 70 %", test: g => favP(g) >= 70 },
        { label: "Favorit", sub: "60 bis 70 %", test: g => favP(g) >= 60 && favP(g) < 70 },
        { label: "Enges Spiel", sub: "unter 60 %", test: g => favP(g) != null && favP(g) < 60 },
      ])}
      <table class="tbl duo">
        <thead><tr><th></th><th>Anni</th><th>Olaf</th></tr></thead>
        <tbody>
          <tr><th>Favorit getippt<small>wie oft auf ESPNs Favoriten</small></th><td>${pc(...A.fav)}</td><td>${pc(...O.fav)}</td></tr>
          <tr><th>Überraschungen<small>Außenseiter getippt und richtig</small></th><td>${A.upset}</td><td>${O.upset}</td></tr>
          <tr><th>Heimteam getippt</th><td>${pc(...A.home)}</td><td>${pc(...O.home)}</td></tr>
        </tbody>
      </table>
    </section>

    <section class="week">
      <h2>Wann ihr richtig liegt</h2>
      <h3 class="subh">Nach Anstoßzeit<span class="wsub">deutsche Zeit</span></h3>
      ${rateTable([
        { label: "Donnerstag", sub: "Thursday Night", test: g => slotOf(g) === "thu" },
        { label: "Sonntag früh", sub: "Spiele in Europa, 14–16 Uhr", test: g => slotOf(g) === "intl" },
        { label: "Sonntag 19 Uhr", test: g => slotOf(g) === "early" },
        { label: "Sonntag 22 Uhr", test: g => slotOf(g) === "late" },
        { label: "Sunday Night", sub: "Nacht auf Montag", test: g => slotOf(g) === "snf" },
        { label: "Monday Night", sub: "Nacht auf Dienstag", test: g => slotOf(g) === "mnf" },
        { label: "Sonstige", sub: "Samstag, Feiertage", test: g => ["sat", "other"].includes(slotOf(g)) },
      ].filter(r => finished.some(r.test)))}
      <h3 class="subh">Früh- oder Spättipper<span class="wsub">wie lange vor Anpfiff getippt</span></h3>
      <table class="tbl duo rates">
        <thead><tr><th></th><th>Anni</th><th>Olaf</th></tr></thead>
        <tbody>
          <tr><th>Typischer Vorlauf<small>Median</small></th><td>${medLead("anni")}</td><td>${medLead("olaf")}</td></tr>
          ${leadRows.map(r => `<tr><th>${r.label}<small>${r.hi === 2 ? "unter 2 Std." : r.hi === 24 ? "2 bis 24 Std." : "mehr als 1 Tag"}</small></th>
            <td>${leadCell("anni", r.lo, r.hi)}</td><td>${leadCell("olaf", r.lo, r.hi)}</td></tr>`).join("")}
        </tbody>
      </table>
      <p class="meta bfintro">Papiertipps zählen hier nicht, ihr Zeitpunkt liegt nach dem Anpfiff.</p>
      <h3 class="subh">Knappe Spiele oder Kantersiege<span class="wsub">Punkteabstand am Ende</span></h3>
      ${rateTable([
        { label: "Knapp", sub: "bis 7 Punkte", test: g => margin(g) != null && margin(g) <= 7 },
        { label: "Deutlich", sub: "8 bis 16 Punkte", test: g => margin(g) >= 8 && margin(g) <= 16 },
        { label: "Kantersieg", sub: "ab 17 Punkte", test: g => margin(g) >= 17 },
      ])}
      <h3 class="subh">Nach Spielart</h3>
      ${rateTable([
        { label: "Divisionsduell", sub: "gelten als schwer vorherzusagen", test: g => div(g) === "div" },
        { label: "Gleiche Conference", test: g => div(g) === "conf" },
        { label: "AFC gegen NFC", test: g => div(g) === "inter" },
      ])}
    </section>

    <section class="week">
      <h2>Teams<span class="wsub">ab 3 Tipps auf ein Team</span></h2>
      <table class="tbl duo teams">
        <thead><tr><th></th><th>Anni</th><th>Olaf</th></tr></thead>
        <tbody>
          <tr><th>Am häufigsten getippt</th><td>${team(A.often)}</td><td>${team(O.often)}</td></tr>
          <tr><th>Bester Riecher</th><td>${team(A.best)}</td><td>${team(O.best)}</td></tr>
          <tr><th>Größter Reinfall</th><td>${team(A.worst)}</td><td>${team(O.worst)}</td></tr>
        </tbody>
      </table>
      <h3 class="subh">Alle Teams<span class="wsub">Trefferquote in den Spielen des Teams</span></h3>
      <div class="teamgrid">${tiles}</div>
      ${footer()}
    </section>`);
  if (weeks.length) drawChart(document.getElementById("chart"), weeks, series);
}

function drawChart(el, weeks, series) {
  const W = Math.max(280, el.clientWidth), H = 230;
  const key = JSON.stringify([W, weeks, series.map(s => s.pts)]);
  if (el.dataset.key === key) return;                // nichts geändert, nicht neu zeichnen
  el.dataset.key = key;
  const m = { t: 14, r: 64, b: 28, l: 30 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = Math.max(4, ...series.flatMap(s => s.pts));
  const step = max <= 10 ? 2 : max <= 40 ? 10 : max <= 100 ? 20 : 50;
  const top = Math.ceil(max / step) * step;
  const x = i => m.l + (weeks.length === 1 ? iw / 2 : i * iw / (weeks.length - 1));
  const y = v => m.t + ih - v / top * ih;
  const label = w => (w <= 18 ? String(w) : (WEEKS.find(([k]) => k === w) || [, ""])[1].slice(0, 2));

  let grid = "";
  for (let v = 0; v <= top; v += step) {
    grid += `<line class="grid" x1="${m.l}" x2="${m.l + iw}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="ax" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  const every = Math.ceil(weeks.length / 9);
  const xl = weeks.map((w, i) => i % every && i !== weeks.length - 1 ? "" :
    `<text class="ax" x="${x(i)}" y="${H - 8}" text-anchor="middle">${label(w)}</text>`).join("");

  // Endbeschriftungen ohne Überlappung
  const ends = series.map(s => ({ s, y: y(s.pts[s.pts.length - 1]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;

  const lines = series.map(s => `
    <path class="ln ${s.cls}" d="${s.pts.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("")}"/>
    ${s.pts.map((v, i) => `<circle class="dot ${s.cls}" cx="${x(i)}" cy="${y(v)}" r="4"/>`).join("")}`).join("");
  const tags = ends.map(e => `<text class="tag ${e.s.cls}" x="${m.l + iw + 10}" y="${e.y + 4}">${e.s.name} ${e.s.pts[e.s.pts.length - 1]}</text>`).join("");

  el.innerHTML = `
    <div class="legend">${series.map(s => `<span class="lg ${s.cls}"><i></i>${s.name}</span>`).join("")}</div>
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Punkteverlauf: ${series.map(s => `${s.name} ${s.pts[s.pts.length - 1]}`).join(", ")}">
      ${grid}${xl}<line class="cross" y1="${m.t}" y2="${m.t + ih}" x1="-10" x2="-10"/>${lines}${tags}
      <rect class="hit" x="${m.l - 10}" y="0" width="${iw + 20}" height="${H}"/>
    </svg>
    <div class="tip" hidden></div>`;

  const svg = el.querySelector("svg"), tip = el.querySelector(".tip"), cross = el.querySelector(".cross");
  const show = ev => {
    const r = svg.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const i = weeks.length === 1 ? 0 : Math.max(0, Math.min(weeks.length - 1, Math.round((px - m.l) / iw * (weeks.length - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
    const w = weeks[i];
    tip.innerHTML = `<b>${w <= 18 ? `Woche ${w}` : (WEEKS.find(([k]) => k === w) || [, ""])[1]}</b>` +
      [...series].sort((a, b) => b.pts[i] - a.pts[i]).map(s =>
        `<span class="tr"><i class="${s.cls}"></i>${s.name}<em>${s.pts[i]}</em><small>+${s.per[w] || 0}</small></span>`).join("");
    tip.hidden = false;
    const left = Math.min(Math.max(x(i) - tip.offsetWidth / 2, 0), W - tip.offsetWidth);
    tip.style.left = `${left}px`;
  };
  const hide = () => { tip.hidden = true; cross.setAttribute("x1", -10); cross.setAttribute("x2", -10); };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", hide);
}
