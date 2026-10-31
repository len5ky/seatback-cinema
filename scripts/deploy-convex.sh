#!/usr/bin/env bash
# Deploy convex/ (the IMDb import service) to the seatback-cinema production deployment, with the Convex login in
# ~/.convex/config.json. CONVEX_DEPLOYMENT may name any deployment of the project; `convex deploy` targets its default prod.
#   scripts/deploy-convex.sh
# Settings live in Convex env vars, changeable without a redeploy: IMPORT_SECRET (scripts/rotate-import-secret.sh),
# IMPORT_DAILY_CAP (default 2000), IMPORT_PER_USER_CAP (default 10):  node_modules/.bin/convex env set --prod IMPORT_DAILY_CAP 500
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export CONVEX_DEPLOYMENT="${CONVEX_DEPLOYMENT:-prod:brave-warthog-617}"
[[ -x node_modules/.bin/convex ]] || "${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}" install --frozen-lockfile
node_modules/.bin/convex deploy --typecheck enable
