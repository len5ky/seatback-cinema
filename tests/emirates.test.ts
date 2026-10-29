import { expect, test } from "bun:test";
import { cleanTitle, parseCategories, parseEmirates, type EmiratesRaw } from "../src/airlines/emirates.ts";
import { adapters } from "../src/airlines/index.ts";
import { fetchDate } from "../src/airlines/http.ts";
import { openDb, storeFilms } from "../src/db.ts";
import movies from "./fixtures/emirates-movies.json";
import taxonomy from "./fixtures/emirates-taxonomy.json";

const raw = { taxonomy, movies } as unknown as EmiratesRaw; // fixture rows have summary and image fields stripped
const films = parseEmirates(raw);

test("dedupes on trackList and drops the placeholder", () => {
  expect(raw.movies.results.length).toBe(21);
  expect(films.length).toBe(11);
  expect(films.find((f) => /new on ice/i.test(f.title))).toBeUndefined();
  const dd = films.find((f) => f.title === "Disclosure Day");
  expect(dd?.categories).toEqual(["Latest Movies", "Sci-Fi & Fantasy", expect.any(String), expect.any(String)]);
  // same title, two trackLists stay two films
  expect(films.filter((f) => f.title === "The Sheep Detectives").map((f) => f.sourceId).sort()).toEqual(["1370024", "1370303"]);
});

test("maps fields onto the adapter contract", () => {
  const dd = films.find((f) => f.title === "Disclosure Day")!;
  expect(dd).toMatchObject({
    sourceId: "1370023", runtime: 146, directors: ["Steven Spielberg"], cast: ["Actor 1", "Actor 2", "Actor 3"],
    genres: ["Sci-Fi", "Thriller"], rating: "PG13", subtitles: [],
  });
  expect(dd.languages[0]).toBe("English");
  expect(new Set(dd.languages).size).toBe(dd.languages.length);
  expect(adapters.emirates?.parse(raw)).toEqual(films);
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
  expect(films.find((f) => f.sourceId === "1297012")).toMatchObject({ title: "Casablanca", year: 1942 });
});

test("fetch date: today for the current month, the 5th otherwise", () => {
  const now = new Date("2026-10-22T10:00:00Z");
  expect(fetchDate("2026-10", now)).toBe("2026-10-22");
  expect(fetchDate("2026-11", now)).toBe("2026-11-05");
});

test("stores a snapshot with category names", () => {
  const db = openDb(":memory:");
  storeFilms(db, adapters.emirates!, "2026-10", films, "x");
  expect(db.query("SELECT COUNT(*) AS n FROM movies").get()).toEqual({ n: 11 });
  expect(db.query("SELECT category FROM movie_categories WHERE source_id = '1370023' AND category = 'Sci-Fi & Fantasy'").get()).toEqual({ category: "Sci-Fi & Fantasy" });
  expect(db.query("SELECT directors, genres, primary_language FROM movies WHERE source_id = '1370023'").get())
    .toEqual({ directors: "Steven Spielberg", genres: "Sci-Fi, Thriller", primary_language: "English" });
  // re-storing the same month replaces it
  storeFilms(db, adapters.emirates!, "2026-10", films.slice(0, 3), "x");
  expect(db.query("SELECT COUNT(*) AS n FROM movies").get()).toEqual({ n: 3 });
});
