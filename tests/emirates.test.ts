import { expect, test } from "bun:test";
import { cleanTitle, parseCategories, parseMovies, sourceDate, storeSnapshot, type IceRow } from "../src/airlines/emirates.ts";
import { openDb } from "../src/db.ts";
import movies from "./fixtures/emirates-movies.json";
import taxonomy from "./fixtures/emirates-taxonomy.json";

const rows = movies.results as IceRow[];
const films = parseMovies(rows);

test("dedupes on trackList and drops the placeholder", () => {
  expect(rows.length).toBe(21);
  expect(films.length).toBe(11);
  expect(films.find((f) => /new on ice/i.test(f.title))).toBeUndefined();
  const dd = films.find((f) => f.title === "Disclosure Day");
  expect(dd?.categoryIds).toEqual([100, 111, 130, 131]);
  // same title, two trackLists stay two films
  expect(films.filter((f) => f.title === "The Sheep Detectives").map((f) => f.trackList).sort()).toEqual(["1370024", "1370303"]);
});

test("maps category ids to names", () => {
  const cats = parseCategories(taxonomy);
  expect(cats.size).toBe(74);
  expect(cats.get(100)).toBe("Latest Movies");
  expect(cats.get(111)).toBe("Sci-Fi & Fantasy");
});

test("cleans year suffix and language prefix", () => {
  expect(cleanTitle("Casablanca (1942)", "English")).toEqual({ cleanTitle: "Casablanca", year: 1942 });
  expect(cleanTitle("Telugu - War 2", "Telugu")).toEqual({ cleanTitle: "War 2", year: null });
  expect(cleanTitle("Kannada - Kantara: A Legend Chapter 1", "Hindi").cleanTitle).toBe("Kantara: A Legend Chapter 1");
  expect(cleanTitle("Wicked - The Real Story", "English")).toEqual({ cleanTitle: "Wicked - The Real Story", year: null });
  expect(films.find((f) => f.trackList === "1297012")?.year).toBe(1942);
});

test("source date: today for the current month, the 5th otherwise", () => {
  const now = new Date("2026-10-22T10:00:00Z");
  expect(sourceDate("2026-10", now)).toBe("2026-10-22");
  expect(sourceDate("2026-11", now)).toBe("2026-11-05");
});

test("stores a snapshot with category names", () => {
  const db = openDb(":memory:");
  storeSnapshot(db, "2026-10", "2026-10-22", "x", rows.length, films, parseCategories(taxonomy));
  expect(db.query("SELECT COUNT(*) AS n FROM movies").get()).toEqual({ n: 11 });
  expect(db.query("SELECT category_name AS c FROM movie_categories WHERE track_list = '1370023' AND category_id = 111").get()).toEqual({ c: "Sci-Fi & Fantasy" });
});
