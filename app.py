# -*- coding: utf-8 -*-
"""
Tippspiel Anni vs. Olaf - NFL 2026/27
Ein einzelner Container, SQLite als Datenbank. Ergebnisse kommen live
von der öffentlichen ESPN-Schnittstelle, eintragen per Hand geht weiterhin.
"""
import asyncio
import json
import os
import secrets
import sqlite3
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

BERLIN = ZoneInfo("Europe/Berlin")
DATA = Path(os.environ.get("DATA_DIR", "./data"))
DATA.mkdir(parents=True, exist_ok=True)
DB = DATA / "tippspiel.db"

CODE = os.environ.get("ZUGANGSCODE", "touchdown")
LIVE = os.environ.get("LIVE_ERGEBNISSE", "1") != "0"
SEASON = 2026


def _secret():
    """Sitzungsschluessel: aus der Umgebung, sonst einmalig erzeugen und
    im Datenverzeichnis ablegen. So bleibt man nach Neustarts angemeldet."""
    env = os.environ.get("SECRET_KEY", "").strip()
    if env and "aendern" not in env:
        return env
    f = DATA / "secret.key"
    if not f.exists():
        f.write_text(secrets.token_urlsafe(48))
        f.chmod(0o600)
    return f.read_text().strip()


SECRET = _secret()

PLAYERS = {"anni": "Anni", "olaf": "Olaf"}
ROUND_LABEL = {"REG": "Regular Season", "WC": "Wild Card",
               "DIV": "Divisional", "CONF": "Conference Championship",
               "SB": "Super Bowl LXI"}
WD = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]

@asynccontextmanager
async def lifespan(_app):
    task = asyncio.create_task(live_loop()) if LIVE else None
    yield
    if task:
        task.cancel()


app = FastAPI(title="Tippspiel Anni vs. Olaf", lifespan=lifespan)
app.add_middleware(SessionMiddleware, secret_key=SECRET,
                   max_age=60 * 60 * 24 * 365, same_site="lax")
app.mount("/static", StaticFiles(directory="static"), name="static")


# --------------------------------------------------------------- Datenbank
def db():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    return c


