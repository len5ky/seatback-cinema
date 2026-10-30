import { expect, test } from "bun:test";
import { detectImdbExport, importImdbExport, isFilmType, parseImdbExport } from "../src/ratings/imdb-export.ts";
import { openDb } from "../src/db.ts";
import { loadTasteModel } from "../src/rank.ts";

const fx = (n: string) => Bun.file(`${import.meta.dir}/fixtures/ratings/${n}`).text();
const ratingsCsv = await fx("imdb-ratings.csv");
const watchlistCsv = await fx("imdb-watchlist.csv");

test("detects IMDb exports by header; Letterboxd and other CSVs are not IMDb", async () => {
  const raw = new Uint8Array(await Bun.file(`${import.meta.dir}/fixtures/ratings/imdb-ratings.csv`).arrayBuffer());
  expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // Bun.file().text() drops the BOM, so test with it kept too
  expect(detectImdbExport(new TextDecoder("utf-8", { ignoreBOM: true }).decode(raw))).toBe("ratings");
  expect(parseImdbExport(new TextDecoder("utf-8", { ignoreBOM: true }).decode(raw)).films[0]?.tconst).toBe("tt0111161");
  expect(detectImdbExport(ratingsCsv)).toBe("ratings");
  expect(detectImdbExport(watchlistCsv)).toBe("watchlist");
  expect(detectImdbExport('"Const","Your Rating","Title"\n"tt1","7","x"\n')).toBe("ratings");
  expect(detectImdbExport("Date,Name,Year,Letterboxd URI,Rating\n2024-01-01,Arrival,2016,https://boxd.it/x,4.5\n")).toBeNull();
  expect(() => parseImdbExport("Name,Year\nArrival,2016\n")).toThrow(/IMDb/);
});

test("parses ratings: BOM, quoted title with a comma, 1-10 kept as-is", () => {
  const { kind, films, skipped } = parseImdbExport(ratingsCsv);
  expect([kind, films.length, skipped]).toEqual(["ratings", 15, 0]);
  expect(films[0]).toEqual({ tconst: "tt0111161", title: "The Shawshank Redemption", year: 1994, titleType: "Movie", rating: 10, genres: ["Drama"], directors: ["Frank Darabont"] });
  expect(films.find((f) => f.tconst === "tt0190332")).toMatchObject({ title: "Crouching Tiger, Hidden Dragon", year: 2000, rating: 8 });
  expect(films.find((f) => f.tconst === "tt0332280")?.rating).toBe(3);
  expect(films.filter((f) => !isFilmType(f.titleType)).map((f) => f.tconst)).toEqual(["tt0903747", "tt2301451", "tt0108778"]);
  expect(["Movie", "TV Movie", "tvMovie", "Video", "TV Special", "tvSpecial"].every(isFilmType)).toBe(true);
});

test("parses watchlist: no ratings, junk Const rows skipped", () => {
  const w = parseImdbExport(watchlistCsv);
  expect([w.kind, w.films.length, w.skipped]).toEqual(["watchlist", 5, 0]);
  expect(w.films.every((f) => f.rating === null)).toBe(true);
  expect(parseImdbExport(`${watchlistCsv}"6","nm0000001","","","","Bad row","","","Movie","","","","","","",""\n`).skipped).toBe(1);
});

test("joins on Const = tconst; summary counts; re-import replaces only its own kind", () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO imdb_titles VALUES ('tt2543164', 'movie', 'Arrival', NULL, 2016, 116, 'Drama,Mystery,Sci-Fi', 7.9, 800000, 'nm0898288')");
  db.run("INSERT INTO imdb_titles VALUES ('tt6751668', 'movie', 'Parasite', NULL, 2019, 132, 'Drama,Thriller', 8.5, 1000000, 'nm0094435')");
  const r = importImdbExport(db, parseImdbExport(ratingsCsv), "2026-10-29");
  expect(r).toEqual({ kind: "ratings", films: 15, rated: 15, watchlist: 0, otherTypes: 3, skipped: 0, inImdb: 2 });
  const w = importImdbExport(db, parseImdbExport(watchlistCsv), "2026-10-29");
  expect(w).toEqual({ kind: "watchlist", films: 5, rated: 0, watchlist: 5, otherTypes: 1, skipped: 0, inImdb: 1 });

  const row = (tconst: string, source: string) => db.query<{ rating: number | null; watched: number; watchlist: number }, [string, string]>(
    "SELECT rating, watched, watchlist FROM user_films WHERE tconst = ? AND source = ?").get(tconst, source);
  expect(row("tt0190332", "imdb_ratings")).toEqual({ rating: 8, watched: 1, watchlist: 0 });
  expect(row("tt15239678", "imdb_watchlist")).toEqual({ rating: null, watched: 0, watchlist: 1 });

  importImdbExport(db, parseImdbExport(ratingsCsv));
  const count = (source: string) => db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM user_films WHERE source = ?").get(source)?.n;
  expect([count("imdb_ratings"), count("imdb_watchlist")]).toEqual([15, 5]);

  const model = loadTasteModel(db);
  expect(model?.rated).toBe(15); // Arrival is rated and on the watchlist: one rating, not two
  expect(model?.watched.has("tt2543164")).toBe(true);
  expect(model?.watchlist.has("tt15239678")).toBe(true);
  expect(model?.watched.has("tt15239678")).toBe(false);
});
