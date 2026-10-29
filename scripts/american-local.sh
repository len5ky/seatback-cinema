#!/usr/bin/env bash
# American answers HTTP 429 to GitHub runner IPs, so its catalogue is fetched from this machine instead.
# Fetches the current month with headless Playwright, matches, syncs ids, exports American only, rebuilds
# index.json, and pushes public/data/american/<month>.json + index.json + ids.json + health.json to main [skip ci].
# The publish happens in a dedicated worktree (tmp/american-publish, detached at origin/main): the checked-out
# branch of this repo is never reset, rebased or committed to, whatever it holds.
#
# usage: scripts/american-local.sh [--dry-run] [YYYY-MM]
#   --dry-run  reuse cached raw files (no --refresh), work on copies of the database and the American raw cache
#              under tmp/american-dry/, commit in the publish worktree and stop before the push; the real data/ is
#              not touched. With AMERICAN_REMOTE set (e.g. a local bare repo), the dry run also pushes there.
# env:   PLANE_MOVIE_DATA as for the CLI (ignored by --dry-run, which uses its copy)
#        AMERICAN_REMOTE  remote name or URL to publish to (default origin)
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

REMOTE="${AMERICAN_REMOTE:-origin}"
WT=tmp/american-publish
echo "== american-local $MONTH $(date -u +%FT%TZ) dry=$DRY remote=$REMOTE"
if [[ $DRY -eq 1 ]]; then
  SRC_DATA="${PLANE_MOVIE_DATA:-data}"
  DRY_DIR=tmp/american-dry
  rm -rf "$DRY_DIR" && mkdir -p "$DRY_DIR/data/raw"
  # a consistent snapshot even while another process (e.g. a ratings crawl) writes the real database
  bun -e 'import { Database } from "bun:sqlite"; new Database(process.argv[1], { readonly: true }).run(`VACUUM INTO '"'"'${process.argv[2]}'"'"'`)' \
    "$SRC_DATA/plane_movie.sqlite" "$DRY_DIR/data/plane_movie.sqlite"
  [[ -d "$SRC_DATA/raw/american" ]] && cp -r "$SRC_DATA/raw/american" "$DRY_DIR/data/raw/"
  export PLANE_MOVIE_DATA="$DRY_DIR/data"
fi

# Fresh worktree of the remote's main; ids sync seeds from, and export writes into, its public/data.
git fetch -q "$REMOTE" main
git worktree remove --force "$WT" 2>/dev/null || rm -rf "$WT"
git worktree prune
git worktree add -q --detach "$WT" FETCH_HEAD
export PLANE_MOVIE_PUBLIC="$WT/public/data"
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

commit_files() {
  local rel=("${PATHS[@]#"$WT/"}")
  git -C "$WT" add -- "${rel[@]}"
  if git -C "$WT" diff --cached --quiet -- "${rel[@]}"; then return 1; fi
  git -C "$WT" -c user.name="$(git config user.name)" -c user.email="$(git config user.email)" \
    commit -q -m "Publish $MONTH American catalogue (local fetch) [skip ci]" -- "${rel[@]}"
}
commit_files || { echo "no American changes"; exit 0; }
echo "committed $(git -C "$WT" rev-parse --short HEAD) in $WT ($FILMS films)"
if [[ $DRY -eq 1 && -z "${AMERICAN_REMOTE:-}" ]]; then
  echo "dry run: would push $(git -C "$WT" rev-parse --short HEAD) to $REMOTE main; worktree left at $WT"
  exit 0
fi

# CI may have pushed while the browser walk ran. On a rejected push, re-fetch and rebase the worktree; if that
# conflicts (both touched index.json, ids.json or health.json), reset the worktree to the remote and regenerate.
for attempt in 1 2 3; do
  if git -C "$WT" push -q "$REMOTE" HEAD:main; then
    echo "pushed $(git -C "$WT" rev-parse --short HEAD) to $REMOTE main"
    exit 0
  fi
  echo "push attempt $attempt rejected; rebasing the publish worktree" >&2
  git -C "$WT" fetch -q "$REMOTE" main
  if ! git -C "$WT" rebase -q FETCH_HEAD; then
    git -C "$WT" rebase --abort
    git -C "$WT" reset -q --hard FETCH_HEAD
    publish_files
    commit_files || { echo "no American changes after rebase"; exit 0; }
  fi
done
echo "could not push after 3 attempts" >&2
exit 1
