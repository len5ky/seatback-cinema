import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CatalogueFilm } from "./airlines/types.ts";

export const DATA_DIR = process.env.PLANE_MOVIE_DATA ?? "data";
export const DB_PATH = `${DATA_DIR}/plane_movie.sqlite`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS airlines (code TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (
  airline TEXT NOT NULL, month TEXT NOT NULL, fetched_at TEXT NOT NULL, raw_dir TEXT NOT NULL, films INTEGER NOT NULL,
  PRIMARY KEY (airline, month)
);
CREATE TABLE IF NOT EXISTS movies (
  airline TEXT NOT NULL, month TEXT NOT NULL, source_id TEXT NOT NULL,
  title TEXT NOT NULL, year INTEGER, runtime INTEGER, directors TEXT, cast TEXT, genres TEXT, rating TEXT,
  languages TEXT, primary_language TEXT, subtitles TEXT, synopsis TEXT, imdb_id TEXT, poster TEXT, partial INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (airline, month, source_id)
);
CREATE TABLE IF NOT EXISTS movie_categories (
  airline TEXT NOT NULL, month TEXT NOT NULL, source_id TEXT NOT NULL, category TEXT NOT NULL,
  PRIMARY KEY (airline, month, source_id, category)
);
CREATE TABLE IF NOT EXISTS matches (
  airline TEXT NOT NULL, source_id TEXT NOT NULL, tconst TEXT, confidence TEXT NOT NULL,
  score REAL NOT NULL, reasons TEXT NOT NULL, matched_at TEXT NOT NULL,
  PRIMARY KEY (airline, source_id)
);
-- ratings and taste (v2). ratings.value keeps each source's native scale (tmdb 0-10, letterboxd 0.5-5,
-- rt_critics/rt_audience 0-100, mc_critics 0-100, mc_user 0-10); NULL value = looked up, nothing found (cached).
-- user_films.rating is on a 10-point scale (Letterboxd stars x2). external_ids.source: wikidata | letterboxd | tmdb | none.
CREATE TABLE IF NOT EXISTS external_ids (
  tconst TEXT PRIMARY KEY, tmdb_id INTEGER, letterboxd_slug TEXT, rt_slug TEXT, mc_slug TEXT, source TEXT NOT NULL, fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ratings (
  tconst TEXT NOT NULL, source TEXT NOT NULL, value REAL, votes INTEGER, extra TEXT, fetched_at TEXT NOT NULL,
  PRIMARY KEY (tconst, source)
);
CREATE TABLE IF NOT EXISTS user_films (
  tconst TEXT, title TEXT NOT NULL, year INTEGER, rating REAL, watched INTEGER NOT NULL DEFAULT 0, watchlist INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS user_films_tconst ON user_films (tconst);
`;
/** v1 catalogue tables (Emirates-only, keyed by track_list); catalogue data is rebuilt from the cached raw files. */
const V1_TABLES = ["movies", "movie_categories", "matches", "snapshots"];

/** IMDb tables; `suffix` "_new" builds staging copies that loadImdb swaps in atomically. */
export const imdbSchema = (suffix = "") => `
CREATE TABLE IF NOT EXISTS imdb_titles${suffix} (
  tconst TEXT PRIMARY KEY, title_type TEXT NOT NULL, primary_title TEXT NOT NULL, original_title TEXT,
  start_year INTEGER, runtime INTEGER, genres TEXT, rating REAL, votes INTEGER, directors TEXT
);
CREATE TABLE IF NOT EXISTS imdb_keys${suffix} (norm TEXT NOT NULL, tconst TEXT NOT NULL, PRIMARY KEY (norm, tconst)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS imdb_names${suffix} (nconst TEXT PRIMARY KEY, name TEXT NOT NULL);
`;
export const IMDB_TABLES = ["imdb_titles", "imdb_keys", "imdb_names"] as const;

export function openDb(path: string = DB_PATH): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  const v1 = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('movies')").all().some((c) => c.name === "track_list");
  if (v1) for (const t of V1_TABLES) db.run(`DROP TABLE IF EXISTS ${t}`);
  db.exec(SCHEMA + imdbSchema());
  return db;
}

const join = (xs: string[]) => (xs.length ? xs.join(", ") : null);

/** Replace one airline-month snapshot with the parsed films. */
export function storeFilms(db: Database, airline: { id: string; name: string }, month: string, films: CatalogueFilm[], rawDir: string, fetchedAt = new Date().toISOString()): void {
  const insMovie = db.prepare("INSERT INTO movies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const insCat = db.prepare("INSERT OR IGNORE INTO movie_categories VALUES (?,?,?,?)");
  db.transaction(() => {
    db.run("INSERT OR REPLACE INTO airlines VALUES (?, ?)", [airline.id, airline.name]);
    db.run("DELETE FROM movies WHERE airline = ? AND month = ?", [airline.id, month]);
    db.run("DELETE FROM movie_categories WHERE airline = ? AND month = ?", [airline.id, month]);
    for (const f of films) {
      insMovie.run(airline.id, month, f.sourceId, f.title, f.year ?? null, f.runtime ?? null, join(f.directors), join(f.cast),
        join(f.genres), f.rating ?? null, join(f.languages), f.languages[0] ?? null, join(f.subtitles), f.synopsis ?? null,
        f.imdbId ?? null, f.poster ?? null, f.partial ? 1 : 0);
      for (const c of f.categories) insCat.run(airline.id, month, f.sourceId, c);
    }
    db.run("INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?, ?, ?)", [airline.id, month, fetchedAt, rawDir, films.length]);
  })();
}

/** Latest snapshot month for an airline, or null if none fetched yet. */
export function latestMonth(db: Database, airline: string): string | null {
  const row = db.query<{ month: string }, [string]>("SELECT month FROM snapshots WHERE airline = ? ORDER BY month DESC LIMIT 1").get(airline);
  return row?.month ?? null;
}