def init_db():
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS games (
          id INTEGER PRIMARY KEY,
          round TEXT NOT NULL,
          week INTEGER NOT NULL,
          away TEXT NOT NULL,
          home TEXT NOT NULL,
          kickoff TEXT,
          date_hint TEXT,
          info TEXT,
          winner TEXT
        );
        CREATE TABLE IF NOT EXISTS picks (
          game_id INTEGER NOT NULL REFERENCES games(id),
          player  TEXT NOT NULL,
          choice  TEXT NOT NULL,
          made_at TEXT NOT NULL,
          PRIMARY KEY (game_id, player)
        );
        """)
        have = c.execute("SELECT COUNT(*) n FROM games").fetchone()["n"]
        if have == 0:
            rows = json.load(open("schedule.json", encoding="utf-8"))
            c.executemany(
                "INSERT INTO games (id,round,week,away,home,kickoff,date_hint,info)"
                " VALUES (:id,:round,:week,:away,:home,:kickoff,:date_hint,:info)",
                rows)
            print(f"Spielplan geladen: {len(rows)} Spiele")
        else:
            print(f"Spielplan vorhanden: {have} Spiele")
        cols = {r["name"] for r in c.execute("PRAGMA table_info(games)")}
        for col, typ in (("espn_id", "TEXT"), ("away_score", "INTEGER"),
                         ("home_score", "INTEGER"), ("status", "TEXT"),
                         ("status_detail", "TEXT")):
            if col not in cols:
                c.execute(f"ALTER TABLE games ADD COLUMN {col} {typ}")


init_db()


# ------------------------------------------------------------------ Helfer
def now():
    return datetime.now(timezone.utc)


def parse_kick(s):
    return datetime.fromisoformat(s).astimezone(timezone.utc) if s else None


def fmt_kick(s):
    """UTC-ISO -> ('So 13.09.', '19:00') in deutscher Zeit."""
    if not s:
        return None, None
    d = datetime.fromisoformat(s).astimezone(BERLIN)
    return f"{WD[d.weekday()]} {d:%d.%m.}", f"{d:%H:%M}"


def fmt_hint(s):
    if not s:
        return ""
    d = datetime.strptime(s, "%Y-%m-%d")
    return f"{WD[d.weekday()]} {d:%d.%m.%Y}"


def started(g):
    """Gesperrt, sobald angepfiffen oder ein Ergebnis eingetragen ist.
    Meldet ESPN das Spiel als laufend, zählt das auch als angepfiffen."""
    k = parse_kick(g["kickoff"])
    return ((k is not None and now() >= k) or g["winner"] is not None
            or g["status"] in ("in", "post"))


def me(request):
    return request.session.get("player")


def current_week():
    """Erste Woche, in der noch ein Spiel nicht angepfiffen ist."""
    with db() as c:
        rows = c.execute(
            "SELECT week, kickoff, winner, status FROM games WHERE round='REG'"
            " ORDER BY week").fetchall()
    for w in range(1, 19):
        if any(not started(r) for r in rows if r["week"] == w):
            return w
    return 19


def all_weeks():
    return [(w, f"Woche {w}") for w in range(1, 19)] + \
           [(19, "Wild Card"), (20, "Divisional"),
            (21, "Conference"), (22, "Super Bowl")]


def scores():
    """Punkte je Spieler, getrennt nach Regular Season und Playoffs."""
    with db() as c:
        rows = c.execute("""
          SELECT g.week, g.round, p.player, p.choice, g.winner
          FROM games g JOIN picks p ON p.game_id = g.id
          WHERE g.winner IS NOT NULL""").fetchall()
    per_week = {k: {w: 0 for w in range(1, 23)} for k in PLAYERS}
    reg = {k: 0 for k in PLAYERS}
    po = {k: 0 for k in PLAYERS}
    for r in rows:
        if r["choice"] == r["winner"] and r["winner"] != "tie":
            per_week[r["player"]][r["week"]] += 1
            (reg if r["round"] == "REG" else po)[r["player"]] += 1
    return per_week, reg, po


def stats(per_week):
    """Trefferquote und Wochensiege je Spieler."""
    with db() as c:
        rows = c.execute("""
          SELECT p.player, COUNT(*) n,
                 SUM(p.choice = g.winner AND g.winner != 'tie') ok
          FROM games g JOIN picks p ON p.game_id = g.id
          WHERE g.winner IS NOT NULL GROUP BY p.player""").fetchall()
        weeks = [r["week"] for r in c.execute(        # nur fertige Wochen
            "SELECT week FROM games GROUP BY week"
            " HAVING SUM(winner IS NULL) = 0")]
    hit = {k: (0, 0) for k in PLAYERS}
    for r in rows:
        hit[r["player"]] = (r["ok"] or 0, r["n"])
    wins = {"anni": 0, "olaf": 0, "tie": 0}
    for w in weeks:
        a, o = per_week["anni"][w], per_week["olaf"][w]
        wins["anni" if a > o else "olaf" if o > a else "tie"] += 1
    return hit, wins


def pct(ok, n):
    return f"{round(ok / n * 100)} %" if n else "–"


# ------------------------------------------------------- Live-Ergebnisse
ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
ESPN_TEAM = {"WSH": "WAS"}            # ESPN-Kürzel, die von unseren abweichen
ESPN_PLAYOFF = {19: 1, 20: 2, 21: 3, 22: 5}   # ESPN-Woche 4 ist der Pro Bowl
last_sync = {"at": None, "ok": None}


def espn_events(week):
    st, ew = (2, week) if week <= 18 else (3, ESPN_PLAYOFF[week])
    req = urllib.request.Request(
        f"{ESPN}?seasontype={st}&week={ew}&dates={SEASON}",
        headers={"User-Agent": "tippspiel"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r).get("events", [])


def status_text(state, name, period, clock):
    if state == "in":
        if name == "STATUS_HALFTIME":
            return "Halbzeit"
        q = f"Q{period}" if period <= 4 else "Verl."
        if name == "STATUS_END_PERIOD":
            return f"Ende {q}"
        return f"{q} · {clock}"
    if state == "post":
        return "Ende n. V." if period > 4 else "Ende"
    if name in ("STATUS_POSTPONED", "STATUS_DELAYED"):
        return "verschoben"
    return None


def parse_event(e):
    c = e["competitions"][0]
    side = {t["homeAway"]: t for t in c["competitors"]}
    typ = e["status"]["type"]
    team = {k: ESPN_TEAM.get(v["team"].get("abbreviation", ""),
                             v["team"].get("abbreviation", ""))
            for k, v in side.items()}

    def score(k):
        s = side[k].get("score")
        return int(s) if s not in (None, "") and typ["state"] != "pre" else None

    winner = None
    if typ.get("completed"):
        winner = ("home" if side["home"].get("winner") else
                  "away" if side["away"].get("winner") else "tie")
    kickoff = None
    if c.get("timeValid", True):
        kickoff = datetime.fromisoformat(
            e["date"].replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
    return {
        "espn_id": str(e["id"]), "away": team["away"], "home": team["home"],
        "kickoff": kickoff, "state": typ["state"], "winner": winner,
        "away_score": score("away"), "home_score": score("home"),
        "detail": status_text(typ["state"], typ.get("name"),
                              e["status"].get("period") or 0,
                              e["status"].get("displayClock") or ""),
    }


def sync_week(week):
    """Holt eine Woche von ESPN und trägt Stand, Ergebnis, Anstoßzeit und
    Playoff-Paarungen ein. Ordnet über ESPN-ID zu, sonst über die Teams."""
    events = [parse_event(e) for e in espn_events(week)]
    with db() as c:
        games = c.execute("SELECT * FROM games WHERE week=? ORDER BY id",
                          (week,)).fetchall()
        by_id = {g["espn_id"]: g for g in games if g["espn_id"]}
        by_teams = {(g["away"], g["home"]): g for g in games if g["away"]}
        free = [g for g in games if not g["away"] and not g["espn_id"]]
        for ev in sorted(events, key=lambda x: x["kickoff"] or ""):
            if "TBD" in (ev["away"], ev["home"]) or not ev["away"]:
                continue
            g = by_id.get(ev["espn_id"]) or by_teams.get((ev["away"], ev["home"]))
            if g is None and free:
                g = free.pop(0)
            if g is None:
                continue
            kick = g["kickoff"]
            if ev["kickoff"] and ev["state"] == "pre":
                kick = ev["kickoff"]
            winner = ev["winner"] or g["winner"]
            c.execute(
                "UPDATE games SET espn_id=?, away=?, home=?, kickoff=?, winner=?,"
                " away_score=?, home_score=?, status=?, status_detail=? WHERE id=?",
                (ev["espn_id"], ev["away"], ev["home"], kick, winner,
                 ev["away_score"], ev["home_score"], ev["state"], ev["detail"],
                 g["id"]))


def weeks_to_sync():
    """Wochen mit offenen Spielen, die angefangen haben oder bald anfangen."""
    soon = (now() + timedelta(days=8)).isoformat()
    with db() as c:
        rows = c.execute(
            "SELECT DISTINCT week FROM games WHERE winner IS NULL"
            " AND COALESCE(kickoff, date_hint) <= ? ORDER BY week",
            (soon,)).fetchall()
    return [r["week"] for r in rows]


def something_live():
    """Läuft gerade ein Spiel? Dann öfter nachsehen."""
    since = (now() - timedelta(hours=5)).isoformat()
    with db() as c:
        return c.execute(
            "SELECT 1 FROM games WHERE winner IS NULL AND (status='in' OR"
            " (kickoff IS NOT NULL AND kickoff BETWEEN ? AND ?)) LIMIT 1",
            (since, now().isoformat())).fetchone() is not None


def sync_all():
    ok = True
    for w in weeks_to_sync():
        try:
            sync_week(w)
        except Exception as e:          # Netz weg, ESPN ändert das Format ...
            ok = False
            print(f"ESPN-Abgleich Woche {w} fehlgeschlagen: {e}")
    last_sync.update(at=now(), ok=ok)


async def live_loop():
    while True:
        await asyncio.to_thread(sync_all)
        await asyncio.sleep(60 if something_live() else 15 * 60)


# ------------------------------------------------------------------- Views
def page(title, body, player=None, week=None):
    nav = ""
    if player:
        opts = "".join(
            f'<option value="{w}"{" selected" if w == week else ""}>{lbl}</option>'
            for w, lbl in all_weeks())
        nav = f"""
        <nav class="nav">
          <form method="get" action="/woche" class="weekpick">
            <label class="sr" for="w">Spielwoche</label>
            <select id="w" name="n" onchange="this.form.submit()">{opts}</select>
          </form>
          <a href="/tabelle" class="navlink">Tabelle</a>
          <a href="/abmelden" class="navlink quiet">{PLAYERS[player]} abmelden</a>
        </nav>"""
    return HTMLResponse(f"""<!doctype html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#f2f4f7">
