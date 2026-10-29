#!/usr/bin/env bash
# Push the dataset commit at HEAD to main, rebasing over anything pushed meanwhile. scripts/american-local.sh publishes
# American's files plus index.json, ids.json and health.json, so those three can conflict. On a conflict the rebase
# keeps this run's side, then regenerates the shared files: health.json = this run's entries, with the airlines in
# SKIP_AIRLINES (fetched elsewhere) taken from upstream; ids.json = upstream overlaid with this run's ids;
# index.json rebuilt from the files on disk. Up to 3 attempts.
# usage: scripts/push-dataset.sh [dir]   (default public/data)
# env:   SKIP_AIRLINES (space-separated, default "american"), REMOTE (default origin), BRANCH (default main)
set -euo pipefail
DIR="${1:-public/data}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"
SKIP="${SKIP_AIRLINES-american}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT

regenerate_shared() { # $1 = our commit before the rebase, $2 = upstream commit
  local ours=$1 up=$2
  git show "$up:$DIR/health.json" >"$TMPD/up-health.json" 2>/dev/null || echo '{"airlines":{}}' >"$TMPD/up-health.json"
  git show "$up:$DIR/ids.json" >"$TMPD/up-ids.json" 2>/dev/null || echo '{}' >"$TMPD/up-ids.json"
  if git show "$ours:$DIR/health.json" >"$TMPD/our-health.json" 2>/dev/null; then
    jq --slurpfile up "$TMPD/up-health.json" --arg skip "$SKIP" '
      ($skip | split(" ") | map(select(. != ""))) as $s
      | .airlines |= with_entries(if (.key | IN($s[])) and ($up[0].airlines[.key] != null)
                                  then .value = $up[0].airlines[.key] else . end)' \
      "$TMPD/our-health.json" >"$DIR/health.json"
  fi
  if git show "$ours:$DIR/ids.json" >"$TMPD/our-ids.json" 2>/dev/null; then
    # same layout as writeIdsFile: sorted, one entry per line
    bun -e '
      const [up, ours, out] = process.argv.slice(1);
      const ids = { ...(await Bun.file(up).json()), ...(await Bun.file(ours).json()) };
      const keys = Object.keys(ids).sort();
      await Bun.write(out, `{\n${keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(ids[k])}`).join(",\n")}\n}\n`);
    ' "$TMPD/up-ids.json" "$TMPD/our-ids.json" "$DIR/ids.json"
  fi
  bun "$HERE/build-index.ts" "$DIR"
  git add -- "$DIR/health.json" "$DIR/ids.json" "$DIR/index.json"
  git commit -q --amend --no-edit
}

for attempt in 1 2 3; do
  git fetch -q "$REMOTE" "$BRANCH"
  up=$(git rev-parse FETCH_HEAD)
  ours=$(git rev-parse HEAD)
  if ! git rebase -q "$up" >"$TMPD/rebase.log" 2>&1; then
    git rebase --abort
    echo "rebase onto $REMOTE/$BRANCH conflicted; regenerating index.json, ids.json and health.json"
    git rebase -q -X theirs "$up" # in a rebase, "theirs" is the commit being replayed: this run's side
    regenerate_shared "$ours" "$up"
  fi
  if git push -q "$REMOTE" "HEAD:$BRANCH"; then
    echo "pushed $(git rev-parse --short HEAD)"
    exit 0
  fi
  echo "push attempt $attempt rejected" >&2
done
echo "could not push after 3 attempts" >&2
exit 1
