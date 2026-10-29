import { afterEach, expect, test } from "bun:test";
import { jsonLd, parseLetterboxd, parseMc, parseRt, parseTmdbFind } from "../src/ratings/sources.ts";
import { syncRatings } from "../src/ratings/sync.ts";
import { openDb } from "../src/db.ts";

const NEW_FILM = '<script type="application/ld+json">{"@type":"Movie","name":"X"}</script>';
const CHALLENGE = "<html><title>Just a moment...</title></html>";
const fx = (n: string) => Bun.file(`${import.meta.dir}/fixtures/ratings/${n}`);

test("Letterboxd film page: JSON-LD inside CDATA, slug, TMDB id", async () => {
  const p = parseLetterboxd(await fx("letterboxd-shawshank.html").text());
  expect(p).toEqual({ rating: { value: 4.6, votes: 3211559, extra: { reviews: 359097 } }, slug: "the-shawshank-redemption", tmdbId: 278, recognised: true });
  expect(parseLetterboxd(NEW_FILM, "https://letterboxd.com/film/x/")).toEqual({ rating: { value: null, votes: null, extra: undefined }, slug: "x", tmdbId: null, recognised: true });
  expect(parseLetterboxd(CHALLENGE, "https://letterboxd.com/imdb/tt1/").recognised).toBe(false);
});

test("Rotten Tomatoes scorecard JSON", async () => {
  const p = parseRt(await fx("rt-shawshank.html").text());
  expect(p.critics).toEqual({ value: 89, votes: 147, extra: { certified: true, average: 8.4 } });
  expect(p.audience.value).toBe(98);
  expect(p.audience.votes).toBe(53485);
  expect(p.recognised).toBe(true);
  expect(parseRt("<html></html>")).toMatchObject({ audience: { value: null }, recognised: false });
});

test("Metacritic: Metascore from JSON-LD, user score from the badge", async () => {
  const p = parseMc(await fx("mc-shawshank.html").text());
  expect(p.critics).toEqual({ value: 82, votes: 22 });
  expect(p.user).toEqual({ value: 9.2, votes: 2256 });
  expect(p.recognised).toBe(true);
  expect(parseMc(CHALLENGE).recognised).toBe(false);
  expect(parseMc('<div aria-label="User score tbd out of 10" data-testid="global-score-value-wrapper"></div>').user.value).toBeNull();
});

test("TMDB find", async () => {
  expect(parseTmdbFind(await fx("tmdb-find-shawshank.json").json())).toEqual({ tmdbId: 278, rating: { value: 8.711, votes: 28563 } });
  expect(parseTmdbFind({ movie_results: [{ id: 5, vote_average: 0, vote_count: 0 }] }).rating.value).toBeNull();
  expect(parseTmdbFind({ movie_results: [] }).tmdbId).toBeNull();
});

test("jsonLd skips broken blocks", () => {
  expect(jsonLd('<script type="application/ld+json">{oops</script><script type="application/ld+json">{"a":1}</script>')).toEqual([{ a: 1 }]);
});

// --- sync, with fetch stubbed ---
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function stub(handler: (url: string) => Response) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => { const u = String(input); calls.push(u); return handler(u); }) as typeof fetch;
  return calls;
}
function dbWith(tconsts: string[]) {
  const db = openDb(":memory:");
  db.run("INSERT INTO snapshots VALUES ('ek','2026-10','x','d',1)");
  for (const t of tconsts) {
    db.run("INSERT INTO movies (airline, month, source_id, title) VALUES ('ek','2026-10',?,?)", [t, t]);
    db.run("INSERT INTO matches VALUES ('ek',?,?,'high',1,'','x')", [t, t]);
  }
  return db;
}

test("TMDB sync stores ratings, fills tmdb ids, then serves from cache; no key -> clear skip", async () => {
  const db = dbWith(["tt0111161", "tt0000002"]);
  const body = await fx("tmdb-find-shawshank.json").text();
  const calls = stub((u) => (u.includes("tt0111161") ? new Response(body) : new Response('{"movie_results":[]}')));
  const r = await syncRatings(db, { sources: ["tmdb"], tmdbKey: "abc" });
  expect(r.tmdb).toMatchObject({ checked: 2, fetched: 2, found: 1, failed: 0 });
  expect(calls[0]).toContain("/3/find/tt0000002?external_source=imdb_id&api_key=abc");
  expect(db.query("SELECT tmdb_id, source FROM external_ids").all()).toEqual([{ tmdb_id: 278, source: "tmdb" }]);
  expect((await syncRatings(db, { sources: ["tmdb"], tmdbKey: "abc" })).tmdb).toMatchObject({ cached: 2, fetched: 0 });
  expect((await syncRatings(db, { sources: ["tmdb"] })).tmdb?.aborted).toMatch(/TMDB_API_KEY not set/);
});

test("Letterboxd 404 is cached as null; RT/MC skip films without a slug; 3 transient failures stop a source", async () => {
  const db = dbWith(["tt1", "tt2", "tt3", "tt4"]);
  stub(() => new Response("gone", { status: 404 }));
  const lb = await syncRatings(db, { sources: ["letterboxd", "rt"], limit: 1 });
  expect(lb.letterboxd).toMatchObject({ checked: 1, fetched: 1, found: 0 });
  expect(lb.rt).toMatchObject({ noSlug: 1, fetched: 0 });
  expect(db.query("SELECT tconst, source, value FROM ratings").all()).toEqual([{ tconst: "tt1", source: "letterboxd", value: null }]);
  db.run("INSERT INTO external_ids VALUES ('tt1',NULL,NULL,NULL,'a','wikidata','x'), ('tt2',NULL,NULL,NULL,'b','wikidata','x'), ('tt3',NULL,NULL,NULL,'c','wikidata','x'), ('tt4',NULL,NULL,NULL,'d','wikidata','x')");
  stub(() => new Response("slow down", { status: 429 }));
  const mc = await syncRatings(db, { sources: ["mc"] });
  expect(mc.mc).toMatchObject({ failed: 3, fetched: 0 });
  expect(mc.mc?.aborted).toMatch(/3 failures in a row/);
  expect(db.query("SELECT COUNT(*) AS n FROM ratings WHERE source LIKE 'mc%'").get()).toEqual({ n: 0 });
}, 15_000);

test("a 200 challenge page is retried, not cached; a film page with no score is cached as null", async () => {
  const db = dbWith(["tt1", "tt2"]);
  db.run("INSERT INTO external_ids VALUES ('tt1',NULL,NULL,'r1','m1','wikidata','x'), ('tt2',NULL,NULL,'r2','m2','wikidata','x')");
  stub(() => new Response(CHALLENGE));
  const r = await syncRatings(db, { sources: ["letterboxd", "rt", "mc"] });
  for (const s of ["letterboxd", "rt", "mc"] as const) expect(r[s]).toMatchObject({ failed: 2, fetched: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM ratings").get()).toEqual({ n: 0 });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const res = new Response(NEW_FILM);
    Object.defineProperty(res, "url", { value: String(input).replace("/imdb/", "/film/") });
    return res;
  }) as typeof fetch;
  const ok = await syncRatings(db, { sources: ["letterboxd", "mc"] });
  expect(ok.letterboxd).toMatchObject({ fetched: 2, found: 0, failed: 0 });
  expect(ok.mc).toMatchObject({ fetched: 2, found: 0, failed: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM ratings WHERE value IS NULL").get()).toEqual({ n: 6 });
}, 30_000);
