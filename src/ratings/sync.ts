import type { Database } from "bun:sqlite";
import { BROWSER_UA, politeFetch } from "./http.ts";
import { mergeIds, rankedTconsts } from "./ids.ts";
import { parseLetterboxd, parseMc, parseRt, parseTmdbFind, type Score } from "./sources.ts";

export const SOURCES = ["tmdb", "letterboxd", "rt", "mc"] as const;
export type Source = (typeof SOURCES)[number];
/** Rows each source writes into `ratings`; the first one decides freshness. */
const KEYS: Record<Source, string[]> = { tmdb: ["tmdb"], letterboxd: ["letterboxd"], rt: ["rt_critics", "rt_audience"], mc: ["mc_critics", "mc_user"] };
export const CACHE_DAYS = 30;
const PAGE_HEADERS = { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" };

/** A failure worth caching as "nothing there" (404) versus one to retry next run (network, 403/429, 5xx). */
class Transient extends Error {}

async function getPage(url: string): Promise<{ html: string; url: string } | null> {
  let res: Response;
  try { res = await politeFetch(url, { headers: PAGE_HEADERS }); } catch (e) { throw new Transient(`${url}: ${e instanceof Error ? e.message : e}`); }
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Transient(`${url} -> ${res.status}`);
  return { html: await res.text(), url: res.url };
}

export function storeScore(db: Database, tconst: string, source: string, s: Score, now = new Date().toISOString()): void {
  db.run("INSERT OR REPLACE INTO ratings VALUES (?,?,?,?,?,?)", [tconst, source, s.value, s.votes, s.extra ? JSON.stringify(s.extra) : null, now]);
}

const EMPTY: Score = { value: null, votes: null };
interface Slugs { rt_slug: string | null; mc_slug: string | null }

async function fetchOne(db: Database, source: Source, tconst: string, slugs: Slugs | null, tmdbKey: string | undefined): Promise<"stored" | "skipped"> {
  switch (source) {
    case "letterboxd": {
      const page = await getPage(`https://letterboxd.com/imdb/${tconst}/`);
      const p = page && /letterboxd\.com\/film\//.test(page.url) ? parseLetterboxd(page.html, page.url) : null;
      storeScore(db, tconst, "letterboxd", p?.rating ?? EMPTY);
      if (p && (p.slug || p.tmdbId)) mergeIds(db, tconst, { tmdbId: p.tmdbId, letterboxdSlug: p.slug }, "letterboxd");
      return "stored";
    }
    case "rt": {
      if (!slugs?.rt_slug) return "skipped";
      const page = await getPage(`https://www.rottentomatoes.com/m/${slugs.rt_slug}`);
      const p = page ? parseRt(page.html) : { critics: EMPTY, audience: EMPTY };
      storeScore(db, tconst, "rt_critics", p.critics);
      storeScore(db, tconst, "rt_audience", p.audience);
      return "stored";
    }
    case "mc": {
      if (!slugs?.mc_slug) return "skipped";
      const page = await getPage(`https://www.metacritic.com/movie/${slugs.mc_slug}/`);
      const p = page ? parseMc(page.html) : { critics: EMPTY, user: EMPTY };
      storeScore(db, tconst, "mc_critics", p.critics);
      storeScore(db, tconst, "mc_user", p.user);
      return "stored";
    }
    case "tmdb": {
      const bearer = tmdbKey!.startsWith("eyJ"); // v4 read access token vs v3 api key
      const url = `https://api.themoviedb.org/3/find/${tconst}?external_source=imdb_id${bearer ? "" : `&api_key=${encodeURIComponent(tmdbKey!)}`}`;
      let res: Response;
      try { res = await politeFetch(url, { headers: { Accept: "application/json", ...(bearer ? { Authorization: `Bearer ${tmdbKey}` } : {}) } }, 50); }
      catch (e) { throw new Transient(`TMDB ${tconst}: ${e instanceof Error ? e.message : e}`); }
      if (res.status === 401) throw new Error("TMDB rejected TMDB_API_KEY (401): check the key in .env");
      if (!res.ok) throw new Transient(`TMDB ${tconst} -> ${res.status}`);
      const p = parseTmdbFind(await res.json());
      storeScore(db, tconst, "tmdb", p.rating);
      if (p.tmdbId) mergeIds(db, tconst, { tmdbId: p.tmdbId }, "tmdb");
      return "stored";
    }
  }
}

export interface SourceResult { checked: number; cached: number; noSlug: number; fetched: number; found: number; failed: number; aborted?: string }
export interface RatingsSyncOptions { sources: Source[]; airline?: string; limit?: number; tmdbKey?: string; log?: (s: string) => void; now?: Date }

/**
 * Fetch ratings for matched films in each airline's latest month. Rows younger than 30 days are reused (a NULL value
 * means "looked, nothing there" and is cached too). Transient failures are logged, not stored; three in a row stop that
 * source for this run. RT and Metacritic only run where Wikidata gave a slug (run `ids sync` first).
 */
export async function syncRatings(db: Database, o: RatingsSyncOptions): Promise<Partial<Record<Source, SourceResult>>> {
  let tconsts = rankedTconsts(db, o.airline);
  if (o.limit !== undefined) tconsts = tconsts.slice(0, o.limit);
  const cutoff = new Date((o.now ?? new Date()).getTime() - CACHE_DAYS * 86_400_000).toISOString();
  const fresh = db.query<{ n: number }, [string, string, string]>("SELECT 1 AS n FROM ratings WHERE tconst = ? AND source = ? AND fetched_at >= ?");
  const slugQ = db.query<Slugs, [string]>("SELECT rt_slug, mc_slug FROM external_ids WHERE tconst = ?");
  const valueQ = db.query<{ value: number | null }, [string, string]>("SELECT value FROM ratings WHERE tconst = ? AND source = ?");
  const out: Partial<Record<Source, SourceResult>> = {};
  for (const source of o.sources) {
    const r: SourceResult = { checked: tconsts.length, cached: 0, noSlug: 0, fetched: 0, found: 0, failed: 0 };
    out[source] = r;
    if (source === "tmdb" && !o.tmdbKey) {
      r.aborted = "TMDB_API_KEY not set: add it to .env (free key: themoviedb.org > Settings > API); skipping TMDB";
      o.log?.(r.aborted);
      continue;
    }
    let streak = 0;
    for (const [i, t] of tconsts.entries()) {
      const key = KEYS[source][KEYS[source].length - 1]!;
      if (fresh.get(t, key, cutoff)) { r.cached++; continue; }
      try {
        if ((await fetchOne(db, source, t, slugQ.get(t), o.tmdbKey)) === "skipped") { r.noSlug++; continue; }
        r.fetched++;
        streak = 0;
        if (KEYS[source].some((k) => valueQ.get(t, k)?.value != null)) r.found++;
      } catch (e) {
        if (!(e instanceof Transient)) throw e;
        r.failed++;
        o.log?.(`${source} ${t}: ${e.message}`);
        if (++streak >= 3) { r.aborted = `stopped after 3 failures in a row (${e.message})`; o.log?.(`${source}: ${r.aborted}`); break; }
      }
      if ((i + 1) % 50 === 0) o.log?.(`${source}: ${i + 1}/${tconsts.length}`);
    }
  }
  return out;
}
