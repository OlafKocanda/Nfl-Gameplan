# -*- coding: utf-8 -*-
"""
Prueft schedule.json auf Vollstaendigkeit und Konsistenz.

    python3 check_schedule.py

Faellt mit Exit-Code 1 durch, wenn eine Invariante verletzt ist.
Nach jeder Aenderung an gen_schedule.py ausfuehren.
"""
import json
import sys
from collections import Counter, defaultdict

DIV = {
    "AFC East": ["BUF", "MIA", "NE", "NYJ"],
    "AFC North": ["BAL", "CIN", "CLE", "PIT"],
    "AFC South": ["HOU", "IND", "JAX", "TEN"],
    "AFC West": ["DEN", "KC", "LAC", "LV"],
    "NFC East": ["DAL", "NYG", "PHI", "WAS"],
    "NFC North": ["CHI", "DET", "GB", "MIN"],
    "NFC South": ["ATL", "CAR", "NO", "TB"],
    "NFC West": ["ARI", "LAR", "SEA", "SF"],
}
TEAMS = sorted(t for v in DIV.values() for t in v)
CONF = {t: d.split()[0] for d, ts in DIV.items() for t in ts}

rows = json.load(open("schedule.json", encoding="utf-8"))
reg = [g for g in rows if g["round"] == "REG"]
errors = []


def check(ok, msg):
    print(f"  {'OK     ' if ok else 'FEHLER '} {msg}")
    if not ok:
        errors.append(msg)


print("Spielplan 2026/27")
check(len(reg) == 272, f"272 Spiele Regular Season (gefunden: {len(reg)})")
check(len(rows) - len(reg) == 13, "13 Playoff-Slots")

unknown = {t for g in reg for t in (g["away"], g["home"])} - set(TEAMS)
check(not unknown, f"nur bekannte Team-Kuerzel {sorted(unknown) or ''}")

weeks = defaultdict(list)
for g in reg:
    weeks[g["away"]].append(g["week"])
    weeks[g["home"]].append(g["week"])

bad = [t for t in TEAMS if len(weeks[t]) != 17]
check(not bad, f"jedes Team 17 Spiele {bad or ''}")

bad = [t for t in TEAMS
       if len(set(range(1, 19)) - set(weeks[t])) != 1
       or len(weeks[t]) != len(set(weeks[t]))]
check(not bad, f"jedes Team genau eine Bye-Week {bad or ''}")

home = Counter(g["home"] for g in reg)
bad = [t for t in TEAMS if home[t] != (9 if CONF[t] == "NFC" else 8)]
check(not bad, f"Heimspiele NFC 9 / AFC 8 {bad or ''}")

pairs = Counter(frozenset((g["away"], g["home"])) for g in reg)
bad = []
for ts in DIV.values():
    for i in range(len(ts)):
        for j in range(i + 1, len(ts)):
            x, y = ts[i], ts[j]
            n = pairs[frozenset((x, y))]
            hx = sum(1 for g in reg if {g["away"], g["home"]} == {x, y}
                     and g["home"] == x)
            if n != 2 or hx != 1:
                bad.append(f"{x}-{y}")
check(not bad, f"48 Divisionsduelle doppelt, je einmal daheim {bad or ''}")

odd = [sorted(p) for p, c in pairs.items() if c > 2]
check(not odd, f"keine Paarung mehr als zweimal {odd or ''}")

for wk in range(1, 19):
    g = [x for x in reg if x["week"] == wk]
    ts = [t for x in g for t in (x["away"], x["home"])]
    if len(ts) != len(set(ts)):
        errors.append(f"Woche {wk}: Team doppelt angesetzt")
check(all(f"Woche {w}" not in e for w in range(1, 19) for e in errors),
      "kein Team zweimal in derselben Woche")

tbd = [g for g in reg if g["kickoff"] is None]
print(f"\n  {len(tbd)} Spiele ohne feste Anstosszeit "
      f"(Woche {sorted({g['week'] for g in tbd})})")

print(f"\n{'Alles in Ordnung.' if not errors else str(len(errors)) + ' Fehler.'}")
sys.exit(1 if errors else 0)
