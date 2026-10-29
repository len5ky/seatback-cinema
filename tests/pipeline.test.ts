import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { openDb, storeFilms } from "../src/db.ts";
import { matchAll, pickMatch, type Candidate } from "../src/match.ts";
import { exportAll, type ExportFile, type IndexFile } from "../src/export.ts";
import type { CatalogueFilm } from "../src/airlines/types.ts";

const film = (o: Partial<CatalogueFilm> & { sourceId: string; title: string }): CatalogueFilm => ({
  directors: [], cast: ["Someone Famous"], genres: [], languages: ["English"], subtitles: [], categories: ["New"],
  synopsis: "secret synopsis", poster: "https://example.invalid/p.jpg", ...o,
});
const cand = (tconst: string, startYear: number, runtime: number | null, directors: string[], votes = 1000): Candidate =>
  ({ tconst, primaryTitle: "X", startYear, runtime, votes, directorNames: directors });

function seeded() {
  const db = openDb(":memory:");
  db.run("INSERT INTO imdb_titles VALUES ('tt0034583','movie','Casablanca',NULL,1942,102,'Drama',8.5,600000,'nm1'), ('tt7','movie','Casablanca',NULL,1955,60,'Drama',6,50,'nm2'), ('tt9','movie','Unrelated',NULL,2001,90,'Drama',7,500,NULL)");
  db.run("INSERT INTO imdb_names VALUES ('nm1','Michael Curtiz'), ('nm2','Someone Else')");
  db.run("INSERT INTO imdb_keys VALUES ('casablanca','tt0034583'), ('casablanca','tt7'), ('unrelated','tt9')");
  return db;
}

test("year is a strong signal: it alone gives medium, with director high, a mismatch blocks high", () => {
  const cands = [cand("tt1", 2019, 95, ["A Person"]), cand("tt2", 2024, 140, ["B Person"])];
  expect(pickMatch({ cleanTitle: "Drive", year: 2024, duration: null, director: null }, cands, 2026)).toMatchObject({ tconst: "tt2", confidence: "medium" });
  expect(pickMatch({ cleanTitle: "Drive", year: 2024, duration: null, director: "B Person" }, cands, 2026)).toMatchObject({ tconst: "tt2", confidence: "high" });
  expect(pickMatch({ cleanTitle: "Drive", year: 2010, duration: 140, director: "B Person" }, [cands[1]!], 2026).confidence).not.toBe("high");
});

test("matchAll: airline-provided IMDb id is trusted when IMDb knows it; otherwise the matcher runs", () => {
  const db = seeded();
  storeFilms(db, { id: "american", name: "American" }, "2026-10", [
    film({ sourceId: "a1", title: "Totally Different Title", imdbId: "tt9" }),
    film({ sourceId: "a2", title: "Casablanca", year: 1942, imdbId: "tt0000404" }),
  ], "x");
  storeFilms(db, { id: "ba", name: "British Airways" }, "2026-10", [film({ sourceId: "b1", title: "Casablanca", year: 1942, directors: ["Michael Curtiz"] })], "x");
  // a2's id is unknown to IMDb, so the matcher runs: title + year alone is medium
  expect(matchAll(db, "american")).toEqual({ high: 1, medium: 1, low: 0, none: 0 });
  const rows = db.query<{ airline: string; source_id: string; tconst: string; reasons: string }, []>("SELECT airline, source_id, tconst, reasons FROM matches ORDER BY source_id").all();
  expect(rows.map((r) => [r.source_id, r.tconst])).toEqual([["a1", "tt9"], ["a2", "tt0034583"]]);
  expect(rows[0]!.reasons).toBe("airline-provided IMDb id");
  expect(matchAll(db)).toEqual({ high: 2, medium: 1, low: 0, none: 0 }); // all airlines
});

