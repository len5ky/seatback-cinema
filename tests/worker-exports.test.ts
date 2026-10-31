// profile_from_text on the export files people attach in the Claude app (synthetic rows, real column layouts).
import { expect, test } from "bun:test";
import type { Bundle } from "../src/bundle.ts";
import { Catalogue } from "../worker/src/catalogue.ts";
import { profileFromText } from "../worker/src/profile.ts";
import { callTool, ToolError, type ProfileStore } from "../worker/src/tools.ts";

const bundle = (await Bun.file(`${import.meta.dir}/../worker/test/fixtures/catalogue.sample.json`).json()) as Bundle;
const store: ProfileStore = { async get() { return null; }, async put() {} };
const ctx = { catalogue: new Catalogue(bundle), profiles: store };

// IMDb "Your Ratings" export, short form (the layout of data/imdb-ratings/ratings.csv)
const IMDB_SHORT = 'Const,Your Rating,Title,Year,Title Type\ntt1000001,9,"Film One",2025,Movie\ntt1000002,6,"Film, Two",2019,Movie\ntt1000003,8,"A Series",2020,TV Series\n';
// IMDb's full ratings export
const IMDB_FULL_HEAD = "﻿Const,Your Rating,Date Rated,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors";
const fullRow = (i: number, r: number, g: string, d: string) =>
  `"tt20000${String(i).padStart(2, "0")}","${r}","2025-01-${String((i % 28) + 1).padStart(2, "0")}","Film ${i}","Film ${i}","https://www.imdb.com/title/tt20000${String(i).padStart(2, "0")}/","Movie","7.1","110","2020","${g}","5000","2020-01-01","${d}"`;
const IMDB_FULL = [IMDB_FULL_HEAD,
  ...[1, 2, 3, 4, 5, 6].map((i) => fullRow(i, 9, "Drama, Thriller", "Ann Director")),
  ...[7, 8, 9].map((i) => fullRow(i, 3, "Horror", "Bo Director")),
].join("\r\n") + "\r\n";
// watchlist exports: the short form, and IMDb's list export (Position first, may carry Your Rating / Date Rated)
const IMDB_WL_SHORT = 'Const,Title,Year,Title Type\ntt3000001,"Wish One",2010,Movie\ntt3000002,"Wish Two",2024,Movie\n';
const IMDB_WL_LIST = 'Position,Const,Created,Modified,Description,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors,Your Rating,Date Rated\n' +
  '"1","tt3000003","2026-01-02","2026-01-02","","Wish Three","Wish Three","https://www.imdb.com/title/tt3000003/","Movie","8.0","120","2024","Drama","100000","2024-01-01","X","",""\n' +
  '"2","tt3000004","2026-01-02","2026-01-02","","Wish Four","Wish Four","https://www.imdb.com/title/tt3000004/","Movie","7.0","100","2023","Comedy","9000","2023-01-01","Y","7","2026-02-01"\n';
// Letterboxd export files
const LB_RATINGS = "Date,Name,Year,Letterboxd URI,Rating\n2025-01-01,Sinners,2025,https://boxd.it/a1,4.5\n2025-01-02,\"Crouching Tiger, Hidden Dragon\",2000,https://boxd.it/a2,3\n2025-01-03,Halfstar,2001,https://boxd.it/a3,0.5\n";
const LB_WATCHED = "Date,Name,Year,Letterboxd URI\n2025-01-01,Sinners,2025,https://boxd.it/a1\n2025-02-01,Unrated Film,1999,https://boxd.it/a4\n";
const LB_WATCHLIST = "Date,Name,Year,Letterboxd URI\n2025-03-01,Superman,2025,https://boxd.it/a5\n";

test("IMDb short ratings export: every row is seen, scores kept", () => {
  const p = profileFromText(IMDB_SHORT, "imdb_csv", {});
  expect(p.seen).toEqual(["tt1000001", "tt1000002", "tt1000003"]);
  expect(p.ratings).toEqual({ tt1000001: 9, tt1000002: 6, tt1000003: 8 });
  expect(p.watchlist).toBeUndefined();
});

