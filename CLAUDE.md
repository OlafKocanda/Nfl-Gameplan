# Tippspiel Anni vs. Olaf

Private Web-App, mit der zwei Personen (Anni und Olaf) jede Woche die
Sieger der NFL-Spiele 2026/27 tippen. Statische Seite auf GitHub Pages,
Daten in Firebase Firestore, Anmeldung mit Google, Ergebnisse live von
der ESPN-Scoreboard-Schnittstelle.

Antworte auf Deutsch, du-Form.

## Aufbau

```
index.html          lädt app.css und app.js, sonst nichts
app.js              die komplette Anwendung, ES-Modul, HTML per Template-Strings
app.css             Stylesheet
firebase-config.js  Web-App-Konfiguration (nicht geheim)
firestore.rules     Sicherheitsregeln, hier steckt der Schutz
schedule.json       285 Spiele, beim ersten Start in Firestore geschrieben
test/rules.test.mjs Regeltests gegen den Emulator (npm test)
```

Bewusst klein gehalten: kein Framework, kein Build-Schritt, das Firebase-SDK
kommt vom gstatic-CDN. Bitte so lassen. `package.json` ist nur für Emulator
und Tests da, nicht für die Seite.

## Datenmodell (Firestore)

- `meta/players` — `{anni: uid, olaf: uid}`; wer sich zuerst als Anni bzw.
  Olaf einträgt, ist es
- `games/{id}` — round, week, away, home, kickoff (Timestamp oder null),
  date_hint, info, winner, espn_id, away_score, home_score,
  status (`pre`/`in`/`post`), detail (z. B. „Q3 · 5:21“)
- `picks/{id}_{spieler}` — game (String), player, uid, choice, at
- `tipped/{id}_{spieler}` — game, player; nur DASS getippt wurde

`round` ist `REG`, `WC`, `DIV`, `CONF` oder `SB`. `week` läuft 1–18 für die
Regular Season und 19–22 für die Playoff-Runden. `choice` und `winner` sind
`away`, `home` oder (nur winner) `tie`.

Zeiten als Firestore-Timestamp (UTC), Anzeige in `Europe/Berlin` über `Intl`.

## Regeln, die beim Ändern nicht kaputtgehen dürfen

1. **Tipps sind bis zum Anpfiff geheim.** Durchgesetzt in `firestore.rules`
   (`picks` lesen nur eigene oder bei `!isOpen(game)`). Die Oberfläche holt
   fremde Tipps deshalb einzeln per `getDoc`, erst nach Anpfiff, und merkt
   sie sich in `localStorage` (sie ändern sich danach nie mehr).
2. **Nach Anpfiff ist der Tipp gesperrt.** `isOpen()` in den Regeln und
   `started()` in app.js müssen dasselbe sagen: Anpfiff vorbei *oder*
   Ergebnis eingetragen *oder* ESPN meldet `in`/`post`. Spiele ohne
   Anstoßzeit sind offen, bis eins davon eintritt.
3. Ein Punkt pro richtigem Sieger. Unentschieden gibt niemandem einen Punkt.
4. Jede sichtbare Zeichenkette ist deutsch.

Nach jeder Änderung an `firestore.rules`: `npm test`, und den Nutzer daran
erinnern, die Regeln in der Firebase-Konsole neu zu veröffentlichen.

## Live-Ergebnisse

`loopSync()` läuft im Browser: jede Minute, solange ein Spiel läuft, sonst
alle 15 Minuten. `syncWeek()` ordnet ESPN-Spiele über `espn_id`, sonst über
Gast/Heim zu und füllt freie Playoff-Slots der Reihe nach; geschrieben wird
nur, was sich geändert hat. ESPN-Kürzel, die von unseren abweichen, stehen
in `ESPN_TEAM` (`WSH` → `WAS`). Anstoßzeiten werden nur übernommen, solange
das Spiel offen ist und ESPN `timeValid` meldet.

## Spielplan-Daten

`schedule.json` ist die Quelle der Wahrheit und wurde gegen nfl.com
geprüft: 272 Spiele Regular Season, jedes Team 17 Spiele und eine
Bye-Week, alle 48 Divisionsduelle doppelt mit je einem Heimspiel, NFC
9 / AFC 8 Heimspiele. Wenn du daran etwas änderst, diese Invarianten
nachrechnen (`python3 check_schedule.py`).

Neun Spiele finden an neutralen Orten statt (Melbourne, Rio, 3× London,
Paris, Madrid, München, Mexico City). Dort gibt es ein formales Heimteam,
aber keinen Heimvorteil — steht im `info`-Feld.

## Lokal starten

```bash
npm install
npx firebase emulators:start --only firestore,auth --project demo-tippspiel
npx http-server -p 5000 -c-1 .
# http://localhost:5000/?emu=anni@test.de
```

`?emu=<mail>` (nur auf localhost) verbindet mit dem Emulator und meldet
ohne Google-Popup mit dieser Adresse an.
