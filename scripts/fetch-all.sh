#!/usr/bin/env bash
# Fetch every registered airline for one month, one at a time. A failing airline is
# recorded and skipped; it never stops the others. Writes per-airline status to
# public/data/health.json and keeps each airline's last successful fetch from the previous file.
#
# usage: scripts/fetch-all.sh [YYYY-MM]   (default: current UTC month)
# env:   FETCH_TIMEOUT (per airline, default 20m), HEALTH (default public/data/health.json),
#        LOG_DIR (default data/logs)
# exit:  0 if at least one airline succeeded, 1 if every airline failed.
set -uo pipefail

MONTH="${1:-$(date -u +%Y-%m)}"
HEALTH="${HEALTH:-public/data/health.json}"
TIMEOUT="${FETCH_TIMEOUT:-20m}"
LOG_DIR="${LOG_DIR:-data/logs}"
mkdir -p "$LOG_DIR" "$(dirname "$HEALTH")"

if ! IDS=$(bun -e 'import { adapters } from "./src/airlines/index.ts"; console.log(Object.keys(adapters).join(" "))'); then
  echo "could not list airline adapters" >&2
  exit 1
fi

PREV='{"airlines":{}}'
if [[ -s "$HEALTH" ]] && jq -e .airlines "$HEALTH" >/dev/null 2>&1; then PREV=$(cat "$HEALTH"); fi
RESULTS='{}'
ok=0
failed=0

for id in $IDS; do
  log="$LOG_DIR/fetch-$id.log"
  start=$(date +%s)
  timeout "$TIMEOUT" bun run cli fetch "$id" --month "$MONTH" >"$log" 2>&1
  code=$?
  secs=$(( $(date +%s) - start ))
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  films=""
  err=""
  if [[ $code -eq 0 ]]; then
    ok=$((ok + 1)); status=ok
    films=$(grep -oE "^$id $MONTH: [0-9]+ films" "$log" | grep -oE '[0-9]+ films$' | grep -oE '^[0-9]+' || true)
  else
    failed=$((failed + 1)); status=failed
    err=$(tail -n 3 "$log" | tr '\n' ' ' | cut -c1-300)
    if [[ $code -eq 124 ]]; then status=timeout; err="timed out after $TIMEOUT. $err"; fi
  fi
  echo "::group::$id: $status in ${secs}s"
  cat "$log"
  echo "::endgroup::"
  RESULTS=$(jq -c --arg id "$id" --arg status "$status" --arg films "$films" --arg err "$err" \
    --argjson secs "$secs" --argjson code "$code" --arg now "$now" --argjson prev "$PREV" '
    . + {($id): {
      status: $status,
      exitCode: $code,
      films: (if $films == "" then null else ($films | tonumber) end),
      seconds: $secs,
      checkedAt: $now,
      lastSuccess: (if $status == "ok" then $now else ($prev.airlines[$id].lastSuccess // null) end),
      error: (if $err == "" then null else $err end)
    }}' <<<"$RESULTS")
done

jq --arg month "$MONTH" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson ok "$ok" --argjson failed "$failed" \
  '{generatedAt: $now, month: $month, ok: $ok, failed: $failed, airlines: .}' <<<"$RESULTS" >"$HEALTH"
echo "fetch-all $MONTH: $ok ok, $failed failed -> $HEALTH"
[[ $ok -gt 0 ]]
