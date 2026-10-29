#!/usr/bin/env bash
# American answers HTTP 429 to GitHub runner IPs, so its catalogue is fetched from this machine instead.
# Fetches the current month with headless Playwright, matches, syncs ids, exports American only, rebuilds
# index.json, and pushes public/data/american/<month>.json + index.json + ids.json + health.json to main [skip ci].
#
# usage: scripts/american-local.sh [--dry-run] [YYYY-MM]
#   --dry-run  reuse cached raw files (no --refresh), work on copies of the database, the American raw cache and
#              public/data under tmp/american-dry/, and stop before commit/push; the real data/ and public/data are not touched
# env:   PLANE_MOVIE_DATA / PLANE_MOVIE_PUBLIC as for the CLI (ignored by --dry-run, which uses its copies)
# cron:  0 3 1,15 * * scripts/american-local.sh >> tmp/cron-american.log 2>&1   (user crontab on the dev machine, UTC)
set -euo pipefail

DRY=0
MONTH=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]) MONTH="$a" ;;
    *) echo "usage: $0 [--dry-run] [YYYY-MM]" >&2; exit 2 ;;
  esac
done
MONTH="${MONTH:-$(date -u +%Y-%m)}"

cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"
mkdir -p tmp
exec 9>tmp/american-local.lock
flock -n 9 || { echo "another american-local run holds tmp/american-local.lock" >&2; exit 1; }

echo "== american-local $MONTH $(date -u +%FT%TZ) dry=$DRY"
if [[ $DRY -eq 1 ]]; then
  SRC_DATA="${PLANE_MOVIE_DATA:-data}"
  SRC_PUBLIC="${PLANE_MOVIE_PUBLIC:-public/data}"
  DRY_DIR=tmp/american-dry
  rm -rf "$DRY_DIR" && mkdir -p "$DRY_DIR/data/raw" "$DRY_DIR/public"
  # a consistent snapshot even while another process (e.g. a ratings crawl) writes the real database
  bun -e 'import { Database } from "bun:sqlite"; new Database(process.argv[1], { readonly: true }).run(`VACUUM INTO '"'"'${process.argv[2]}'"'"'`)' \
    "$SRC_DATA/plane_movie.sqlite" "$DRY_DIR/data/plane_movie.sqlite"
  [[ -d "$SRC_DATA/raw/american" ]] && cp -r "$SRC_DATA/raw/american" "$DRY_DIR/data/raw/"
  cp -r "$SRC_PUBLIC" "$DRY_DIR/public/data"
  export PLANE_MOVIE_DATA="$DRY_DIR/data" PLANE_MOVIE_PUBLIC="$DRY_DIR/public/data"
else
  [[ "$(git rev-parse --abbrev-ref HEAD)" == main ]] || { echo "not on main, refusing to publish" >&2; exit 1; }
  git pull --rebase --autostash origin main # pick up CI's ids.json and health.json first
fi
PUBLIC="${PLANE_MOVIE_PUBLIC:-public/data}"
HEALTH="$PUBLIC/health.json"
FILE="$PUBLIC/american/$MONTH.json"
PATHS=("$FILE" "$PUBLIC/index.json" "$PUBLIC/ids.json" "$HEALTH")

REFRESH=(--refresh)
[[ $DRY -eq 1 ]] && REFRESH=()
start=$(date +%s)
bun run cli fetch american --month "$MONTH" "${REFRESH[@]}"
bun run cli match --airline american
bun run cli ids sync --airline american || echo "ids sync failed; tmdbId may be null for new films" >&2
secs=$(( $(date +%s) - start ))

# Export American, rebuild the index and record American's health. Re-run after a rebase onto CI's newer files.
publish_files() {
  bun run cli export --month "$MONTH" --airline american
  bun scripts/build-index.ts "$PUBLIC"
  local now prev
  FILMS=$(jq .count "$FILE")
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  prev='{"airlines":{}}'
  [[ -s "$HEALTH" ]] && prev=$(cat "$HEALTH")
  jq --arg now "$now" --argjson films "$FILMS" --argjson secs "$secs" '
    .airlines.american = {status: "ok", reason: "fetched locally", exitCode: 0, films: $films, seconds: $secs,
      checkedAt: $now, lastSuccess: $now, error: null}' <<<"$prev" >"$HEALTH.tmp" && mv "$HEALTH.tmp" "$HEALTH"
}

FILMS=""
publish_files
if [[ $DRY -eq 1 ]]; then
  echo "dry run: would commit ${PATHS[*]#"$DRY_DIR/"} ($FILMS films) and push to main; copies left in $DRY_DIR"
  exit 0
fi

commit_files() {
  git add -- "${PATHS[@]}"
  if git diff --cached --quiet -- "${PATHS[@]}"; then return 1; fi
  git commit -m "Publish $MONTH American catalogue (local fetch) [skip ci]" -- "${PATHS[@]}"
}
commit_files || { echo "no American changes"; exit 0; }

# CI may have pushed while the browser walk ran: rebase right before pushing. On a conflict (both touched
# index.json, ids.json or health.json), drop our commit, take CI's files and regenerate ours on top.
for attempt in 1 2 3; do
  if git pull --rebase --autostash origin main && git push origin HEAD:main; then
    echo "pushed $(git rev-parse --short HEAD)"
    exit 0
  fi
  echo "push attempt $attempt failed; regenerating on top of origin/main" >&2
  git rebase --abort 2>/dev/null || true
  git fetch origin main
  git reset --keep origin/main
  publish_files
  commit_files || { echo "no American changes after rebase"; exit 0; }
done
echo "could not push after 3 attempts" >&2
exit 1
