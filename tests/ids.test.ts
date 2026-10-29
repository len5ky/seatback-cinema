import { expect, test } from "bun:test";
import { mergeIds, parseSparql, rankedTconsts, sparqlQuery, storeIds, type SparqlResponse } from "../src/ratings/ids.ts";
import { openDb } from "../src/db.ts";

const saved = (await Bun.file(`${import.meta.dir}/fixtures/ratings/wikidata-sparql.json`).json()) as SparqlResponse;

test("parses a saved Wikidata SPARQL response (200 sampled tconsts)", () => {
  const ids = parseSparql(saved);
  expect(ids.length).toBe(162);
  expect(ids.filter((e) => e.tmdbId).length).toBe(159);
  expect(ids.filter((e) => e.letterboxdSlug).length).toBe(153);
  expect(ids.filter((e) => e.rtSlug).length).toBe(126);
  expect(ids.filter((e) => e.mcSlug).length).toBe(100);
  expect(ids.find((e) => e.tconst === "tt1182345")).toEqual({ tconst: "tt1182345", tmdbId: 17431, letterboxdSlug: "moon", rtSlug: "moon", mcSlug: "moon" });
  expect(ids.find((e) => e.tconst === "tt0047396")?.rtSlug).toBe("1017289-rear_window");
});

test("first value wins; tv paths are dropped", () => {
  const b = (imdb: string, r?: string, t?: string) => ({ imdb: { value: imdb }, ...(r ? { r: { value: r } } : {}), ...(t ? { t: { value: t } } : {}) });
  const ids = parseSparql({ results: { bindings: [b("tt1", "tv/show"), b("tt2", "m/a", "5"), b("tt2", "m/b", "6"), b("nope", "m/x")] } });
  expect(ids).toEqual([
    { tconst: "tt1", tmdbId: null, letterboxdSlug: null, rtSlug: null, mcSlug: null },
    { tconst: "tt2", tmdbId: 5, letterboxdSlug: null, rtSlug: "a", mcSlug: null },
  ]);
});

test("query lists every tconst once", () => {
  expect(sparqlQuery(["tt1", "tt2"])).toContain('VALUES ?imdb { "tt1" "tt2" }');
});

test("misses get a 'none' row; later merges fill gaps without overwriting", () => {
  const db = openDb(":memory:");
  storeIds(db, ["tt1182345", "tt9"], parseSparql(saved).filter((e) => e.tconst === "tt1182345"), "2026-10-29");
  mergeIds(db, "tt9", { tmdbId: 42, letterboxdSlug: "nine" }, "letterboxd");
  mergeIds(db, "tt1182345", { tmdbId: 1, letterboxdSlug: "other" }, "letterboxd");
  const rows = db.query("SELECT tconst, tmdb_id, letterboxd_slug, source FROM external_ids ORDER BY tconst").all();
  expect(rows).toEqual([
    { tconst: "tt1182345", tmdb_id: 17431, letterboxd_slug: "moon", source: "wikidata" },
    { tconst: "tt9", tmdb_id: 42, letterboxd_slug: "nine", source: "letterboxd" },
  ]);
});

test("ranked tconsts: high/medium in each airline's latest month", () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO snapshots VALUES ('ek','2026-09','x','d',1), ('ek','2026-10','x','d',2)");
  db.run("INSERT INTO movies (airline, month, source_id, title) VALUES ('ek','2026-09','old','Old'), ('ek','2026-10','a','A'), ('ek','2026-10','b','B')");
  db.run("INSERT INTO matches VALUES ('ek','old','tt3','high',1,'','x'), ('ek','a','tt1','medium',1,'','x'), ('ek','b','tt2','low',1,'','x')");
  expect(rankedTconsts(db)).toEqual(["tt1"]);
});
