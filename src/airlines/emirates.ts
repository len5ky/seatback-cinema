import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { DATA_DIR } from "../db.ts";

const BASE = "https://www.emirates.com/service/exp/ice";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const PLACEHOLDER = /^what'?s new on ice$/i;

export interface IceRow {
  id: number; categoryId: number; title: string; starring: string | null; director: string | null;
  genre: string | null; summary: string | null; languages: string | null; subtitles: string | null;
  rating: string | null; duration: number | null; trailer: string | null; image: string | null;
  posterImage: string | null; trackList: string;
}
interface IceTaxonomy { results: { id: string; categories?: { id: string; name: string }[] | null }[] }

export interface Film {
  trackList: string; title: string; cleanTitle: string; year: number | null;
  starring: string | null; director: string | null; genre: string | null; summary: string | null;
  rating: string | null; duration: number | null; languages: string | null; primaryLanguage: string | null;
  subtitles: string | null; image: string | null; trailer: string | null; categoryIds: number[];
}

/** Strip "(1985)" year suffix and a "Telugu - " language prefix that repeats the film's language. */
export function cleanTitle(title: string, primaryLanguage: string | null): { cleanTitle: string; year: number | null } {
  let t = title.trim();
  let year: number | null = null;
  const y = t.match(/\s*\((\d{4})\)$/);
  if (y?.[1]) { year = Number(y[1]); t = t.slice(0, y.index).trim(); }
  const p = t.match(/^([A-Za-z]+) - (.+)$/);
  if (p?.[1] && p[2] && primaryLanguage && p[1].toLowerCase() === primaryLanguage.toLowerCase()) t = p[2].trim();
  return { cleanTitle: t, year };
}

/** Rows are (category, film) placements: dedupe on trackList, drop the placeholder channels ("What's new on ice", "iceologies"). */
export function parseMovies(rows: IceRow[]): Film[] {
  const films = new Map<string, Film>();
  for (const r of rows) {
    if (!r.trackList || PLACEHOLDER.test(r.title.trim()) || r.director === "The ice team") continue;
    const existing = films.get(r.trackList);
    if (existing) {
      if (!existing.categoryIds.includes(r.categoryId)) existing.categoryIds.push(r.categoryId);
      continue;
    }
    const primaryLanguage = r.languages?.split(",")[0]?.trim() || null;
    films.set(r.trackList, {
      trackList: r.trackList, title: r.title.trim(), ...cleanTitle(r.title, primaryLanguage),
      starring: r.starring, director: r.director, genre: r.genre, summary: r.summary, rating: r.rating,
      duration: r.duration, languages: r.languages, primaryLanguage, subtitles: r.subtitles,
      image: r.posterImage ?? r.image, trailer: r.trailer, categoryIds: [r.categoryId],
    });
  }
  return [...films.values()];
}

export function parseCategories(taxonomy: IceTaxonomy): Map<number, string> {
  const movies = taxonomy.results.find((g) => g.id === "movies");
  return new Map((movies?.categories ?? []).map((c) => [Number(c.id), c.name]));
}

/** Date param for a month: today for the current month, the 5th otherwise. */
export function sourceDate(month: string, today = new Date()): string {
  const iso = today.toISOString().slice(0, 10);
  return iso.startsWith(month) ? iso : `${month}-05`;
}

async function getJson(url: string, path: string, refresh: boolean): Promise<unknown> {
  if (!refresh && existsSync(path)) return Bun.file(path).json();
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const text = await res.text();
  if (text.length < 100) throw new Error(`GET ${url} returned a near-empty body (${text.length} bytes)`);
  await Bun.write(path, text);
  return JSON.parse(text);
}

/** Fetch (or reuse the cached raw JSON for) one month and store it as a snapshot. */
export async function fetchEmirates(db: Database, month: string, refresh = false): Promise<{ rows: number; films: number; cached: boolean }> {
  const dir = `${DATA_DIR}/raw/emirates`;
  mkdirSync(dir, { recursive: true });
  const date = sourceDate(month);
  const moviesPath = `${dir}/${month}-movies.json`;
  const cached = !refresh && existsSync(moviesPath);
  const taxonomy = (await getJson(`${BASE}?date=${date}`, `${dir}/${month}-taxonomy.json`, refresh)) as IceTaxonomy;
  const data = (await getJson(`${BASE}?date=${date}&group=movies`, moviesPath, refresh)) as { results: IceRow[] };
  const films = parseMovies(data.results);
  storeSnapshot(db, month, date, moviesPath, data.results.length, films, parseCategories(taxonomy));
  return { rows: data.results.length, films: films.length, cached };
}

export function storeSnapshot(db: Database, month: string, date: string, rawPath: string, rows: number, films: Film[], categories: Map<number, string>): void {
  const insMovie = db.prepare(`INSERT INTO movies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insCat = db.prepare(`INSERT INTO movie_categories VALUES (?,?,?,?,?)`);
  db.transaction(() => {
    db.run("DELETE FROM movies WHERE airline = 'emirates' AND month = ?", [month]);
    db.run("DELETE FROM movie_categories WHERE airline = 'emirates' AND month = ?", [month]);
    for (const f of films) {
      insMovie.run("emirates", month, f.trackList, f.title, f.cleanTitle, f.year, f.starring, f.director, f.genre, f.summary,
        f.rating, f.duration, f.languages, f.primaryLanguage, f.subtitles, f.image, f.trailer);
      for (const c of f.categoryIds) insCat.run("emirates", month, f.trackList, c, categories.get(c) ?? null);
    }
    db.run("INSERT OR REPLACE INTO snapshots VALUES ('emirates', ?, ?, ?, ?, ?, ?)",
      [month, new Date().toISOString(), date, rawPath, rows, films.length]);
  })();
}
