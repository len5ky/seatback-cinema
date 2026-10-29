import { expect, test } from "bun:test";
import { blend, blendParts, isSeen, learnAffinities, picks, scorePick, SHRINK, tasteAdjustment, voteWeight, WATCHLIST_BOOST, type PickRow, type Taste, type TasteModel } from "../src/rank.ts";
import { openDb } from "../src/db.ts";

const taste: Taste = { liked_genres: ["Sci-Fi", "Thriller"], disliked_genres: ["Horror"], min_rating: 6, min_votes: 5000, seen: ["Casablanca", "tt0111161"], favourites: [] };
const row = (o: Partial<PickRow>): PickRow => ({
  source_id: "1", title: "X", directors: "A B", genres: "Drama", runtime: 100, year: 2020, primary_language: "English", synopsis: null,
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
  const liked = scorePick(row({ genres: "Sci-Fi, Thriller" }), taste);
  const disliked = scorePick(row({ imdb_genres: "Drama,Horror" }), taste);
  expect(liked.score).toBeCloseTo(base + 0.8, 5);
  expect(liked.reasons).toContain("+Sci-Fi/Thriller");
  expect(disliked.score).toBeCloseTo(base - 1, 5);
});

test("favourite director boost", () => {
  const p = scorePick(row({ directors: "Denis Villeneuve" }), taste, ["Denis Villeneuve"]);
  expect(p.score).toBeCloseTo(scorePick(row({}), taste).score + 0.5, 5);
});

test("seen by title or tconst", () => {
  expect(isSeen(row({ title: "Casablanca (1942)", imdb_title: "Casablanca" }), taste)).toBe(true);
  expect(isSeen(row({ tconst: "tt0111161" }), taste)).toBe(true);
  expect(isSeen(row({}), taste)).toBe(false);
});

test("blend: missing sources re-normalise; IMDb alone is the v1 score", () => {
  expect(blend([{ source: "a", value: 8, weight: 0.4 }, { source: "b", value: 6, weight: 0.1 }])).toBeCloseTo(7.6, 10);
  expect(blend([])).toBe(6.5);
  const r = row({ rating: 8, votes: 100000 });
  const imdbOnly = (100000 / 105000) * 8 + (5000 / 105000) * 6.5;
  expect(scorePick(r, taste).score).toBeCloseTo(imdbOnly, 2);
  // Letterboxd 4.0 (=8.0), RT audience 90 (=9.0), Metacritic 70 (=7.0); IMDb and Letterboxd at full vote weight
  const p = scorePick(r, taste, [], { ratings: { letterboxd: { value: 4, votes: 200000 }, rt_audience: { value: 90, votes: 5000 }, mc_critics: { value: 70, votes: 40 } } });
  expect(p.score).toBeCloseTo((0.4 * imdbOnly + 0.3 * 8 + 0.15 * 9 + 0.15 * 7) / 1.0, 2);
  expect(p.sources).toEqual(["imdb", "letterboxd", "rt_audience", "mc_critics"]);
  expect(p.reasons).toContain("Letterboxd 4.0/5");
  expect(p.reasons).toContain("RT audience 90%");
});

test("vote weight grows with log10 votes, floored and capped", () => {
  expect(voteWeight(0)).toBe(0.2);
  expect(voteWeight(999)).toBeCloseTo(0.6, 5);
  expect(voteWeight(5_000_000)).toBe(1);
  const thin = blendParts({ rating: 9, votes: 100000 }, { letterboxd: { value: 5, votes: 9 } }, 5000);
  expect(thin[1]!.weight).toBeCloseTo(0.3 * 0.2, 5); // 10 Letterboxd ratings barely move a film
});

test("affinities: mean of (rating - your mean), shrunk by count", () => {
  const m = learnAffinities([
    { rating: 10, genres: ["Sci-Fi"], directors: ["nm1"] },
    { rating: 9, genres: ["Sci-Fi", "Drama"], directors: ["nm1"] },
    { rating: 4, genres: ["Romance"], directors: ["nm2"] },
    { rating: 5, genres: ["Romance", "Drama"], directors: ["nm3"] },
  ]);
  expect(m.mean).toBe(7);
  expect(m.genres.get("sci-fi")).toEqual({ value: (3 + 2) / (2 + SHRINK), n: 2 });
  expect(m.genres.get("romance")).toEqual({ value: (-3 - 2) / (2 + SHRINK), n: 2 });
  expect(m.genres.get("drama")?.value).toBe(0);
  expect(m.directors.get("nm1")?.value).toBe(1);
  const model: TasteModel = { ...m, watched: new Set(), watchlist: new Set() };
  const t = tasteAdjustment(model, ["Sci-Fi", "Thriller"], ["nm1"], () => "Denis Villeneuve");
  expect(t.delta).toBeCloseTo(1 / 2 + 1, 10); // genre term averages over the film's genres (Thriller unknown = 0)
  expect(t.reasons).toEqual(["you rate sci-fi +1.0 (2 films)", "you rate Denis Villeneuve +1.0 (2 films)"]);
});

