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
kommt vom gstatic-CDN, Schriften (Barlow Condensed, Inter) von Google Fonts,
Team-Logos vom ESPN-CDN. Hell- und Dunkelmodus über CSS-Variablen in
`app.css`. Bitte so lassen. `package.json` ist nur für Emulator und Tests
da, nicht für die Seite.

Ansichten werden mit `paint(html)` eingespielt, nicht mit `wrap.innerHTML`:
`morph()` fasst nur geänderte Knoten an, sonst flackern bei jedem Abgleich
die Logos. Elemente mit `data-keep` (das Diagramm) zeichnen sich selbst.

`index.html` lädt `app.css` und `app.js` mit `?v=<Zeitstempel>`, damit
Updates sofort ankommen (GitHub Pages cacht sonst bis zu 10 Minuten). Der
Knopf „↻ Stand …“ ruft `hardRefresh()`: leert localStorage (außer
Einstellungen), den Firestore-Offline-Cache und CacheStorage und lädt die
Seite mit neuem `?v=` neu.

## Datenmodell (Firestore)

- `meta/players` — `{anni: uid, olaf: uid}`; wer sich zuerst als Anni bzw.
  Olaf einträgt, ist es
- `games/{id}` — round, week, away, home, kickoff (Timestamp oder null),
  date_hint, info, winner, espn_id, away_score, home_score,
  status (`pre`/`in`/`post`), detail (z. B. „Q3 · 5:21“), pre_wp (Siegchance
  Heimteam in % zum Anpfiff laut ESPN, nach Spielende einmal gespeichert)
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
   Einzige Ausnahme: Papiertipps. Spiele mit Anpfiff vor dem 3.10.2026
   lassen sich bis 18.10.2026 (UTC) nachtragen, auch für den anderen
   (`isBackfill()` in den Regeln, `BACKFILL_BEFORE`/`BACKFILL_UNTIL` in
   app.js, Seite `#nachtragen`). Danach greift die Ausnahme von selbst nicht
   mehr; Regeln und Seite können dann raus.
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

`record()` rechnet die Bilanz eines Teams vor einem Spiel aus den Ergebnissen
der Regular Season in `games`. Die Siegchance (`loadWp()`) kommt aus dem
ESPN-Summary-Endpunkt (`predictor` vor dem Spiel, `winprobability` live),
wird nur angezeigt, nicht gespeichert, und nur geholt, wenn der Knopf an ist.

`storePreWp()` holt nach Spielende einmal die ESPN-Prognose vom Anpfiff
(`winprobability[0]`) und speichert sie als `pre_wp`. Darauf bauen „ESPN als
Mitspieler“ (`espnPick()`, `espnStats()`) und die Statistik-Seite (`#statistik`,
Diagramm als Inline-SVG in `drawChart()`).

„Siegchance der Woche“ (`weekOdds()`, `weekOddsSteps()`, `oddsCard()`,
`drawOdds()`): exakte Verteilung der Punktdifferenz über alle Spiele der
Woche aus ESPN-Siegchance (vor dem Spiel `pre`, live `home`, danach das
Ergebnis) und den Tipps. Fremde Tipps vor Anpfiff werden nicht benutzt,
sondern als „tippt nach ESPN-Wahrscheinlichkeit“ geschätzt – sonst würde die
Grafik geheime Tipps verraten. Verlauf: vor der Woche, nach jedem beendeten
Spiel, live.

Farben Anni/Olaf sind mit dem dataviz-Validator auf Farbschwäche geprüft
(hell `#d6336c`/`#1098ad`, dunkel `#e64980`/`#1098ad`). Nicht ohne erneute
Prüfung ändern.

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
