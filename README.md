# Tippspiel Anni vs. Olaf — NFL 2026/27

Eine kleine Web-App zum Tippen der NFL-Sieger. Eine statische Seite auf
GitHub Pages, die Tipps liegen dauerhaft in Google Firebase (Firestore),
die Ergebnisse kommen live von ESPN. Kostenlos, kein eigener Server.

- Alle 272 Spiele der Regular Season plus 13 Playoff-Slots
- Anmeldung mit Google. Beim ersten Mal legt man fest, wer man ist
  (Anni oder Olaf), danach ist der Platz fest und ein drittes Konto kommt
  nicht mehr rein
- Ein Klick pro Spiel, wird sofort gespeichert
- **Tipps sind bis zum Anpfiff geheim.** Man sieht, *dass* der andere
  getippt hat, aber nicht *was*. Das erzwingt die Datenbank selbst
  (`firestore.rules`), nicht nur die Oberfläche
- Nach Anpfiff ist der Tipp gesperrt
- **Live-Ergebnisse:** Spielstand, Viertel und Uhr während des Spiels,
  Sieger und Punkte automatisch nach Abpfiff. Während Spiele laufen,
  aktualisiert sich die Seite jede Minute
- Anstoßzeiten (auch verlegte und die erst spät festgelegten in Woche
  16–18) und Playoff-Paarungen kommen ebenfalls von ESPN
- Unter jedem Team steht seine **Bilanz** (z. B. 3:0) vor diesem Spiel
- Optional per Knopf **Siegchance**: vor dem Spiel die ESPN-Prognose,
  während des Spiels live. Die Einstellung merkt sich jedes Gerät
- **Auswertung** in der Tabelle: Trefferquote, Wochensiege mit 🏆, Bilanz je
  Woche. **ESPN spielt mit:** tippt immer den Favoriten laut Prognose zum
  Anpfiff, so seht ihr, ob ihr besser seid als die Statistik
- **Wochensieger-Banner** über jeder Spielwoche, während der Woche der
  Zwischenstand
- **Erinnerung:** Hinweis oben, wenn in den nächsten 36 Stunden Spiele ohne
  deinen Tipp beginnen. Über *Kalender-Erinnerung* lädt man eine Kalenderdatei
  mit einer Erinnerung pro Woche (2 Stunden vor dem ersten Spiel und vor den
  Sonntagsspielen). Die Zeiten sind die zum Zeitpunkt des Herunterladens
- **Statistik:** Punkteverlauf (Anni, Olaf, ESPN), wie oft ihr gleich getippt
  habt, Favorit oder Außenseiter, Heimteams, Lieblings- und Problemteams
- Fällt ESPN aus, kann man Sieger, Zeit und Paarung per Hand eintragen
- **Papiertipps:** Die Tipps für die Spiele vor dem Start der App (Wochen
  1–3 und das Donnerstagsspiel der Woche 4) lassen sich bis einschließlich
  17.10.2026 unter *Papiertipps* nachtragen, auch für den anderen
- Alle Zeiten in deutscher Zeit

## Was drin ist

```
index.html          die Seite
app.js              die ganze Anwendung
app.css             Stylesheet
firebase-config.js  Zugangsdaten der Firebase-Web-App (nicht geheim)
firestore.rules     Sicherheitsregeln der Datenbank
schedule.json       der Spielplan, 285 Spiele
gen_schedule.py     erzeugt schedule.json neu
check_schedule.py   prüft den Spielplan auf Vollständigkeit
test/               Tests für die Sicherheitsregeln
```

## Einrichten (einmalig, ca. 10 Minuten)

### 1. Firebase-Projekt

1. <https://console.firebase.google.com> → **Projekt hinzufügen**, Name
   z. B. `nfl-tippspiel`, Google Analytics ausschalten.
2. **Build → Authentication → Jetzt starten**, unter *Anmeldeanbieter*
   **Google** aktivieren und speichern.
3. Ebenfalls unter *Authentication* → **Einstellungen → Autorisierte
   Domains** → `olafkocanda.github.io` hinzufügen. Ohne das schlägt die
   Google-Anmeldung auf der Website fehl.
