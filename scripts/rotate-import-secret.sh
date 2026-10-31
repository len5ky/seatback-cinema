#!/usr/bin/env bash
# Make a new shared secret for the Worker -> Convex import call and set it on both sides (never printed or kept on disk):
# Convex env var IMPORT_SECRET on the prod deployment, and the Worker secret IMPORT_SECRET.
# Also records CONVEX_URL and the secret's name (not its value) in the env file (mode 600).
#   SEATBACK_CF_ENV=~/.config/seatback/env scripts/rotate-import-secret.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${SEATBACK_CF_ENV:-$HOME/.config/seatback/env}"
CONVEX_URL_VALUE="${CONVEX_URL_VALUE:-https://brave-warthog-617.convex.cloud}"
cd "$ROOT"
set -a; source "$ENV_FILE"; set +a
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}" CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-${CF_ACCOUNT_ID:-}}"
export CONVEX_DEPLOYMENT="${CONVEX_DEPLOYMENT:-prod:brave-warthog-617}"

mkdir -p tmp
umask 077
f=$(mktemp "$ROOT/tmp/import-secret.XXXXXX")
trap 'rm -f "$f"' EXIT
secret=$(openssl rand -hex 32)
printf 'IMPORT_SECRET=%s\n' "$secret" >"$f"
node_modules/.bin/convex env set --prod --from-file "$f" >/dev/null
printf '%s' "$secret" | (cd worker && node_modules/.bin/wrangler secret put IMPORT_SECRET >/dev/null)
unset secret

# record the URL and the secret's name in the env file
tmpenv=$(mktemp "$ROOT/tmp/seatback-env.XXXXXX")
grep -vE '^(CONVEX_URL|SEATBACK_IMPORT_SECRET_NAME)=' "$ENV_FILE" >"$tmpenv" || true
printf 'CONVEX_URL=%s\nSEATBACK_IMPORT_SECRET_NAME=IMPORT_SECRET\n' "$CONVEX_URL_VALUE" >>"$tmpenv"
install -m 600 "$tmpenv" "$ENV_FILE"
rm -f "$tmpenv"
echo "IMPORT_SECRET set on Convex (prod) and on the seatback Worker; $ENV_FILE has CONVEX_URL and the secret name"
