#!/usr/bin/env bash
# Zip the claude.ai skill for upload at claude.ai, Settings, Capabilities, Skills.
# The zip holds one folder named after the skill (inflight-movie-picker-web/SKILL.md), which is what the upload expects.
# usage: scripts/package-web-skill.sh [out.zip]   (default tmp/inflight-movie-picker-web.zip)
# Also copies the zip to public/, where the Worker serves it for the /taste page's download link (commit it).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME=inflight-movie-picker-web
SRC="$ROOT/skill/$NAME"
OUT="${1:-$ROOT/tmp/$NAME.zip}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac

[ -f "$SRC/SKILL.md" ] || { echo "missing $SRC/SKILL.md" >&2; exit 1; }
# the folder name must match the skill's frontmatter name
grep -q "^name: $NAME\$" "$SRC/SKILL.md" || { echo "$SRC/SKILL.md: frontmatter name is not $NAME" >&2; exit 1; }
if grep -n "$(printf '\342\200\224')" "$SRC/SKILL.md" >&2; then echo "em dash in SKILL.md (lines above)" >&2; exit 1; fi

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
(cd "$ROOT/skill" && zip -qr -X "$OUT" "$NAME" -x '*.DS_Store')
cp "$OUT" "$ROOT/public/$NAME.zip"
echo "$OUT"
unzip -l "$OUT" | sed -n '4,$p' | head -n -2
