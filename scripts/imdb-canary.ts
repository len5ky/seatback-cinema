// Weekly canary for the IMDb import path (issue #14): POST the production Convex /import/imdb endpoint for one known
// profile with force: true (skips the cache) and exit 1 unless IMDb answered with scored ratings. Run by .github/workflows/imdb-canary.yml.
// Env: CONVEX_SITE_URL (https://<deployment>.convex.site), IMPORT_SECRET, CANARY_IMDB_USER (an ur id).

/** A healthy import scores nearly every rating it read; below this share IMDb's score lookup is mostly failing. */
export const MIN_SCORED_SHARE = 0.8;

export interface CanaryVerdict { ok: boolean; message: string }

interface ImportJson {
  ok?: unknown; error?: unknown; message?: unknown; cached?: unknown;
  import?: { rated?: unknown; total_ratings?: unknown; degraded?: unknown; notes?: unknown; profile?: { seen?: unknown } };
}

/** Pure: healthy only when IMDb was queried (not the Convex cache), returned ratings, scored at least MIN_SCORED_SHARE
 * of the ratings read (profile.seen; total_ratings if absent, since large profiles are truncated), and noted no score failure. */
export function checkImport(status: number, body: unknown): CanaryVerdict {
  const b = (body ?? {}) as ImportJson;
  if (status !== 200 || b.ok !== true || !b.import)
    return { ok: false, message: `import failed: HTTP ${status} ${String(b.error ?? "")} ${String(b.message ?? "")}`.trim() };
  if (b.cached !== false) return { ok: false, message: "import was answered from the Convex cache, so IMDb was not checked (is force: true deployed?)" };
  const imp = b.import;
  const seen = imp.profile?.seen;
  const total = Array.isArray(seen) ? seen.length : typeof imp.total_ratings === "number" ? imp.total_ratings : 0;
  const rated = typeof imp.rated === "number" ? imp.rated : 0;
  const notes = Array.isArray(imp.notes) ? imp.notes.filter((n): n is string => typeof n === "string") : [];
  const scoreNote = notes.find((n) => /score lookup failed|without scores|hash|scoreless/i.test(n));
  if (total <= 0) return { ok: false, message: "import returned no ratings" };
  if (rated < total * MIN_SCORED_SHARE || imp.degraded === true || scoreNote)
    return { ok: false, message: `ratings came back without scores (rated=${rated}/${total}, need ${MIN_SCORED_SHARE * 100}%, degraded=${String(imp.degraded)})${scoreNote ? `: ${scoreNote}` : ""}` };
  return { ok: true, message: `ok: ${rated}/${total} ratings with scores` };
}

if (import.meta.main) {
  const { CONVEX_SITE_URL: site, IMPORT_SECRET: secret, CANARY_IMDB_USER: user } = process.env;
  if (!site || !secret || !user) {
    console.error("missing CONVEX_SITE_URL, IMPORT_SECRET or CANARY_IMDB_USER");
    process.exit(2);
  }
  const res = await fetch(`${site.replace(/\/+$/, "")}/import/imdb`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-import-secret": secret },
    body: JSON.stringify({ user, force: true }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = { error: "non_json", message: text.slice(0, 200) }; }
  const v = checkImport(res.status, body);
  console.log(v.message);
  process.exit(v.ok ? 0 : 1);
}
