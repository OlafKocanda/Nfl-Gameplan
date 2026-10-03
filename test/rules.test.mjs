// Prüft firestore.rules im Emulator:  npm test
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, collection, query, setDoc, updateDoc, where, Timestamp } from "firebase/firestore";

let env;
const H = 3600e3;
const ts = ms => Timestamp.fromMillis(Date.now() + ms);
const game = (extra = {}) => ({ round: "REG", week: 1, away: "NE", home: "SEA",
  kickoff: ts(H), date_hint: null, info: "", winner: null, espn_id: null,
  away_score: null, home_score: null, status: null, detail: null, ...extra });
const pick = (g, p, uid, choice = "home") => ({ game: g, player: p, uid, choice, at: Timestamp.now() });

before(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-tippspiel",
    firestore: { rules: readFileSync("firestore.rules", "utf8") } });
});
after(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c => {
    const db = c.firestore();
    await setDoc(doc(db, "meta/players"), { anni: "uA", olaf: "uO" });
    await setDoc(doc(db, "games/1"), game());                          // offen
    await setDoc(doc(db, "games/2"), game({ kickoff: ts(-H) }));       // angepfiffen
    await setDoc(doc(db, "games/3"), game({ kickoff: null }));         // Zeit offen
    await setDoc(doc(db, "games/4"), game({ status: "in" }));          // ESPN: läuft
    await setDoc(doc(db, "picks/1_anni"), pick("1", "anni", "uA"));
    await setDoc(doc(db, "picks/2_anni"), pick("2", "anni", "uA"));
  });
});
const as = uid => env.authenticatedContext(uid).firestore();

test("Tipp abgeben vor Anpfiff, auch ohne Anstoßzeit", async () => {
  await assertSucceeds(setDoc(doc(as("uO"), "picks/1_olaf"), pick("1", "olaf", "uO")));
  await assertSucceeds(setDoc(doc(as("uO"), "picks/3_olaf"), pick("3", "olaf", "uO")));
  await assertSucceeds(setDoc(doc(as("uO"), "tipped/1_olaf"), { game: "1", player: "olaf" }));
});

test("kein Tipp nach Anpfiff, bei laufendem Spiel oder mit Ergebnis", async () => {
  await assertFails(setDoc(doc(as("uO"), "picks/2_olaf"), pick("2", "olaf", "uO")));
  await assertFails(setDoc(doc(as("uO"), "picks/4_olaf"), pick("4", "olaf", "uO")));
  await assertFails(setDoc(doc(as("uA"), "picks/2_anni"), pick("2", "anni", "uA", "away")));
  await env.withSecurityRulesDisabled(c => updateDoc(doc(c.firestore(), "games/3"), { winner: "home" }));
  await assertFails(setDoc(doc(as("uO"), "picks/3_olaf"), pick("3", "olaf", "uO")));
});

test("nicht für den anderen tippen", async () => {
  await assertFails(setDoc(doc(as("uO"), "picks/1_anni"), pick("1", "anni", "uO")));
  await assertFails(setDoc(doc(as("uO"), "picks/1_olaf"), pick("1", "olaf", "uA")));
  await assertFails(setDoc(doc(as("uX"), "picks/1_olaf"), pick("1", "olaf", "uX")));
  await assertFails(setDoc(doc(as("uO"), "tipped/1_anni"), { game: "1", player: "anni" }));
});

test("fremder Tipp erst nach Anpfiff lesbar", async () => {
  await assertFails(getDoc(doc(as("uO"), "picks/1_anni")));
  await assertSucceeds(getDoc(doc(as("uO"), "picks/2_anni")));
  await assertSucceeds(getDoc(doc(as("uA"), "picks/1_anni")));
  await assertFails(getDoc(doc(as("uX"), "picks/2_anni")));
  await assertFails(getDocs(collection(as("uO"), "picks")));
});

test("eigene Tipps per Abfrage", async () => {
  await assertSucceeds(getDocs(query(collection(as("uA"), "picks"), where("uid", "==", "uA"))));
  await assertFails(getDocs(query(collection(as("uO"), "picks"), where("uid", "==", "uA"))));
});

test("Fremde sehen nichts", async () => {
  await assertFails(getDocs(collection(as("uX"), "games")));
  await assertFails(getDocs(collection(as("uX"), "tipped")));
  await assertSucceeds(getDocs(collection(as("uO"), "games")));
});

test("Anstoßzeit nur verschieben, solange offen", async () => {
  await assertSucceeds(updateDoc(doc(as("uO"), "games/1"), { kickoff: ts(2 * H) }));
  await assertFails(updateDoc(doc(as("uO"), "games/2"), { kickoff: ts(2 * H) }));
  await assertSucceeds(updateDoc(doc(as("uO"), "games/2"), { winner: "away", status: "post" }));
  await assertFails(updateDoc(doc(as("uO"), "games/1"), { week: 3 }));
});

test("Plätze belegen", async () => {
  await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), "meta/players"), { anni: "uA" }));
  await assertFails(updateDoc(doc(as("uX"), "meta/players"), { anni: "uX" }));
  await assertFails(updateDoc(doc(as("uA"), "meta/players"), { olaf: "uA" }));
  await assertFails(updateDoc(doc(as("uX"), "meta/players"), { olaf: "uY" }));
  await assertSucceeds(updateDoc(doc(as("uO"), "meta/players"), { olaf: "uO" }));
  await assertFails(updateDoc(doc(as("uZ"), "meta/players"), { olaf: "uZ" }));
});

test("erster Platz auf leerer Datenbank", async () => {
  await env.clearFirestore();
  await assertFails(setDoc(doc(as("uA"), "meta/players"), { anni: "uA", olaf: "uA" }));
  await assertFails(setDoc(doc(as("uA"), "meta/players"), { anni: "uX" }));
  await assertSucceeds(setDoc(doc(as("uA"), "meta/players"), { anni: "uA" }));
});
