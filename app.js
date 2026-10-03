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
  where, writeBatch,
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
  sync: { at: null, ok: null },
  note: {},           // id -> Hinweis an einer Spielzeile
  wp: new Map(),      // id -> {home, away, live, at}  Siegchance von ESPN
  showWp: (() => { try { return localStorage.getItem("tippspiel:wp") === "1"; } catch { return false; } })(),
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
    theirs: new Map(), sync: { at: null, ok: null }, note: {} });
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
    snap.docChanges().forEach(ch => S.mine.set(+ch.doc.data().game, ch.doc.data().choice));
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
  const keep = [...S.theirs].filter(([id]) => !isBackfill(S.games.get(id) || {}));
  try { localStorage.setItem(cacheKey(), JSON.stringify(Object.fromEntries(keep))); } catch {}
}
let revealing = null, revealAgain = false;
async function reveal() {
  if (revealing) { revealAgain = true; return revealing; }   // läuft schon: danach nochmal
  revealing = (async () => {
    if (!S.theirs.size) {
      for (const [k, v] of Object.entries(loadCache())) {
        if (!isBackfill(S.games.get(+k) || {})) S.theirs.set(+k, v);
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
          if (snap.exists()) { S.theirs.set(g.id, snap.data().choice); got = true; }
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
  await storePreWp(w);
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
async function storePreWp(w) {
  const todo = [...S.games.values()]
    .filter(g => g.week === w && g.status === "post" && g.espn_id && g.pre_wp == null).slice(0, 16);
  await Promise.all(todo.map(async g => {
    try {
      const v = await fetchPreWp(g.espn_id);
      if (v != null) await updateDoc(doc(db, "games", String(g.id)), { pre_wp: v });
    } catch { /* nächster Abgleich */ }
  }));
}

function weeksToSync() {
  const soon = new Date(Date.now() + 8 * 864e5);
  const weeks = new Set();
  for (const g of S.games.values()) {
    const when = g.kickoff || (g.date_hint ? new Date(`${g.date_hint}T12:00:00Z`) : null);
    if (!g.winner && when && when <= soon) weeks.add(g.week);
    if (g.status === "post" && g.pre_wp == null && g.espn_id) weeks.add(g.week);
  }
  return [...weeks].sort((a, b) => a - b);
}

function somethingLive() {
  const since = Date.now() - 5 * 3600e3;
  return [...S.games.values()].some(g => !g.winner && (g.status === "in"
    || (g.kickoff && g.kickoff.getTime() > since && g.kickoff <= now())));
}

async function syncAll() {
  let ok = true;
  for (const w of weeksToSync()) {
    try { await syncWeek(w); } catch (e) { ok = false; console.warn(`ESPN Woche ${w}:`, e); }
  }
  S.sync = { at: now(), ok };
  render();
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
    S.wp.set(g.id, { home: g.pre_wp, away: 100 - g.pre_wp, live: false, at: Date.now(), final: true });
    return true;
  }
  S.wp.set(g.id, { ...(old || { home: null }), at: Date.now() });   // nicht bei jedem Rendern neu fragen
  const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${g.espn_id}`);
  if (!r.ok) return false;
  const d = await r.json();
  const wp = d.winprobability || [];
  let home = null, live = false;
  if (g.status === "in" && wp.length) { home = wp[wp.length - 1].homeWinPercentage * 100; live = true; }
  else if (d.predictor && d.predictor.homeTeam) {
    home = parseFloat(d.predictor.homeTeam.gameProjection);
    const away = parseFloat(d.predictor.awayTeam.gameProjection);
    if (!isNaN(home) && !isNaN(away) && home + away > 0) home = home / (home + away) * 100;
  } else if (wp.length) home = wp[0].homeWinPercentage * 100;
  if (home == null || isNaN(home)) return false;
  S.wp.set(g.id, { home, away: 100 - home, live, at: Date.now(), final: g.status === "post" });
  return true;
}

let wpBusy = false;
async function ensureWp(week) {
  if (!S.showWp || wpBusy) return;
  wpBusy = true;
  try {
    const gs = [...S.games.values()].filter(g => g.week === week && g.espn_id);
    const got = await Promise.all(gs.map(g => loadWp(g).catch(() => false)));
    if (got.some(Boolean)) render();
  } finally { wpBusy = false; }
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
  else if (act === "sync") syncAll();
  else if (act === "ics") downloadIcs();
  else if (act === "intro-done") {
    try { localStorage.setItem("tippspiel:intro", "1"); } catch {}
    if (location.hash === "#hilfe") location.hash = ""; else render();
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
  if (location.hash === "#nachtragen" && S.me) refreshBackfill();
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

function nav(week) {
  const opts = WEEKS.map(([w, l]) =>
    `<option value="${w}"${w === week ? " selected" : ""}>${l}</option>`).join("");
  return `
    <nav class="nav">
      <form class="weekpick" onsubmit="return false">
        <label class="sr" for="w">Spielwoche</label>
        <select id="w">${opts}</select>
      </form>
      <a href="#tabelle" class="navlink">Tabelle</a>
      <a href="#statistik" class="navlink">Statistik</a>
    </nav>`;
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
    else if (h === "#nachtragen" && backfillOpen()) renderBackfill();
    else if (h === "#statistik") renderStats();
    else renderWeek(+(h.match(/woche=(\d+)/) || [])[1] || currentWeek());
  });
}

function renderWeek(n) {
  const games = [...S.games.values()].filter(g => g.week === n).sort((a, b) =>
    (a.kickoff ? 0 : 1) - (b.kickoff ? 0 : 1) || (a.kickoff || 0) - (b.kickoff || 0) || a.id - b.id);
  if (!games.length) {
    wrap.innerHTML = nav(n) + `<p>Diese Woche gibt es nicht.</p>`;
    return;
  }
  const sc = scores();
  const rows = [];
  let lastDay = null;
  for (const g of games) {
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
  const paper = backfillOpen() && [...S.games.values()].some(g => isBackfill(g)
    && (!S.mine.has(g.id) || !S.theirs.has(g.id)));
  wrap.innerHTML = nav(n) + reminder() + scoreboard(sc) + `
    ${paper ? `<a class="banner paper" href="#nachtragen">📝 Papiertipps der ersten Wochen nachtragen
      (bis 17.10.)</a>` : ""}
    <section class="week">
      <h2>${title}<span class="wsub">${stand || (n <= 18 ? label : "")}
        ${done ? `&nbsp;·&nbsp; ${done} gewertet` : ""}</span></h2>
      ${weekBanner(n, sc)}
      <div class="tools">
        <button class="toggle" data-act="ics">⏰ Kalender-Erinnerung</button>
        <button class="toggle${S.showWp ? " on" : ""}" data-act="wp" aria-pressed="${S.showWp}">
          Siegchance ${S.showWp ? "an" : "aus"}</button>
      </div>
      <ul class="games">${rows.join("")}</ul>
      ${S.showWp ? `<p class="meta wpnote">Siegchance laut ESPN: vor dem Spiel die Prognose,
        während des Spiels live.</p>` : ""}
      ${footer()}
    </section>`;
  ensureWp(n);
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

  const btn = side => {
    const cls = ["pick"];
    if (S.mine.get(gid) === side) cls.push("chosen");
    if (win === side) cls.push("winner");
    const pts = g[`${side}_score`];
    const sc = pts != null ? `<span class="sc">${pts}</span>` : "";
    const wp = S.showWp && S.wp.get(gid)?.home != null && S.wp.get(gid);
    const pct = wp ? `<span class="sub wp${wp.live ? " live" : ""}">${Math.round(wp[side])} %</span>` : "";
    return `<button class="${cls.join(" ")}" data-act="pick" data-game="${gid}"
      data-choice="${side}"${live ? " disabled" : ""}>${logo(g[side])}<span class="tx">
      <span class="team">${esc(g[side])}</span><span class="sub">${record(g[side], g)}</span>${pct}</span>${sc}</button>`;
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
  return `<li class="game${live ? " live" : ""}">
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
  wrap.innerHTML = nav(currentWeek()) + scoreboard(sc) + `
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
      <p class="meta bfintro">ESPN tippt immer den Favoriten laut eigener Prognose zum Anpfiff.</p>
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
    </section>`;
}

function renderBackfill() {
  const games = [...S.games.values()].filter(isBackfill)
    .sort((a, b) => a.kickoff - b.kickoff || a.id - b.id);
  const missing = p => games.filter(g => !(p === S.me ? S.mine : S.theirs).has(g.id)).length;
  const rows = [];
  let lastWeek = null;
  for (const g of games) {
    if (g.week !== lastWeek) { rows.push(`<li class="dayhead">Woche ${g.week}</li>`); lastWeek = g.week; }
    const b = berlin(g.kickoff);
    const sieger = g.winner ? (g.winner === "tie" ? "Unentschieden" : esc(g[g.winner])) : "offen";
    const line = p => {
      const c = (p === S.me ? S.mine : S.theirs).get(g.id);
      const btn = side => `<button class="bf${c === side ? " chosen" : ""}${g.winner === side ? " won" : ""}"
        data-act="backfill" data-game="${g.id}" data-player="${p}" data-choice="${side}"
        ${S.players[p] ? "" : "disabled"}>${logo(g[side])}${esc(g[side])}</button>`;
      return `<div class="bfline"><span class="bfname ${p}">${PLAYERS[p]}</span>${btn("away")}${btn("home")}</div>`;
    };
    const note = S.note[g.id] ? `<p class="meta rownote">${esc(S.note[g.id])}</p>` : "";
    rows.push(`<li class="game bfgame">
      <p class="bfhead"><span>${b.wd} ${b.day}</span> ${esc(g.away)} @ ${esc(g.home)}
        ${g.away_score != null ? `<span class="bfscore">${g.away_score}:${g.home_score}</span>` : ""}
        <span class="bfwin">Sieger ${sieger}</span></p>
      ${line("anni")}${line("olaf")}${note}
    </li>`);
  }
  const fehlt = Object.keys(PLAYERS).map(p => `${PLAYERS[p]} ${missing(p) ? `${missing(p)} offen` : "komplett"}`).join(" · ");
  const ohne = Object.keys(PLAYERS).filter(p => !S.players[p]);
  document.title = "Papiertipps - Tippspiel";
  wrap.innerHTML = nav(currentWeek()) + `
    <section class="week">
      <h2>Papiertipps<span class="wsub">${fehlt}</span></h2>
      <p class="meta bfintro">Die Tipps vom Papier für die Spiele vor dem Start der App.
        Einer von euch kann beide eintragen, jeder Klick wird sofort gespeichert und zählt
        gleich in der Tabelle. Möglich bis einschließlich 17.10.2026.
        ${ohne.length ? `<br>${ohne.map(p => PLAYERS[p]).join(", ")} muss sich zuerst einmal anmelden.` : ""}</p>
      <ul class="games">${rows.join("")}</ul>
    </section>`;
}

function renderIntro() {
  const o = PLAYERS[other()];
  const step = (n, title, text) => `<li class="step"><span class="num">${n}</span>
    <div><h3>${title}</h3><p>${text}</p></div></li>`;
  document.title = "So funktioniert's - Tippspiel";
  wrap.innerHTML = `
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
    <p class="meta helplink">Diese Anleitung findest du später unten auf jeder Spielwoche unter „So funktioniert's“.</p>`;
}

// ---------------------------------------------------------------- Statistik
function renderStats() {
  const sc = scores();
  const es = espnStats();
  const choiceOf = (p, id) => (p === S.me ? S.mine : S.theirs).get(id);
  const finished = [...S.games.values()].filter(g => g.winner).sort((a, b) => a.kickoff - b.kickoff || a.id - b.id);

  // Punkteverlauf: kumuliert über die Wochen mit Ergebnissen
  const weeks = WEEKS.map(([w]) => w).filter(w => finished.some(g => g.week === w));
  const series = [
    { key: "anni", name: "Anni", cls: "anni", per: sc.perWeek.anni },
    { key: "olaf", name: "Olaf", cls: "olaf", per: sc.perWeek.olaf },
    { key: "espn", name: "ESPN", cls: "espn", per: es.perWeek },
  ].map(s => { let sum = 0; return { ...s, pts: weeks.map(w => (sum += s.per[w] || 0)) }; });

  // Kennzahlen je Spieler
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
    return { n: mine.length, fav: [favPicked.length, fav.length], upset: upset.length,
             home: [home.length, mine.length], often, best, worst };
  };
  const A = per("anni"), O = per("olaf");
  const both = finished.filter(g => choiceOf("anni", g.id) && choiceOf("olaf", g.id));
  const same = both.filter(g => choiceOf("anni", g.id) === choiceOf("olaf", g.id)).length;
  const pc = (a, b) => (b ? `${Math.round(a / b * 100)} %` : "–");
  const team = x => x ? `${logo(x.t)}<span>${esc(x.t)}</span><small>${x.ok}/${x.n}</small>` : `<span class="muted">–</span>`;

  document.title = "Statistik - Tippspiel";
  wrap.innerHTML = nav(currentWeek()) + `
    <section class="week">
      <h2>Punkteverlauf<span class="wsub">richtige Tipps, aufsummiert</span></h2>
      ${weeks.length ? `<div class="chart" id="chart"></div>` : `<p class="meta bfintro">Sobald Ergebnisse da sind, erscheint hier der Verlauf.</p>`}
    </section>
    <section class="week">
      <h2>Kennzahlen</h2>
      <div class="tiles">
        <div class="tile"><span class="tl">Gleich getippt</span><span class="tv">${pc(same, both.length)}</span>
          <span class="ts">${same} von ${both.length} Spielen</span></div>
        <div class="tile"><span class="tl">ESPN-Treffer</span><span class="tv">${pc(...es.hit)}</span>
          <span class="ts">Favorit gewinnt</span></div>
      </div>
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
      <h2>Teams<span class="wsub">ab 3 Tipps auf ein Team</span></h2>
      <table class="tbl duo teams">
        <thead><tr><th></th><th>Anni</th><th>Olaf</th></tr></thead>
        <tbody>
          <tr><th>Am häufigsten getippt</th><td>${team(A.often)}</td><td>${team(O.often)}</td></tr>
          <tr><th>Bester Riecher</th><td>${team(A.best)}</td><td>${team(O.best)}</td></tr>
          <tr><th>Größter Reinfall</th><td>${team(A.worst)}</td><td>${team(O.worst)}</td></tr>
        </tbody>
      </table>
      ${footer()}
    </section>`;
  if (weeks.length) drawChart(document.getElementById("chart"), weeks, series);
}

function drawChart(el, weeks, series) {
  const W = Math.max(280, el.clientWidth), H = 230;
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