test("IMDb full ratings export (BOM, CRLF, 14 columns) learns genres and directors", () => {
  const p = profileFromText(IMDB_FULL, "imdb_csv", {});
  expect(p.seen.length).toBe(9);
  expect(p.ratings?.tt2000001).toBe(9);
  expect(p.liked_genres).toContain("drama");
  expect(p.disliked_genres).toContain("horror");
  expect(p.liked_directors).toEqual(["Ann Director"]);
});

test("IMDb watchlist exports become a watchlist, including the list export that has a Your Rating column", () => {
  expect(profileFromText(IMDB_WL_SHORT, "imdb_csv", {})).toEqual({ seen: [], watchlist: ["tt3000001", "tt3000002"], source: "imdb_csv" });
  const l = profileFromText(IMDB_WL_LIST, "imdb_csv", {});
  expect(l.seen).toEqual([]);
  expect(l.watchlist).toEqual(["tt3000003", "tt3000004"]);
  // list: "watchlist" wins even over a ratings-shaped header
  expect(profileFromText(IMDB_SHORT, "imdb_csv", {}, "watchlist").watchlist?.length).toBe(3);
});

test("Letterboxd ratings.csv, watched.csv and watchlist.csv", () => {
  const r = profileFromText(LB_RATINGS, "letterboxd_csv", {});
  expect(r.ratings).toEqual({ "Sinners (2025)": 9, "Crouching Tiger, Hidden Dragon (2000)": 6, "Halfstar (2001)": 1 });
  const w = profileFromText(LB_WATCHED, "letterboxd_csv", {});
  expect(w).toEqual({ seen: ["Sinners (2025)", "Unrated Film (1999)"], source: "letterboxd_csv" });
  const wl = profileFromText(LB_WATCHLIST, "letterboxd_csv", {}, "watchlist");
  expect(wl).toEqual({ seen: [], watchlist: ["Superman (2025)"], source: "letterboxd_csv" });
});

test("a big export sent in parts with add_to adds up to the whole file", async () => {
  const lines = IMDB_FULL.trim().split("\r\n");
  const head = lines[0]!, rows = lines.slice(1);
  const part1 = [head, ...rows.slice(0, 4)].join("\n"), part2 = [head, ...rows.slice(4)].join("\n");
  const a = await callTool(ctx, "profile_from_text", { text: part1, kind: "imdb_csv" });
  const b = await callTool(ctx, "profile_from_text", { text: part2, kind: "imdb_csv", add_to: a });
  const whole = profileFromText(IMDB_FULL, "imdb_csv", {});
  expect(new Set(b.seen as string[])).toEqual(new Set(whole.seen));
  expect(b.ratings).toEqual(whole.ratings!);
  // Letterboxd: ratings then watched then watchlist in one profile
  const lb1 = await callTool(ctx, "profile_from_text", { text: LB_RATINGS, kind: "letterboxd_csv" });
  const lb2 = await callTool(ctx, "profile_from_text", { text: LB_WATCHED, kind: "letterboxd_csv", add_to: lb1 });
  const lb3 = await callTool(ctx, "profile_from_text", { text: LB_WATCHLIST, kind: "letterboxd_csv", list: "watchlist", add_to: lb2 });
  expect((lb3.seen as string[]).length).toBe(4);
  expect(lb3.watchlist).toEqual(["Superman (2025)"]);
});

test("a part without the header line is refused with a hint to repeat it", async () => {
  const rows = IMDB_FULL.trim().split("\r\n").slice(5).join("\n");
  const e = await callTool(ctx, "profile_from_text", { text: rows, kind: "imdb_csv" }).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ToolError);
  expect((e as Error).message).toMatch(/header line/);
  const lb = await callTool(ctx, "profile_from_text", { text: "2025-01-01,Sinners,2025,https://boxd.it/a1,4.5\n", kind: "letterboxd_csv" }).catch((x: unknown) => x);
  expect((lb as Error).message).toMatch(/header line/);
});
