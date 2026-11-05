// Weekly canary for the IMDb import path (issue #14): POST the production Convex /import/imdb endpoint for one known
// profile and exit 1 unless ratings came back with scores. Run by .github/workflows/imdb-canary.yml.
// Env: CONVEX_SITE_URL (https://<deployment>.convex.site), IMPORT_SECRET, CANARY_IMDB_USER (an ur id).

export interface CanaryVerdict { ok: boolean; message: string }

interface ImportJson {
  ok?: unknown; error?: unknown; message?: unknown; cached?: unknown;
  import?: { rated?: unknown; total_ratings?: unknown; degraded?: unknown; notes?: unknown };
}

/** Pure: healthy only when the import returned ratings, learned scores for them, and reported no score failure. */
export function checkImport(status: number, body: unknown): CanaryVerdict {
  const b = (body ?? {}) as ImportJson;
  if (status !== 200 || b.ok !== true || !b.import)
    return { ok: false, message: `import failed: HTTP ${status} ${String(b.error ?? "")} ${String(b.message ?? "")}`.trim() };
  const imp = b.import;
  const total = typeof imp.total_ratings === "number" ? imp.total_ratings : 0;
  const rated = typeof imp.rated === "number" ? imp.rated : 0;
  const notes = Array.isArray(imp.notes) ? imp.notes.filter((n): n is string => typeof n === "string") : [];
  const scoreNote = notes.find((n) => /score lookup failed|without scores|hash|scoreless/i.test(n));
  if (total <= 0) return { ok: false, message: "import returned no ratings" };
  if (rated <= 0 || imp.degraded === true || scoreNote)
    return { ok: false, message: `ratings came back without scores (rated=${rated}/${total}, degraded=${String(imp.degraded)})${scoreNote ? `: ${scoreNote}` : ""}` };
  return { ok: true, message: `ok: ${rated}/${total} ratings with scores, cached=${String(b.cached)}` };
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
    body: JSON.stringify({ user }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = { error: "non_json", message: text.slice(0, 200) }; }
  const v = checkImport(res.status, body);
  console.log(v.message);
  process.exit(v.ok ? 0 : 1);
}
