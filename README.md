# Tippspiel Anni vs. Olaf — NFL 2026/27

Eine kleine Web-App zum Tippen der NFL-Sieger. Ein Container, SQLite als
Datenbank, kein Account bei irgendwem. Ergebnisse kommen live von ESPN.

- Alle 272 Spiele der Regular Season plus 13 Playoff-Slots
- Anmeldung mit Namen und einem gemeinsamen Zugangscode
- Ein Klick pro Spiel, wird sofort gespeichert
- **Tipps sind bis zum Anpfiff geheim.** Man sieht, *dass* der andere
  getippt hat, aber nicht *was*
- Nach Anpfiff ist der Tipp gesperrt
- **Live-Ergebnisse:** Spielstand, Viertel und Uhr während des Spiels,
  Sieger und Punkte automatisch nach Abpfiff. Die Seite lädt sich bei
  laufenden Spielen jede Minute selbst neu
- Anstoßzeiten (auch verlegte und die erst spät festgelegten in Woche
  16–18) und Playoff-Paarungen übernimmt die App ebenfalls von ESPN
- **Auswertung** in der Tabelle: Trefferquote, Wochensiege, Bilanz je Woche
- Fällt ESPN aus, kann man Sieger, Zeit und Paarung weiter per Hand eintragen
- Alle Zeiten in mitteleuropäischer Zeit, Nachtspiele auf dem Folgetag

## Was drin ist

```
app.py              die ganze Anwendung
schedule.json       der Spielplan, 285 Spiele
gen_schedule.py     erzeugt schedule.json neu
check_schedule.py   prüft den Spielplan auf Vollständigkeit
static/             CSS und ein paar Zeilen JavaScript
Dockerfile          Image-Bau
docker-compose.yml  für die Synology
push-to-github.sh   legt das Repo an und pusht es
CLAUDE.md           Projektkontext für Claude Code
```

Die Daten liegen ausschließlich in `$DATA_DIR/tippspiel.db`, Standard
`/data`. Das muss ein Volume sein, sonst sind die Tipps nach einem
Neustart weg.

## Konfiguration

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `ZUGANGSCODE` | ja | gemeinsames Passwort für Anni und Olaf |
| `SECRET_KEY` | nein | Sitzungsschlüssel. Ohne Angabe wird einmalig einer erzeugt und in `$DATA_DIR/secret.key` abgelegt |
| `DATA_DIR` | nein | Datenverzeichnis, Standard `/data` |
| `PORT` | nein | Standard 8000 |
| `TZ` | nein | `Europe/Vienna` |
| `LIVE_ERGEBNISSE` | nein | `0` schaltet den ESPN-Abgleich ab, Standard an |

## Live-Ergebnisse

Die App fragt die öffentliche Scoreboard-Schnittstelle von ESPN ab
(`site.api.espn.com`, ohne Schlüssel). Während Spiele laufen jede Minute,
sonst alle 15 Minuten, und nur die Wochen, in denen noch etwas offen ist.
Unter *Tabelle* steht, wann zuletzt abgeglichen wurde, dort gibt es auch
den Knopf *Jetzt aktualisieren*.

Die Schnittstelle ist inoffiziell. Ändert ESPN etwas daran, steht der
Fehler im Container-Log und man trägt Sieger so lange per Hand ein.

## Auf der Synology einrichten

1. In der DSM-Dateistation einen Ordner `tippspiel` unter dem gemeinsamen
   Ordner `docker` anlegen, also `/volume1/docker/tippspiel`, und alle
   Dateien hineinkopieren. Du kannst auch die ZIP hochladen und per
   Rechtsklick → Entpacken direkt auf dem NAS auspacken.
2. In `docker-compose.yml` den `ZUGANGSCODE` ändern. Mehr ist nicht nötig.
3. **Container Manager** öffnen → links **Projekt** → **Erstellen**.
   Projektname `tippspiel`, als Pfad den Ordner aus Schritt 1 wählen. DSM
   erkennt die `docker-compose.yml` und fragt, ob sie verwendet werden
   soll — bestätigen, dann **Weiter** und **Fertig**. Der erste Build
   dauert ein paar Minuten, weil das Python-Image geladen wird.
4. Läuft danach unter `http://<NAS-IP>:8420`. Wenn nichts kommt: in der
   Systemsteuerung unter *Sicherheit → Firewall* prüfen, ob Port 8420 im
   lokalen Netz erlaubt ist.

