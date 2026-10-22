import { expect, test } from "bun:test";
import { isSeen, scorePick, type PickRow, type Taste } from "../src/rank.ts";

const taste: Taste = { liked_genres: ["Sci-Fi", "Thriller"], disliked_genres: ["Horror"], min_rating: 6, min_votes: 5000, seen: ["Casablanca", "tt0111161"], favourites: [] };
const row = (o: Partial<PickRow>): PickRow => ({
  track_list: "1", title: "X", director: "A B", genre: "Drama", duration: 100, primary_language: "English", summary: null,
  tconst: "tt1", confidence: "high", imdb_title: "X", start_year: 2020, imdb_genres: "Drama", rating: 7.5, votes: 100000, imdb_directors: null, ...o,
});

test("votes shrink ratings toward the prior", () => {
  const many = scorePick(row({ rating: 8.0, votes: 500000 }), taste).score;
  const few = scorePick(row({ rating: 8.0, votes: 500 }), taste).score;
  expect(many).toBeGreaterThan(7.9);
  expect(few).toBeLessThan(7);
});

test("genre boosts and penalties", () => {
  const base = scorePick(row({}), taste).score;
  const liked = scorePick(row({ genre: "Sci-Fi / Thriller" }), taste);
  const disliked = scorePick(row({ imdb_genres: "Drama,Horror" }), taste);
  expect(liked.score).toBeCloseTo(base + 0.8, 5);
  expect(liked.reasons).toContain("+Sci-Fi/Thriller");
  expect(disliked.score).toBeCloseTo(base - 1, 5);
});

test("favourite director boost", () => {
  const p = scorePick(row({ director: "Denis Villeneuve" }), taste, ["Denis Villeneuve"]);
  expect(p.score).toBeCloseTo(scorePick(row({}), taste).score + 0.5, 5);
});

test("seen by title or tconst", () => {
  expect(isSeen(row({ title: "Casablanca (1942)", imdb_title: "Casablanca" }), taste)).toBe(true);
  expect(isSeen(row({ tconst: "tt0111161" }), taste)).toBe(true);
  expect(isSeen(row({}), taste)).toBe(false);
});
