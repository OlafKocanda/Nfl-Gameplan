#!/usr/bin/env bash
#
# Legt das Repo an und schiebt es zu GitHub.
#
#   ./push-to-github.sh git@github.com:DEIN-NAME/nfl-tippspiel.git
#
# Erst das leere Repo auf github.com anlegen (privat, ohne README,
# ohne .gitignore, ohne Lizenz), dann die URL von dort hier einsetzen.

set -euo pipefail

REMOTE="${1:-}"
if [[ -z "$REMOTE" ]]; then
  echo "Fehlt: die Repo-URL." >&2
  echo "  ./push-to-github.sh git@github.com:DEIN-NAME/nfl-tippspiel.git" >&2
  echo "  ./push-to-github.sh https://github.com/DEIN-NAME/nfl-tippspiel.git" >&2
  exit 1
fi

cd "$(dirname "$0")"

if [[ ! -f app.py ]]; then
  echo "app.py nicht gefunden. Das Skript muss im Projektordner liegen." >&2
  exit 1
fi

if ! git config user.email >/dev/null 2>&1; then
  echo "Git kennt deinen Namen noch nicht. Einmalig setzen:" >&2
  echo '  git config --global user.name "Olaf"' >&2
  echo '  git config --global user.email "deine@mail.de"' >&2
  exit 1
fi

if [[ ! -d .git ]]; then
  git init -q
  echo "Repo angelegt."
fi

git add -A
if git diff --cached --quiet; then
  echo "Nichts Neues zu committen."
else
  git commit -q -m "Tippspiel Anni vs. Olaf - NFL 2026/27"
  echo "Commit erstellt."
fi

git branch -M main

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi

git push -u origin main
echo
echo "Fertig. Fuer spaetere Aenderungen genuegt:"
echo "  git add -A && git commit -m 'was geaendert wurde' && git push"
