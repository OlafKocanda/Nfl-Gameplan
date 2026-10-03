# Tippspiel Anni vs. Olaf

Private Web-App, mit der zwei Personen (Anni und Olaf) jede Woche die
Sieger der NFL-Spiele 2026/27 tippen. Läuft als einzelner Docker-Container
auf einer Synology. Einzige externe Quelle: die ESPN-Scoreboard-Schnittstelle
für Live-Ergebnisse.

Antworte auf Deutsch, du-Form.

## Aufbau

```
app.py            die komplette Anwendung, FastAPI, HTML inline erzeugt
schedule.json     285 Spiele, beim ersten Start in SQLite importiert
static/app.css    Stylesheet
static/app.js     setzt Tipps per fetch, sonst nichts
Dockerfile        python:3.12-slim, uvicorn
docker-compose.yml  für Container Manager auf der Synology
```

Bewusst klein gehalten: keine Templates, kein ORM, kein Build-Schritt, kein
Frontend-Framework. Bitte so lassen — Abhängigkeiten nur hinzufügen, wenn
es ohne sie wirklich nicht geht.

## Datenmodell

SQLite in `$DATA_DIR/tippspiel.db`, Standard `/data`.

- `games` — id, round, week, away, home, kickoff, date_hint, info, winner,
  espn_id, away_score, home_score, status (`pre`/`in`/`post`), status_detail
  (die Live-Spalten werden beim Start per `ALTER TABLE` ergänzt)
- `picks` — game_id, player, choice, made_at (PK: game_id + player)

`round` ist `REG`, `WC`, `DIV`, `CONF` oder `SB`. `week` läuft 1–18 für die
Regular Season und 19–22 für die Playoff-Runden. `choice` und `winner` sind
`away`, `home` oder (nur winner) `tie`.

Zeiten liegen **immer als UTC-ISO** in der DB und werden erst beim Rendern
nach `Europe/Berlin` umgerechnet. Nie lokale Zeit speichern.

## Regeln, die beim Ändern nicht kaputtgehen dürfen

1. **Tipps sind bis zum Anpfiff geheim.** Man sieht, *dass* der andere
   getippt hat, nicht *was*. Steckt in `pick_chip()`.
2. **Nach Anpfiff ist der Tipp gesperrt.** `started()` ist die eine Stelle,
   die das entscheidet: Anpfiff vorbei *oder* Ergebnis eingetragen.
   Spiele ohne Anstoßzeit (`kickoff IS NULL`) sind erst gesperrt, wenn ein
   Ergebnis steht.
3. Ein Punkt pro richtigem Sieger. Unentschieden gibt niemandem einen Punkt.
4. Jede sichtbare Zeichenkette ist deutsch.

## Live-Ergebnisse

`live_loop()` läuft als Hintergrund-Task (FastAPI-Lifespan) und ruft
`sync_all()` auf: jede Minute, solange ein Spiel läuft, sonst alle 15
Minuten. `sync_week()` ordnet ESPN-Spiele über `espn_id`, sonst über
Gast/Heim zu und füllt freie Playoff-Slots der Reihe nach. ESPN-Kürzel,
die von unseren abweichen, stehen in `ESPN_TEAM` (`WSH` → `WAS`).
Anstoßzeiten werden nur übernommen, solange das Spiel noch nicht läuft
und ESPN `timeValid` meldet. Ein Sieger von ESPN überschreibt einen per
Hand eingetragenen. `LIVE_ERGEBNISSE=0` schaltet alles ab.

## Was noch offen ist

Die NFL legt manches erst im Saisonverlauf fest. Normalerweise kommt das
von ESPN; als Rückfall lässt sich beides in der Oberfläche nachtragen, dafür gibt es `POST /spiel/{id}/zeit` und
`POST /spiel/{id}/teams`:

- 24 Spiele ohne Anstoßzeit (Woche 16, 17 und ganz Woche 18)
- 13 Playoff-Slots ohne Paarung

## Spielplan-Daten

`schedule.json` ist die Quelle der Wahrheit und wurde gegen nfl.com
geprüft: 272 Spiele Regular Season, jedes Team 17 Spiele und eine
Bye-Week, alle 48 Divisionsduelle doppelt mit je einem Heimspiel, NFC
9 / AFC 8 Heimspiele. Wenn du daran etwas änderst, diese Invarianten
nachrechnen.

Neun Spiele finden an neutralen Orten statt (Melbourne, Rio, 3× London,
Paris, Madrid, München, Mexico City). Dort gibt es ein formales Heimteam,
aber keinen Heimvorteil — steht im `info`-Feld.

## Lokal starten

```bash
pip install -r requirements.txt
ZUGANGSCODE=test uvicorn app:app --reload --port 8000
```

`DATA_DIR` zeigt dann auf `./data`. Zum Zurücksetzen das Verzeichnis
löschen, der Spielplan wird beim nächsten Start neu importiert.

## Umgebung

| Variable | Bedeutung |
|---|---|
| `ZUGANGSCODE` | gemeinsames Passwort, Pflicht |
| `SECRET_KEY` | optional, sonst einmalig erzeugt in `$DATA_DIR/secret.key` |
| `DATA_DIR` | Standard `/data` |
| `PORT` | Standard 8000 |
| `LIVE_ERGEBNISSE` | `0` schaltet den ESPN-Abgleich ab |

## Sicherheit

Keine Nutzerverwaltung, keine Rollen — ein geteilter Code, danach wählt man
aus, wer man ist. Das ist bei zwei Leuten Absicht. Dazu passend: keine
Geheimnisse ins Repo, `data/` und `secret.key` stehen in `.gitignore`.
