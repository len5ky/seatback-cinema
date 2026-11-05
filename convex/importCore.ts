// IMDb import service logic, free of Convex imports so the tests can drive it with an in-memory store.
// The HTTP action (http.ts) checks the shared secret; the Node action (importer.ts) runs runImport with the real store.
import {
  ImdbClient, ImdbError, ImdbNotFound, ImdbPrivate, ImdbRefusal, importImdbProfile, parseImdbUserUrl, resolveImdbUser, type ImdbDeps, type ImdbImport,
} from "../worker/src/imdb.ts";

export interface Caps { daily: number; perUser: number }
export const DEFAULT_CAPS: Caps = { daily: 2_000, perUser: 10 };
export const CACHE_MS = 24 * 3600_000;
/** Scores could not be read: keep it an hour so a retry can pick them up. */
export const DEGRADED_MS = 3600_000;

/** IMPORT_DAILY_CAP / IMPORT_PER_USER_CAP, read on every call so they change without a redeploy. */
export function capsFromEnv(env: Record<string, string | undefined>): Caps {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return v !== undefined && v.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : d;
  };
  return { daily: num(env.IMPORT_DAILY_CAP, DEFAULT_CAPS.daily), perUser: num(env.IMPORT_PER_USER_CAP, DEFAULT_CAPS.perUser) };
}

/** UTC day, the window both caps count in. */
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type Reservation = { ok: true } | { ok: false; scope: "daily" | "user" };

/** Whether one more import fits. `global` is null when the global slot was already taken for this request. */
export function checkCaps(global: number | null, user: number, caps: Caps): Reservation {
  if (global !== null && global >= caps.daily) return { ok: false, scope: "daily" };
  if (user >= caps.perUser) return { ok: false, scope: "user" };
  return { ok: true };
}

export const expiresAt = (imp: ImdbImport, now: number) => now + (imp.degraded ? DEGRADED_MS : CACHE_MS);

/** Constant-time string comparison for the shared secret (no node:crypto in the default Convex runtime). */
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** What runImport needs from the database. `key` is a ur id, or a p. profile id that aliases one. */
export interface ImportStore {
  cached(key: string): Promise<ImdbImport | null>;
  reserve(key: string, countGlobal: boolean): Promise<Reservation>;
  save(imp: ImdbImport, alias: string | null): Promise<void>;
  /** Point a p. alias at an already cached ur import, keeping that import's expiry. */
  alias(alias: string, ur: string): Promise<void>;
}

export type ImportError = "bad_request" | "capped" | "challenged" | "private" | "not_found" | "imdb_error";
export type ImportBody =
  | { ok: true; cached: boolean; import: ImdbImport }
  | { ok: false; error: ImportError; message: string; scope?: "daily" | "user" };
export interface ImportResult { status: number; body: ImportBody; calls: number }

const fail = (status: number, error: ImportError, message: string, calls: number, scope?: "daily" | "user"): ImportResult =>
  ({ status, body: { ok: false, error, message, ...(scope ? { scope } : {}) }, calls });

/** Cache, then caps, then IMDb. Every IMDb call is counted against both caps before it is made. `force` skips the cache (the canary). */
export async function runImport(store: ImportStore, deps: ImdbDeps, user: string, o: { force?: boolean } = {}): Promise<ImportResult> {
  let calls = 0;
  const counted: ImdbDeps = { fetch: (url, init) => { calls++; return deps.fetch(url, init); }, sleep: deps.sleep };
  const ref = parseImdbUserUrl(user);
  if (!ref) return fail(400, "bad_request", "user must be an IMDb profile URL, a ur id or a p. id", 0);
  const hit = o.force ? null : await store.cached(ref.id);
  if (hit) return { status: 200, body: { ok: true, cached: true, import: hit }, calls };
  const capped = (r: Reservation) => (r.ok ? null : fail(429, "capped", r.scope === "daily"
    ? "The import service has reached its limit for today."
    : "This IMDb profile has been imported as often as allowed today.", calls, r.scope));
  const first = capped(await store.reserve(ref.id, true));
  if (first) return first;
  const client = new ImdbClient(counted);
  try {
    const ur = await resolveImdbUser(client, ref);
    let alias: string | null = null;
    if (ref.kind === "p") {
      alias = ref.id;
      const known = o.force ? null : await store.cached(ur);
      if (known) { await store.alias(alias, ur); return { status: 200, body: { ok: true, cached: true, import: known }, calls }; }
      const second = capped(await store.reserve(ur, false));
      if (second) return second;
    }
    const imp = await importImdbProfile(client, ur);
    await store.save(imp, alias);
    return { status: 200, body: { ok: true, cached: false, import: imp }, calls };
  } catch (e) {
    if (e instanceof ImdbRefusal) return fail(502, "challenged", e.message, calls);
    if (e instanceof ImdbPrivate) return fail(422, "private", e.message, calls);
    if (e instanceof ImdbNotFound) return fail(422, "not_found", e.message, calls);
    if (e instanceof ImdbError) return fail(422, "imdb_error", e.message, calls);
    throw e;
  }
}
