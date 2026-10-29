#!/usr/bin/env bash
# American answers HTTP 429 to GitHub runner IPs, so its catalogue is fetched from this machine instead.
# Fetches the current month with headless Playwright, matches, syncs ids, exports American only, rebuilds
# index.json, and pushes public/data/american/<month>.json + index.json + ids.json + health.json to main [skip ci].
#
# usage: scripts/american-local.sh [--dry-run] [YYYY-MM]
#   --dry-run  reuse cached raw files (no --refresh) and stop before commit/push
# env:   PLANE_MOVIE_DATA / PLANE_MOVIE_PUBLIC as for the CLI (the dry run points them at copies)
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
PUBLIC="${PLANE_MOVIE_PUBLIC:-public/data}"
HEALTH="$PUBLIC/health.json"
mkdir -p tmp
exec 9>tmp/american-local.lock
flock -n 9 || { echo "another american-local run holds tmp/american-local.lock" >&2; exit 1; }

echo "== american-local $MONTH $(date -u +%FT%TZ) dry=$DRY"
if [[ $DRY -eq 0 ]]; then
  [[ "$(git rev-parse --abbrev-ref HEAD)" == main ]] || { echo "not on main, refusing to publish" >&2; exit 1; }
  git pull --rebase --autostash origin main # pick up CI's ids.json and health.json first
fi

REFRESH=(--refresh)
[[ $DRY -eq 1 ]] && REFRESH=()
start=$(date +%s)
bun run cli fetch american --month "$MONTH" "${REFRESH[@]}"
bun run cli match --airline american
bun run cli ids sync --airline american || echo "ids sync failed; tmdbId may be null for new films" >&2
bun run cli export --month "$MONTH" --airline american
bun scripts/build-index.ts "$PUBLIC"

FILE="$PUBLIC/american/$MONTH.json"
films=$(jq .count "$FILE")
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
prev='{"airlines":{}}'
[[ -s "$HEALTH" ]] && prev=$(cat "$HEALTH")
jq --arg now "$now" --argjson films "$films" --argjson secs "$(( $(date +%s) - start ))" '
  .airlines.american = {status: "ok", reason: "fetched locally", exitCode: 0, films: $films, seconds: $secs,
    checkedAt: $now, lastSuccess: $now, error: null}' <<<"$prev" >"$HEALTH.tmp" && mv "$HEALTH.tmp" "$HEALTH"

PATHS=("$FILE" "$PUBLIC/index.json" "$PUBLIC/ids.json" "$HEALTH")
if [[ $DRY -eq 1 ]]; then
  echo "dry run: would commit ${PATHS[*]} ($films films) and push to main"
  exit 0
fi
git add -- "${PATHS[@]}"
if git diff --cached --quiet -- "${PATHS[@]}"; then
  echo "no American changes"
  exit 0
fi
git commit -m "Publish $MONTH American catalogue (local fetch) [skip ci]" -- "${PATHS[@]}"
git push origin HEAD:main
echo "pushed $(git rev-parse --short HEAD)"