test("export writes catalogue facts and ids only, plus an index", () => {
  const db = seeded();
  storeFilms(db, { id: "ba", name: "British Airways" }, "2026-10", [
    film({ sourceId: "b1", title: "Casablanca", year: 1942, runtime: 102, directors: ["Michael Curtiz"], genres: ["Drama"], rating: "PG", categories: ["Classics", "Drama"] }),
    film({ sourceId: "b2", title: "Nothing Like It" }),
  ], "x", "2026-10-29T10:00:00.000Z");
  storeFilms(db, { id: "ba", name: "British Airways" }, "2026-11", [film({ sourceId: "b1", title: "Casablanca", year: 1942, directors: ["Michael Curtiz"] })], "x");
  matchAll(db);
  const dir = mkdtempSync(`${import.meta.dir}/../tmp/export-test-`);
  const r = exportAll(db, { dir, month: "2026-10" });
  expect(r.files.map((f) => f.path)).toEqual([`${dir}/ba/2026-10.json`]);
  const data = JSON.parse(readFileSync(`${dir}/ba/2026-10.json`, "utf8")) as ExportFile;
  expect(data).toMatchObject({ airline: "ba", name: "British Airways", month: "2026-10", fetchedAt: "2026-10-29T10:00:00.000Z", count: 2 });
  const c = data.films.find((f) => f.sourceId === "b1")!;
  expect(c).toEqual({
    sourceId: "b1", title: "Casablanca", year: 1942, runtime: 102, directors: ["Michael Curtiz"], genres: ["Drama"], rating: "PG",
    languages: ["English"], categories: ["Classics", "Drama"], imdbId: "tt0034583", imdbConfidence: "high", tmdbId: null, versions: 1,
  });
  const text = readFileSync(`${dir}/ba/2026-10.json`, "utf8");
  for (const leaked of ["secret synopsis", "example.invalid", "Someone Famous"]) expect(text).not.toContain(leaked);
  expect(data.films.find((f) => f.sourceId === "b2")).toMatchObject({ imdbId: null, imdbConfidence: "none" });
  // November was not exported, so the index lists only files on disk
  expect(existsSync(`${dir}/ba/2026-11.json`)).toBe(false);
  const index = JSON.parse(readFileSync(`${dir}/index.json`, "utf8")) as IndexFile;
  expect(index.airlines).toEqual([{ id: "ba", name: "British Airways", months: [{ month: "2026-10", count: 2, fetchedAt: "2026-10-29T10:00:00.000Z", path: "ba/2026-10.json" }] }]);
});

test("export folds repeated rows into one film with a versions count and fills tmdbId from external_ids", () => {
  const db = seeded();
  db.run("INSERT INTO external_ids (tconst, tmdb_id, source, fetched_at) VALUES ('tt0034583', 289, 'wikidata', 'x')");
  storeFilms(db, { id: "ek", name: "Emirates" }, "2026-10", [
    film({ sourceId: "e1", title: "Casablanca", year: 1942, directors: ["Michael Curtiz"], categories: ["Classics"], languages: ["English"] }),
    film({ sourceId: "e2", title: "Casablanca", year: 1942, directors: ["Michael Curtiz"], categories: ["Latest"], languages: ["French"] }),
    film({ sourceId: "e3", title: "Home-Made Film", year: 2020 }),
    film({ sourceId: "e4", title: "Home Made Film", year: 2020 }),
    film({ sourceId: "e5", title: "Home Made Film", year: 2021 }),
  ], "x");
  matchAll(db);
  const dir = mkdtempSync(`${import.meta.dir}/../tmp/export-test-`);
  exportAll(db, { dir });
  const data = JSON.parse(readFileSync(`${dir}/ek/2026-10.json`, "utf8")) as ExportFile;
  expect(data.count).toBe(3);
  expect(data.films.find((f) => f.imdbId === "tt0034583")).toMatchObject({
    sourceId: "e1", versions: 2, tmdbId: 289, categories: ["Classics", "Latest"], languages: ["English", "French"],
  });
  expect(data.films.filter((f) => !f.imdbId).map((f) => [f.year, f.versions])).toEqual([[2020, 2], [2021, 1]]);
  const index = JSON.parse(readFileSync(`${dir}/index.json`, "utf8")) as IndexFile;
  expect(index.airlines[0]!.months[0]!.count).toBe(3);
});
