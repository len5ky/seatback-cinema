import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import type { IdsFile } from "../export.ts";
import { BOT_UA, politeFetch } from "./http.ts";

export interface ExternalIds { tconst: string; tmdbId: number | null; letterboxdSlug: string | null; rtSlug: string | null; mcSlug: string | null }
interface Binding { value: string }
export interface SparqlResponse { results: { bindings: Record<string, Binding | undefined>[] } }

const SPARQL_URL = "https://query.wikidata.org/sparql";
export const WIKIDATA_BATCH = 200;

/** P345 IMDb -> P4947 TMDB movie, P6127 Letterboxd film, P1258 Rotten Tomatoes, P1712 Metacritic. */
export function sparqlQuery(tconsts: string[]): string {
  return `SELECT ?imdb ?t ?l ?r ?m WHERE {
  VALUES ?imdb { ${tconsts.map((t) => `"${t}"`).join(" ")} }
  ?item wdt:P345 ?imdb .
  OPTIONAL { ?item wdt:P4947 ?t } OPTIONAL { ?item wdt:P6127 ?l } OPTIONAL { ?item wdt:P1258 ?r } OPTIONAL { ?item wdt:P1712 ?m }
}`;
}

/** Pure: one row per tconst Wikidata knows; first value wins when an item has several. RT/MC ids keep only film paths. */
export function parseSparql(res: SparqlResponse): ExternalIds[] {
  const byId = new Map<string, ExternalIds>();
  for (const b of res.results.bindings) {
    const tconst = b.imdb?.value;
    if (!tconst || !/^tt\d+$/.test(tconst)) continue;
    const e = byId.get(tconst) ?? { tconst, tmdbId: null, letterboxdSlug: null, rtSlug: null, mcSlug: null };
    const tmdb = Number(b.t?.value);
    e.tmdbId ??= Number.isInteger(tmdb) && tmdb > 0 ? tmdb : null;
    e.letterboxdSlug ??= b.l?.value || null;
    e.rtSlug ??= b.r?.value.match(/^m\/(.+)$/)?.[1] ?? null; // "m/moon"; "tv/..." is not a film
    e.mcSlug ??= b.m?.value.match(/^movie\/(.+)$/)?.[1] ?? null; // "movie/moon"
    byId.set(tconst, e);
  }
  return [...byId.values()];
}

async function querySparql(tconsts: string[]): Promise<SparqlResponse> {
  const res = await politeFetch(SPARQL_URL, {
    method: "POST",
    headers: { "User-Agent": BOT_UA, Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ query: sparqlQuery(tconsts) }),
  });
  if (!res.ok) throw new Error(`Wikidata SPARQL -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as SparqlResponse;
}

/** Store ids for a queried batch; tconsts Wikidata does not know get an all-null 'none' row so they are not re-queried. */
export function storeIds(db: Database, queried: string[], found: ExternalIds[], now = new Date().toISOString()): void {
  const ins = db.prepare("INSERT OR REPLACE INTO external_ids VALUES (?,?,?,?,?,?,?)");
  const known = new Map(found.map((e) => [e.tconst, e]));
  db.transaction(() => {
    for (const t of queried) {
      const e = known.get(t);
      ins.run(t, e?.tmdbId ?? null, e?.letterboxdSlug ?? null, e?.rtSlug ?? null, e?.mcSlug ?? null, e ? "wikidata" : "none", now);
    }
  })();
}

/** Fill ids learned elsewhere (Letterboxd page, TMDB find) without overwriting what is already known. */
export function mergeIds(db: Database, tconst: string, ids: { tmdbId?: number | null; letterboxdSlug?: string | null }, source: string): void {
  db.run(`INSERT INTO external_ids (tconst, tmdb_id, letterboxd_slug, source, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (tconst) DO UPDATE SET tmdb_id = COALESCE(tmdb_id, ?2), letterboxd_slug = COALESCE(letterboxd_slug, ?3),
      source = CASE WHEN source = 'none' AND (?2 IS NOT NULL OR ?3 IS NOT NULL) THEN ?4 ELSE source END`,
    [tconst, ids.tmdbId ?? null, ids.letterboxdSlug ?? null, source, new Date().toISOString()]);
}

/** Matched (high/medium) tconsts in each airline's latest month, optionally one airline. */
export function rankedTconsts(db: Database, airline?: string): string[] {
  return db.query<{ tconst: string }, [string | null, string | null]>(`
    SELECT DISTINCT x.tconst FROM movies m
    JOIN (SELECT airline, MAX(month) AS month FROM snapshots GROUP BY airline) s ON s.airline = m.airline AND s.month = m.month
    JOIN matches x ON x.airline = m.airline AND x.source_id = m.source_id
    WHERE x.confidence IN ('high','medium') AND x.tconst IS NOT NULL AND (? IS NULL OR m.airline = ?)
    ORDER BY x.tconst`).all(airline ?? null, airline ?? null).map((r) => r.tconst);
}

/** Seed external_ids from a published ids.json (see writeIdsFile) without touching existing rows. Returns rows added. */
export function seedIds(db: Database, path: string, now = new Date().toISOString()): number {
  if (!existsSync(path)) return 0;
  const ids = JSON.parse(readFileSync(path, "utf8")) as IdsFile;
  const ins = db.prepare("INSERT OR IGNORE INTO external_ids VALUES (?,?,?,?,?,'wikidata',?)");
  let added = 0;
  db.transaction(() => {
    for (const [t, e] of Object.entries(ids)) {
      if (!/^tt\d+$/.test(t)) continue;
      added += ins.run(t, e.tmdb ?? null, e.letterboxd ?? null, e.rt ?? null, e.mc ?? null, now).changes;
    }
  })();
  return added;
}

export interface IdsSyncResult { seeded: number; queried: number; known: number; batches: number; failedBatches: number }

/** Seed from `seedFile` if given, then query Wikidata for tconsts that still have no external_ids row, 200 per POST, 1 req/s. */
export async function syncIds(db: Database, o: { airline?: string; limit?: number; seedFile?: string; log?: (s: string) => void } = {}): Promise<IdsSyncResult> {
  const seeded = o.seedFile ? seedIds(db, o.seedFile) : 0;
  if (seeded) o.log?.(`seeded ${seeded} ids from ${o.seedFile}`);
  const has = db.query<{ n: number }, [string]>("SELECT 1 AS n FROM external_ids WHERE tconst = ?");
  let todo = rankedTconsts(db, o.airline).filter((t) => !has.get(t));
  if (o.limit !== undefined) todo = todo.slice(0, o.limit);
  const r: IdsSyncResult = { seeded, queried: 0, known: 0, batches: 0, failedBatches: 0 };
  for (let i = 0; i < todo.length; i += WIKIDATA_BATCH) {
    const batch = todo.slice(i, i + WIKIDATA_BATCH);
    r.batches++;
    try {
      const found = parseSparql(await querySparql(batch));
      storeIds(db, batch, found);
      r.queried += batch.length;
      r.known += found.length;
      o.log?.(`wikidata batch ${r.batches}: ${found.length}/${batch.length} known`);
    } catch (e) {
      r.failedBatches++;
      o.log?.(`wikidata batch ${r.batches} FAILED (left for the next run): ${e instanceof Error ? e.message : e}`);
    }
  }
  return r;
}