<title>{title}</title>
<link rel="stylesheet" href="/static/app.css">
</head><body data-me="{player or ''}">
<div class="wrap">{nav}{body}</div>
</body></html>""")


@app.get("/", response_class=HTMLResponse)
def root(request: Request):
    if not me(request):
        return RedirectResponse("/anmelden")
    return RedirectResponse(f"/woche?n={current_week()}")


@app.get("/anmelden", response_class=HTMLResponse)
def login_form(request: Request, fehler: str = ""):
    err = f'<p class="err">{fehler}</p>' if fehler else ""
    return page("Anmelden", f"""
    <header class="hero hero-login">
      <h1>Tippspiel</h1>
      <p class="lede">Anni gegen Olaf, NFL 2026/27. Jede Woche den Sieger tippen.</p>
    </header>
    <form method="post" action="/anmelden" class="login">
      <fieldset>
        <legend>Wer tippt?</legend>
        <div class="who">
          <label class="whobtn anni"><input type="radio" name="player" value="anni" required><span>Anni</span></label>
          <label class="whobtn olaf"><input type="radio" name="player" value="olaf"><span>Olaf</span></label>
        </div>
      </fieldset>
      <label class="field"><span>Zugangscode</span>
        <input type="password" name="code" required autocomplete="current-password"></label>
      {err}
      <button type="submit">Anmelden</button>
    </form>""")


@app.post("/anmelden")
def login(request: Request, player: str = Form(...), code: str = Form(...)):
    if player not in PLAYERS or code != CODE:
        return RedirectResponse("/anmelden?fehler=Code+oder+Name+stimmt+nicht.",
                                status_code=303)
    request.session["player"] = player
    return RedirectResponse("/", status_code=303)


@app.get("/abmelden")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/anmelden", status_code=303)


@app.get("/woche", response_class=HTMLResponse)
def week_view(request: Request, n: int = 0):
    player = me(request)
    if not player:
        return RedirectResponse("/anmelden")
    n = n or current_week()
    other = "olaf" if player == "anni" else "anni"

    with db() as c:
        games = c.execute(
            "SELECT * FROM games WHERE week=? ORDER BY"
            " CASE WHEN kickoff IS NULL THEN 1 ELSE 0 END, kickoff, id",
            (n,)).fetchall()
        picks = {(r["game_id"], r["player"]): r["choice"] for r in
                 c.execute("SELECT game_id,player,choice FROM picks").fetchall()}

    if not games:
        return page("Nicht gefunden", "<p>Diese Woche gibt es nicht.</p>", player, n)

    per_week, reg, po = scores()
    rows, last_day = [], None
    for g in games:
        day, time = fmt_kick(g["kickoff"])
        head = day or fmt_hint(g["date_hint"])
        if head != last_day:
            rows.append(f'<li class="dayhead">{head}</li>')
            last_day = head
        rows.append(game_row(g, player, other, picks, time))

    label = ROUND_LABEL.get(games[0]["round"], "Regular Season")
    title = f"Woche {n}" if n <= 18 else label
    done = sum(1 for g in games if g["winner"])
    playable = [g for g in games if g["away"] and g["home"]]
    tipped = sum(1 for g in playable if (g["id"], player) in picks)
    open_n = sum(1 for g in playable
                 if not started(g) and (g["id"], player) not in picks)
    if open_n == 1:
        stand = "1 Spiel wartet noch auf deinen Tipp"
    elif open_n:
        stand = f"{open_n} Spiele warten noch auf deinen Tipp"
    elif tipped:
        stand = f"{tipped} von {len(playable)} getippt"
    else:
        stand = ""

    return page(f"{title} - Tippspiel", f"""
    {scoreboard(reg, po, player)}
    <section class="week">
      <h2>{title}<span class="wsub">{stand or (label if n <= 18 else "")}
        {f'&nbsp;·&nbsp; {done} gewertet' if done else ''}</span></h2>
      <ul class="games">{''.join(rows)}</ul>
    </section>
    <script src="/static/app.js"></script>""", player, n)


def scoreboard(reg, po, player):
    a, o = reg["anni"] + po["anni"], reg["olaf"] + po["olaf"]
    total = a + o
    pos = 50 if total == 0 else round(a / total * 100)
    lead = ("Gleichstand" if a == o else
            f"Anni führt mit {a - o}" if a > o else f"Olaf führt mit {o - a}")
    return f"""
    <header class="hero">
      <div class="duel">
        <div class="side anni{' isme' if player == 'anni' else ''}">
          <span class="pname">Anni</span><span class="pts">{a}</span></div>
        <div class="side olaf{' isme' if player == 'olaf' else ''}">
          <span class="pts">{o}</span><span class="pname">Olaf</span></div>
      </div>
      <div class="bar"><div class="fill" style="width:{pos}%"></div>
        <div class="knob" style="left:{pos}%"></div></div>
      <p class="lead">{lead}</p>
    </header>"""


def game_row(g, player, other, picks, time):
    gid = g["id"]
    mine = picks.get((gid, player))
    live = started(g)
    win = g["winner"]

    if not (g["away"] and g["home"]):
        return f"""<li class="game empty">
          <div class="matchup">
            <form method="post" action="/spiel/{gid}/teams" class="teamform">
              <input name="away" maxlength="3" placeholder="Gast" value="">
              <span class="at">@</span>
              <input name="home" maxlength="3" placeholder="Heim" value="">
              <button type="submit">Speichern</button>
            </form>
          </div>
          <p class="meta">{g['info']} — Paarung eintragen, sobald sie feststeht</p>
        </li>"""

    def btn(side, code):
        cls = ["pick"]
        if mine == side:
            cls.append("chosen")
        if win == side:
            cls.append("winner")
        dis = " disabled" if live else ""
        pts = g[f"{side}_score"]
        sc = f' <span class="sc">{pts}</span>' if pts is not None else ""
        return (f'<button class="{" ".join(cls)}" data-game="{gid}"'
                f' data-choice="{side}"{dis}>{code}{sc}</button>')

    tip_a = pick_chip("anni", picks.get((gid, "anni")), g, live, player)
    tip_o = pick_chip("olaf", picks.get((gid, "olaf")), g, live, player)

    if g["status"] == "in":
        res = f'<span class="res now">{g["status_detail"] or "läuft"}</span>'
    elif win:
        sieger = "Unentschieden" if win == "tie" else g[win]
        res = f'<span class="res">{g["status_detail"] or "Sieger"} · {sieger}</span>'
    elif live:
        res = f"""<form method="post" action="/spiel/{gid}/ergebnis" class="resform">
          <span>Sieger</span>
          <button name="winner" value="away">{g['away']}</button>
          <button name="winner" value="home">{g['home']}</button>
          <button name="winner" value="tie" class="tie">Unent.</button>
        </form>"""
    else:
        res = ""

    zeit = time or timeform(gid)
    state = " live" if live else ""
    if live and not win:
        state += " running"
    return f"""<li class="game{state}">
      <div class="matchup">
        <span class="time">{zeit}</span>
        {btn('away', g['away'])}<span class="at">@</span>{btn('home', g['home'])}
      </div>
      <div class="strip">{tip_a}{tip_o}{res}</div>
      <p class="meta">{g['info']}</p>
    </li>"""


def timeform(gid):
    return (f'<form method="post" action="/spiel/{gid}/zeit" class="timeform">'
            f'<input type="datetime-local" name="kickoff" required>'
            f'<button type="submit">Zeit</button></form>')


def pick_chip(who, choice, g, live, viewer):
    """Vor Anpfiff sieht man nur, DASS getippt wurde - nicht was."""
    name = PLAYERS[who]
    if not choice:
        if not live and who != viewer:
            return ""          # fremder Tipp fehlt noch - das ist Privatsache
        return f'<span class="chip {who} none">{name} offen</span>'
    if (not live) and who != viewer:
        return f'<span class="chip {who} hid">{name} getippt</span>'
    mark = ""
    if g["winner"]:
        mark = " ok" if choice == g["winner"] else " no"
    return f'<span class="chip {who}{mark}">{name} {g[choice]}</span>'


@app.post("/tipp")
async def set_pick(request: Request):
    player = me(request)
    if not player:
        raise HTTPException(401, "Nicht angemeldet")
    body = await request.json()
    gid, choice = int(body["game"]), body["choice"]
    if choice not in ("away", "home"):
        raise HTTPException(400, "Ungültiger Tipp")
    with db() as c:
        g = c.execute("SELECT * FROM games WHERE id=?", (gid,)).fetchone()
        if not g:
            raise HTTPException(404, "Spiel nicht gefunden")
        if started(g):
            return JSONResponse({"ok": False,
                                 "grund": "Das Spiel läuft schon."}, 409)
        c.execute("INSERT INTO picks (game_id,player,choice,made_at)"
                  " VALUES (?,?,?,?) ON CONFLICT(game_id,player)"
                  " DO UPDATE SET choice=excluded.choice, made_at=excluded.made_at",
                  (gid, player, choice, now().isoformat()))
    return {"ok": True, "choice": choice}


@app.post("/spiel/{gid}/ergebnis")
def set_result(request: Request, gid: int, winner: str = Form(...)):
    if not me(request):
        return RedirectResponse("/anmelden", status_code=303)
    if winner not in ("away", "home", "tie"):
        raise HTTPException(400, "Ungültiger Sieger")
    with db() as c:
        g = c.execute("SELECT * FROM games WHERE id=?", (gid,)).fetchone()
        if g and started(g):
            c.execute("UPDATE games SET winner=? WHERE id=?", (winner, gid))
        week = g["week"] if g else current_week()
    return RedirectResponse(f"/woche?n={week}", status_code=303)


@app.post("/spiel/{gid}/zeit")
def set_kickoff(request: Request, gid: int, kickoff: str = Form(...)):
    if not me(request):
        return RedirectResponse("/anmelden", status_code=303)
    try:
        local = datetime.fromisoformat(kickoff).replace(tzinfo=BERLIN)
    except ValueError:
        raise HTTPException(400, "Zeit nicht lesbar")
    with db() as c:
        c.execute("UPDATE games SET kickoff=? WHERE id=?",
                  (local.astimezone(timezone.utc).isoformat(), gid))
        week = c.execute("SELECT week FROM games WHERE id=?",
                         (gid,)).fetchone()["week"]
    return RedirectResponse(f"/woche?n={week}", status_code=303)


@app.post("/spiel/{gid}/teams")
def set_teams(request: Request, gid: int, away: str = Form(""),
              home: str = Form("")):
    if not me(request):
        return RedirectResponse("/anmelden", status_code=303)
    with db() as c:
        c.execute("UPDATE games SET away=?, home=? WHERE id=?",
                  (away.strip().upper()[:3], home.strip().upper()[:3], gid))
        week = c.execute("SELECT week FROM games WHERE id=?",
                         (gid,)).fetchone()["week"]
    return RedirectResponse(f"/woche?n={week}", status_code=303)


@app.get("/tabelle", response_class=HTMLResponse)
def table(request: Request):
    player = me(request)
    if not player:
        return RedirectResponse("/anmelden")
    per_week, reg, po = scores()
    with db() as c:
        counted = {r["week"]: r["n"] for r in c.execute(
            "SELECT week, COUNT(*) n FROM games WHERE winner IS NOT NULL"
            " GROUP BY week").fetchall()}

    body = []
    for w, lbl in all_weeks():
        if not counted.get(w):
            continue
        a, o = per_week["anni"][w], per_week["olaf"][w]
        cls = "a" if a > o else "o" if o > a else "t"
        body.append(f'<tr class="{cls}"><th>{lbl}</th><td>{a}</td>'
                    f'<td>{o}</td><td class="of">von {counted[w]}</td></tr>')
    if not body:
        body = ['<tr><td colspan="4" class="none">Noch kein Spiel gewertet. '
                'Sobald ihr den ersten Sieger eintragt, steht hier die Bilanz.'
                '</td></tr>']

    hit, wins = stats(per_week)
    if last_sync["at"]:
        t = last_sync["at"].astimezone(BERLIN)
        quelle = (f"Ergebnisse von ESPN, zuletzt abgeglichen um {t:%H:%M} Uhr"
                  + ("" if last_sync["ok"] else " (mit Fehlern, ggf. per Hand eintragen)"))
    elif LIVE:
        quelle = "Ergebnisse von ESPN, der erste Abgleich läuft gleich"
    else:
        quelle = "Live-Ergebnisse sind ausgeschaltet, Sieger per Hand eintragen"

    return page("Tabelle - Tippspiel", f"""
    {scoreboard(reg, po, player)}
    <section class="week">
      <h2>Auswertung</h2>
      <table class="tbl stats">
        <thead><tr><th></th><th>Anni</th><th>Olaf</th><th></th></tr></thead>
        <tbody>
          <tr><th>Trefferquote</th><td>{pct(*hit['anni'])}</td>
            <td>{pct(*hit['olaf'])}</td><td class="of"></td></tr>
          <tr><th>Richtig getippt</th><td>{hit['anni'][0]}</td>
            <td>{hit['olaf'][0]}</td><td class="of">von {hit['anni'][1]} / {hit['olaf'][1]}</td></tr>
          <tr><th>Wochensiege</th><td>{wins['anni']}</td><td>{wins['olaf']}</td>
            <td class="of">{wins['tie']}× gleich</td></tr>
        </tbody>
      </table>
    </section>
    <section class="week">
      <h2>Bilanz<span class="wsub">Regular Season {reg['anni']}:{reg['olaf']}
        &nbsp;·&nbsp; Playoffs {po['anni']}:{po['olaf']}</span></h2>
      <table class="tbl">
        <thead><tr><th></th><th>Anni</th><th>Olaf</th><th></th></tr></thead>
        <tbody>{''.join(body)}</tbody>
      </table>
      <form method="post" action="/aktualisieren" class="sync">
        <p class="meta">{quelle}</p>
        {'<button type="submit">Jetzt aktualisieren</button>' if LIVE else ''}
      </form>
    </section>""", player, current_week())


@app.post("/aktualisieren")
async def refresh(request: Request):
    if not me(request):
        return RedirectResponse("/anmelden", status_code=303)
    if LIVE:
        await asyncio.to_thread(sync_all)
    return RedirectResponse(request.headers.get("referer") or "/tabelle",
                            status_code=303)


@app.get("/gesund")
def health():
    with db() as c:
        n = c.execute("SELECT COUNT(*) n FROM games").fetchone()["n"]
    return {"status": "ok", "spiele": n}