4. **Build → Firestore Database → Datenbank erstellen**, Standort
   `europe-west3 (Frankfurt)`, **Produktionsmodus**.
5. Im Firestore-Bereich den Reiter **Regeln** öffnen, den Inhalt durch den
   von [`firestore.rules`](firestore.rules) ersetzen und **Veröffentlichen**.
6. **Projekteinstellungen** (Zahnrad) → *Allgemein* → *Meine Apps* →
   Web-App hinzufügen (`</>`), Name egal, *kein* Firebase Hosting. Die
   angezeigten Werte in [`firebase-config.js`](firebase-config.js) eintragen.

Der kostenlose Spark-Tarif reicht bei Weitem, eine Kreditkarte ist nicht
nötig.

### 2. GitHub Pages

Im Repo auf GitHub: **Settings → Pages → Build and deployment** →
*Source* „Deploy from a branch“, Branch `main`, Ordner `/ (root)` →
**Save**. Nach ein, zwei Minuten läuft die Seite unter
`https://olafkocanda.github.io/Nfl-Gameplan/`.

### 3. Erster Start

Anni und Olaf öffnen die Seite, melden sich mit Google an und wählen
einmal ihren Namen. Beim allerersten Start schreibt die App den Spielplan
in die Datenbank und holt die bisherigen Ergebnisse von ESPN.

## Live-Ergebnisse

Die Seite fragt die öffentliche Scoreboard-Schnittstelle von ESPN direkt
aus dem Browser ab (`site.api.espn.com`, ohne Schlüssel): jede Minute,
solange Spiele laufen, sonst alle 15 Minuten, und nur die Wochen, in denen
noch etwas offen ist. Neue Stände schreibt sie in die Datenbank, so sieht
der andere sie sofort. Ist niemand auf der Seite, holt der nächste Besuch
alles nach.

Die Schnittstelle ist inoffiziell. Ändert ESPN etwas daran, trägt man
Sieger so lange per Hand ein. Unter *Tabelle* steht, wann zuletzt
abgeglichen wurde, dort gibt es auch *Jetzt aktualisieren*.

## Punkte

Ein Punkt pro richtig getipptem Sieger, Regular Season und Playoffs gleich
gewichtet. Bei Unentschieden bekommt niemand einen Punkt, wer nicht
getippt hat auch nicht.

## Sicherheit

`firebase-config.js` ist nicht geheim, die Werte stehen in jeder
ausgelieferten Seite. Geschützt sind die Daten über `firestore.rules`:

- Lesen und Schreiben nur für die beiden eingetragenen Google-Konten
- Einen fremden Tipp liefert die Datenbank erst nach Anpfiff aus
- Tipps nach Anpfiff, bei laufendem Spiel oder mit Ergebnis lehnt sie ab
- Tipps für den anderen lehnt sie ab

Zwischen Anni und Olaf gibt es bewusst keine Rollen: beide können Sieger,
Anstoßzeiten und Paarungen eintragen. Suchmaschinen sind per `noindex`
ausgeschlossen.

Einen Platz neu vergeben (z. B. anderes Google-Konto): in der
Firebase-Konsole unter Firestore das Dokument `meta/players` bearbeiten.

## Lokal entwickeln

```bash
npm install
npx firebase emulators:start --only firestore,auth --project demo-tippspiel
npx http-server -p 5000 -c-1 .
```

Dann `http://localhost:5000/?emu=anni@test.de` öffnen (ein zweites
Fenster mit `?emu=olaf@test.de`). Mit `?emu=` spricht die Seite nur mit
dem lokalen Emulator, die Anmeldung braucht kein echtes Google-Konto.

Sicherheitsregeln testen:

```bash
npm test
```

Nach Änderungen am Spielplan:

```bash
python3 gen_schedule.py && python3 check_schedule.py
```

`check_schedule.py` prüft 272 Spiele, 17 Spiele und eine Bye-Week je
Team, Heimspiele NFC 9 / AFC 8, alle 48 Divisionsduelle doppelt mit je
einem Heimspiel, und dass kein Team zweimal in derselben Woche steht.
Steht der Spielplan schon in der Datenbank, muss man geänderte Spiele dort
anpassen (oder die Sammlung `games` löschen, dann legt die App sie neu an).