test("picks: watched films are excluded, watchlist boosted, stored ratings blended", () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO snapshots VALUES ('ek','2026-10','x','d',3)");
  const film = (id: string, tconst: string, rating: number, genres: string) => {
    db.run("INSERT INTO movies (airline, month, source_id, title) VALUES ('ek','2026-10',?,?)", [id, id]);
    db.run("INSERT INTO matches VALUES ('ek',?,?,'high',1,'','x')", [id, tconst]);
    db.run("INSERT INTO imdb_titles VALUES (?, 'movie', ?, NULL, 2020, 100, ?, ?, 200000, 'nm1')", [tconst, id, genres, rating]);
  };
  film("Seen", "tt1", 9, "Drama");
  film("Wanted", "tt2", 7, "Drama");
  film("Other", "tt3", 7.6, "Drama");
  db.run("INSERT INTO user_films VALUES ('tt1','Seen',2020,8,1,0,'letterboxd','x'), ('tt2','Wanted',2020,NULL,0,1,'letterboxd','x')");
  db.run("INSERT INTO ratings VALUES ('tt3','letterboxd',4.5,100000,NULL,'x'), ('tt3','tmdb',8,100,NULL,'x')");
  const r = picks(db, { ...taste, seen: [], liked_genres: [], disliked_genres: [] }, { airline: "ek", month: "2026-10", top: 10 });
  expect(r.watched).toBe(1);
  expect(r.picks.map((p) => p.row.tconst)).toEqual(["tt2", "tt3"]);
  expect(r.picks[0]!.reasons).toContain("on your watchlist");
  expect(r.picks[0]!.score).toBeCloseTo((200000 / 205000) * 7 + (5000 / 205000) * 6.5 + WATCHLIST_BOOST, 2);
  expect(r.picks[1]!.sources).toEqual(["imdb", "letterboxd"]);
});

test("picks: min-year, max-year and year use the catalogue year, else IMDb startYear, and drop undated films", () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO snapshots VALUES ('ek','2026-10','x','d',4)");
  const film = (id: string, year: number | null, startYear: number | null) => {
    db.run("INSERT INTO movies (airline, month, source_id, title, year) VALUES ('ek','2026-10',?,?,?)", [id, id, year]);
    db.run("INSERT INTO matches VALUES ('ek',?,?,'high',1,'','x')", [id, `tt-${id}`]);
    db.run("INSERT INTO imdb_titles VALUES (?, 'movie', ?, NULL, ?, 100, 'Drama', 7, 200000, 'nm1')", [`tt-${id}`, id, startYear]);
  };
  film("Catalogue2024", 2024, 2020); // catalogue year wins over startYear
  film("ImdbOnly2010", null, 2010); // no catalogue year: falls back to startYear
  film("Undated", null, null); // no year at all
  film("Catalogue2019", 2019, null); // catalogue year, no startYear
  const base = { airline: "ek", month: "2026-10", top: 10 };
  const t = { ...taste, seen: [], liked_genres: [], disliked_genres: [] };
  const tconsts = (o: Partial<Parameters<typeof picks>[2]>) => picks(db, t, { ...base, ...o }).picks.map((p) => p.row.source_id).sort();

  expect(tconsts({})).toEqual(["Catalogue2019", "Catalogue2024", "ImdbOnly2010", "Undated"]);
  expect(tconsts({ minYear: 2020 })).toEqual(["Catalogue2024"]);
  expect(tconsts({ maxYear: 2019 })).toEqual(["Catalogue2019", "ImdbOnly2010"]);
  expect(tconsts({ minYear: 2010, maxYear: 2020 })).toEqual(["Catalogue2019", "ImdbOnly2010"]);
  // --year N is min and max together
  expect(tconsts({ minYear: 2024, maxYear: 2024 })).toEqual(["Catalogue2024"]);
});

test("cli: --min-year, --max-year and --year outside 1880-2100 or not an integer exit 1 with a message", () => {
  const cli = `${import.meta.dir}/../src/cli.ts`;
  for (const args of [["--min-year", "1879"], ["--max-year", "2101"], ["--year", "2025.5"], ["--min-year", "abc"], ["--year", ""]]) {
    const p = Bun.spawnSync([process.execPath, cli, "picks", ...args], { stdout: "pipe", stderr: "pipe" });
    const flag = `--${args[0]!.replace(/^--/, "")}`;
    expect(p.exitCode).toBe(1);
    expect(new TextDecoder().decode(p.stderr)).toContain(`${flag} must be a positive integer from 1880 to 2100`);
  }
});
