#!/usr/bin/env bash
# Deploy the seatback Worker to https://seatback.len5ky.com from devserver (the bundle needs the local SQLite db).
#   scripts/deploy-worker.sh            export --worker, create the PROFILES KV namespace if missing, wrangler deploy, smoke
# Credentials: env file at $SEATBACK_CF_ENV (default ~/.config/seatback/env) with CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
# (CF_API_TOKEN / CF_ACCOUNT_ID also accepted) and CONVEX_URL for the IMDb import service. The token is never printed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${SEATBACK_CF_ENV:-$HOME/.config/seatback/env}"
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
BASE_URL="${SEATBACK_URL:-https://seatback.len5ky.com}"

[[ -r $ENV_FILE ]] || { echo "missing credentials file $ENV_FILE (set SEATBACK_CF_ENV)" >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-${CF_ACCOUNT_ID:-}}"
[[ -n $CLOUDFLARE_API_TOKEN && -n $CLOUDFLARE_ACCOUNT_ID ]] || { echo "$ENV_FILE needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID" >&2; exit 1; }

cd "$ROOT"
DB="${PLANE_MOVIE_DATA:-data}/plane_movie.sqlite"
[[ -s $DB ]] || { echo "no catalogue db at $DB: run from the checkout that holds data/, or set PLANE_MOVIE_DATA" >&2; exit 1; }
"$BUN" src/cli.ts export --worker
cd worker
[[ -x node_modules/.bin/wrangler ]] || "$BUN" install --frozen-lockfile
WRANGLER=node_modules/.bin/wrangler

# KV namespace "seatback-PROFILES": reuse it if it exists, else create it; write its id into wrangler.toml (ids are not secret: commit the change).
if grep -q 'REPLACE_WITH_KV_ID' wrangler.toml; then
  kv_id=$("$WRANGLER" kv namespace list | jq -r '.[] | select(.title == "seatback-PROFILES") | .id' | head -1)
  if [[ -z $kv_id ]]; then
    "$WRANGLER" kv namespace create seatback-PROFILES >/dev/null
    kv_id=$("$WRANGLER" kv namespace list | jq -r '.[] | select(.title == "seatback-PROFILES") | .id' | head -1)
  fi
  [[ -n $kv_id ]] || { echo "could not find or create the seatback-PROFILES KV namespace" >&2; exit 1; }
  sed -i "s/REPLACE_WITH_KV_ID/$kv_id/" wrangler.toml
  echo "KV namespace seatback-PROFILES = $kv_id (written to worker/wrangler.toml; commit it)"
fi

# The Convex import service: CONVEX_URL (https://<name>.convex.cloud) in the env file; HTTP actions are served on .convex.site.
# Its secret is a Worker secret (scripts/rotate-import-secret.sh), which deploys keep.
vars=()
if [[ -n ${CONVEX_URL:-} ]]; then vars=(--var "IMPORT_URL:${CONVEX_URL/.convex.cloud/.convex.site}"); else echo "no CONVEX_URL in $ENV_FILE: IMDb imports go direct (and mostly fail)" >&2; fi
"$WRANGLER" deploy "${vars[@]}"
cd "$ROOT"
# a new custom domain can take a minute to get its certificate
for i in $(seq 1 12); do curl -sf -o /dev/null --max-time 10 "$BASE_URL/healthz" && break; sleep 10; done
scripts/worker-smoke.sh "$BASE_URL"
