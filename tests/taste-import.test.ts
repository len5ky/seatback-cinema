import { expect, test } from "bun:test";
import { importExport, matchUserFilm, parseCsv, parseExport, readZip } from "../src/ratings/letterboxd-export.ts";
import { openDb } from "../src/db.ts";
import { normalizeTitle } from "../src/text.ts";

const zip = readZip(new Uint8Array(await Bun.file(`${import.meta.dir}/fixtures/ratings/letterboxd-export.zip`).arrayBuffer()));

test("reads every csv in the export zip", () => {
  expect([...zip.keys()].sort()).toEqual(["diary.csv", "profile.csv", "ratings.csv", "watched.csv", "watchlist.csv"]);
});

test("csv: quoted commas, doubled quotes, CRLF, BOM", () => {
  expect(parseCsv('﻿Name,Year\r\n"Crouching Tiger, Hidden Dragon",2000\r\n"The ""Best"" Film",1999\r\n')).toEqual([
    { Name: "Crouching Tiger, Hidden Dragon", Year: "2000" },
    { Name: 'The "Best" Film', Year: "1999" },
  ]);
});

test("merges ratings, watched and watchlist by name and year", () => {
  const films = parseExport(zip);
  expect(films.length).toBe(20);
  expect(films.filter((f) => f.rating !== null).length).toBe(10);
  expect(films.filter((f) => f.watched).length).toBe(15);
  expect(films.filter((f) => f.watchlist).length).toBe(5);
  expect(films.find((f) => f.name === "Parasite")).toMatchObject({ year: 2019, rating: 10, watched: true, watchlist: false });
  expect(films.find((f) => f.name === "The Notebook")?.rating).toBe(3);
  expect(films.find((f) => f.name === "Crouching Tiger, Hidden Dragon")?.year).toBe(2000);
  expect(() => parseExport(new Map([["profile.csv", "Username\nx\n"]]))).toThrow(/Letterboxd export/);
});

test("matches name+year against IMDb; year picks the right remake; unknown films stay unmatched", () => {
  const db = openDb(":memory:");
  const title = (tconst: string, name: string, year: number, votes: number) => {
    db.run("INSERT INTO imdb_titles VALUES (?, 'movie', ?, NULL, ?, 120, 'Drama', 7.5, ?, NULL)", [tconst, name, year, votes]);
    db.run("INSERT INTO imdb_keys VALUES (?, ?)", [normalizeTitle(name), tconst]);
  };
  title("tt2543164", "Arrival", 2016, 800000);
  title("tt1160419", "Dune", 2021, 900000);
  title("tt0087182", "Dune", 1984, 200000);
  title("tt6751668", "Parasite", 2019, 1000000);
  title("tt27503384", "Perfect Days", 2023, 60000);
  const r = importExport(db, parseExport(zip), "2026-10-29");
  expect(r.matched.high + r.matched.medium).toBe(4);
  expect(r.unmatched.length).toBe(16);
  const rows = db.query<{ tconst: string; rating: number | null; watched: number; watchlist: number }, []>(
    "SELECT tconst, rating, watched, watchlist FROM user_films WHERE tconst IS NOT NULL ORDER BY tconst").all();
  expect(rows).toEqual([
    { tconst: "tt1160419", rating: 8, watched: 1, watchlist: 0 },
    { tconst: "tt2543164", rating: 9, watched: 1, watchlist: 0 },
    { tconst: "tt27503384", rating: null, watched: 0, watchlist: 1 },
    { tconst: "tt6751668", rating: 10, watched: 1, watchlist: 0 },
  ]);
  importExport(db, parseExport(zip)); // re-import replaces, never duplicates
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM user_films").get()?.n).toBe(20);
});

test("same-year namesakes: the far more voted film wins", () => {
  const c = (tconst: string, votes: number, startYear = 2022) => ({ tconst, primaryTitle: "Aftersun", startYear, runtime: null, votes, directorNames: [] });
  const m = matchUserFilm("Aftersun", 2022, [c("tt0825223", 194, 2006), c("tt19512922", 43), c("tt19770238", 134441)], false);
  expect([m.tconst, m.confidence]).toEqual(["tt19770238", "medium"]);
  expect(matchUserFilm("Aftersun", 2022, [c("a", 900), c("b", 1000)], false).confidence).toBe("low");
});
