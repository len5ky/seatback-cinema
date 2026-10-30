#!/usr/bin/env bash
# Smoke-test the seatback Worker's MCP endpoint: scripts/worker-smoke.sh <base-url>   (e.g. http://localhost:8787)
# Needs curl and jq. Exits non-zero on the first failed check.
set -euo pipefail
BASE="${1:?usage: worker-smoke.sh <base-url>}"
BASE="${BASE%/}"
MCP="$BASE/mcp"
id=0
fail() { echo "FAIL: $*" >&2; exit 1; }

# rpc <method> <params-json> -> response body on stdout
rpc() {
  id=$((id + 1))
  curl -sS --max-time 90 -X POST "$MCP" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-06-18' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"$1\",\"params\":$2}"
}
# tool <name> <arguments-json> -> structuredContent on stdout (fails on isError)
tool() {
  local r
  r=$(rpc tools/call "{\"name\":\"$1\",\"arguments\":$2}")
  [[ $(jq -r '.result.isError' <<<"$r") == "false" ]] || fail "$1: $(jq -c '.error // .result.content' <<<"$r")"
  jq '.result.structuredContent' <<<"$r"
}

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$BASE/healthz")
[[ $code == 200 ]] || fail "healthz returned $code"
echo "ok   healthz 200"

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$MCP")
[[ $code == 405 ]] || fail "GET /mcp returned $code, expected 405"
echo "ok   GET /mcp 405"

r=$(rpc initialize '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}')
v=$(jq -r '.result.protocolVersion' <<<"$r")
[[ $v == 2025-06-18 ]] || fail "initialize: $r"
echo "ok   initialize -> protocol $v, server $(jq -r '.result.serverInfo.name' <<<"$r")"

r=$(rpc tools/list '{}')
names=$(jq -r '[.result.tools[].name] | join(",")' <<<"$r")
[[ $names == *picks* && $names == *save_profile* ]] || fail "tools/list: $r"
echo "ok   tools/list -> $names"

r=$(tool list_airlines '{}')
n=$(jq '.airlines | length' <<<"$r")
(( n >= 3 )) || fail "list_airlines: only $n airlines"
echo "ok   list_airlines -> $n airlines: $(jq -r '[.airlines[] | "\(.id) \(.month) \(.films)/\(.matched) \(.health)"] | join("; ")' <<<"$r")"

# three seen ids: the top three unfiltered emirates picks, so hidden_seen must be 3
seen=$(tool picks '{"airline":"emirates","limit":3}' | jq -c '[.picks[].imdbId]')
[[ $(jq length <<<"$seen") == 3 ]] || fail "could not get three emirates ids"
r=$(tool picks "{\"airline\":\"emirates\",\"filters\":{\"min_year\":2025},\"profile\":{\"seen\":$seen},\"limit\":5}")
count=$(jq '.picks | length' <<<"$r")
(( count > 0 )) || fail "picks min_year 2025 returned nothing"
jq -e '[.picks[].year] | all(. >= 2025)' <<<"$r" >/dev/null || fail "picks: a film before 2025"
jq -e --argjson s "$seen" '[.picks[].imdbId] | any(. as $i | $s | index($i)) | not' <<<"$r" >/dev/null || fail "picks: a seen film came back"
echo "ok   picks emirates min_year 2025, seen $seen -> $count picks, hidden_seen $(jq '.hidden_seen' <<<"$r") (seen ids outside 2025+ are not counted)"
jq -r '.picks[] | "       \(.score)  \(.title) (\(.year)) \(.runtime) min  IMDb \(.imdb)  why: \(.why | join("; "))"' <<<"$r"

token=$(tool save_profile "{\"profile\":{\"seen\":$seen,\"ratings\":{\"tt0111161\":9},\"source\":\"smoke\"}}" | jq -r '.token')
[[ $token =~ ^[a-z2-7]{20}$ ]] || fail "save_profile token: $token"
echo "ok   save_profile -> token ${token:0:4}…"
r=$(tool get_profile "{\"token\":\"$token\"}")
[[ $(jq -c '.seen' <<<"$r") == "$seen" ]] || fail "get_profile: $r"
echo "ok   get_profile -> $(jq -c '{seen: (.seen | length), ratings: (.ratings | length), source}' <<<"$r")"
r=$(tool picks "{\"airline\":\"emirates\",\"profile\":{\"token\":\"$token\"},\"limit\":3}")
[[ $(jq '.hidden_seen' <<<"$r") -ge 3 ]] || fail "picks with token: $r"
echo "ok   picks with saved token -> hidden_seen $(jq '.hidden_seen' <<<"$r"), profile_source $(jq -r '.profile_source' <<<"$r")"

# Optional, because it calls IMDb: SMOKE_IMDB_URL=https://www.imdb.com/user/<id>/ratings/ scripts/worker-smoke.sh <base>
if [[ -n ${SMOKE_IMDB_URL:-} ]]; then
  r=$(tool profile_from_imdb_url "{\"url\":\"$SMOKE_IMDB_URL\"}")
  u=$(jq -r '.imdb_user' <<<"$r")
  [[ $u =~ ^ur[0-9]+$ ]] && (( $(jq '.seen' <<<"$r") > 0 )) || fail "profile_from_imdb_url: $r"
  echo "ok   profile_from_imdb_url -> $(jq -c '{imdb_user, cached, seen, rated, total_ratings, watchlist, truncated, liked_genres, notes}' <<<"$r")"
  r=$(tool picks "{\"airline\":\"emirates\",\"profile\":{\"imdb_user\":\"$u\"},\"limit\":3}")
  echo "ok   picks with imdb_user -> hidden_seen $(jq '.hidden_seen' <<<"$r"), profile_source $(jq -r '.profile_source' <<<"$r")"
  jq -r '.picks[] | "       \(.score)  \(.title) (\(.year))  why: \(.why | join("; "))"' <<<"$r"
fi
echo "SMOKE OK $BASE"