Die Datenbank landet in `/volume1/docker/tippspiel/data/` und wird damit
von einer Hyper-Backup-Sicherung des `docker`-Ordners mitgenommen.

### Von unterwegs erreichbar machen

Der Container hört nur im Heimnetz. Zwei kostenlose Wege nach draußen,
ohne Ports in der Fritzbox zu öffnen:

- **Cloudflare Tunnel** — ergibt eine feste HTTPS-Adresse, läuft als
  zweiter Container daneben, braucht eine eigene Domain bei Cloudflare.
- **Tailscale** — kostenlos für private Nutzung, kein DNS und keine
  Domain nötig, aber beide brauchen die App auf dem Handy.

Wenn ihr nur zu Hause tippt, braucht es nichts davon.

## Lokal entwickeln

```bash
pip install -r requirements.txt
ZUGANGSCODE=test uvicorn app:app --reload --port 8000
```

`DATA_DIR` zeigt dann auf `./data`. Zum Zurücksetzen das Verzeichnis
löschen, der Spielplan wird beim nächsten Start neu importiert.

Nach Änderungen am Spielplan:

```bash
python3 gen_schedule.py && python3 check_schedule.py
```

`check_schedule.py` prüft 272 Spiele, 17 Spiele und eine Bye-Week je
Team, Heimspiele NFC 9 / AFC 8, alle 48 Divisionsduelle doppelt mit je
einem Heimspiel, und dass kein Team zweimal in derselben Woche steht.

## Ins eigene Git bringen

1. Auf github.com ein **leeres, privates** Repo anlegen — ohne README,
   ohne .gitignore, ohne Lizenz.
2. Einmalig, falls Git dich noch nicht kennt:

   ```bash
   git config --global user.name "Olaf"
   git config --global user.email "deine@mail.de"
   ```

3. Im Projektordner:

   ```bash
   ./push-to-github.sh git@github.com:DEIN-NAME/nfl-tippspiel.git
   ```

Später genügt `git add -A && git commit -m "..." && git push`.

Nicht im Repo landen durch die `.gitignore`: `data/` mit der Datenbank,
der Sitzungsschlüssel und alle `.pyc`-Dateien.

## Mit Claude Code weiterbauen

```bash
cd /pfad/zu/tippspiel
claude
```

Es gibt keinen Upload — Claude Code liest das Verzeichnis direkt. Die
`CLAUDE.md` wird beim Start automatisch gelesen und enthält Datenmodell,
die Regeln, die nicht kaputtgehen dürfen, und was noch offen ist.

Auf NixOS funktioniert der übliche `curl | bash`-Installer nicht, weil
der Standard-Linker unter `/lib64` fehlt. Stattdessen:

```bash
nix-shell -p claude-code
```

Oder dauerhaft in der `configuration.nix`:

```nix
environment.systemPackages = [ pkgs.claude-code ];
nixpkgs.config.allowUnfreePredicate = pkg:
  builtins.elem (lib.getName pkg) [ "claude-code" ];
```

## Nach der Auslosung nachtragen

Manches legt die NFL erst im Saisonverlauf fest. Das kommt normalerweise
automatisch von ESPN, lässt sich aber auch in der Oberfläche eintragen:

- **Anstoßzeit fehlt** (24 Spiele in Woche 16, 17 und ganz Woche 18) — in
  der Spielzeile steht ein Datumsfeld. Erst mit eingetragener Zeit greift
  die Sperre zum Anpfiff.
- **Playoff-Paarung fehlt** — in den Ansichten Wild Card, Divisional,
  Conference und Super Bowl stehen leere Slots für die Team-Kürzel.

## Punkte

Ein Punkt pro richtig getipptem Sieger, Regular Season und Playoffs gleich
gewichtet. Bei Unentschieden bekommt niemand einen Punkt, wer nicht
getippt hat auch nicht.

## Zugriff

Keine Nutzerverwaltung, keine Rollen: wer Link und Zugangscode hat, kommt
rein und kann als Anni oder als Olaf tippen. Bei zwei Leuten, die sich
vertrauen, ist das Absicht. Wenn die App öffentlich erreichbar ist, nimm
einen Code, den niemand errät. Suchmaschinen sind per `noindex`
ausgeschlossen.
