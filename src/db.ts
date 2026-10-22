import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DATA_DIR = process.env.PLANE_MOVIE_DATA ?? "data";
export const DB_PATH = `${DATA_DIR}/plane_movie.sqlite`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS airlines (code TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (
  airline TEXT NOT NULL, month TEXT NOT NULL, fetched_at TEXT NOT NULL, source_date TEXT NOT NULL,
  raw_path TEXT NOT NULL, rows INTEGER NOT NULL, films INTEGER NOT NULL,
  PRIMARY KEY (airline, month)
);
CREATE TABLE IF NOT EXISTS movies (
  airline TEXT NOT NULL, month TEXT NOT NULL, track_list TEXT NOT NULL,
  title TEXT NOT NULL, clean_title TEXT NOT NULL, year INTEGER,
  starring TEXT, director TEXT, genre TEXT, summary TEXT, rating TEXT, duration INTEGER,
  languages TEXT, primary_language TEXT, subtitles TEXT, image TEXT, trailer TEXT,
  PRIMARY KEY (airline, month, track_list)
);
CREATE TABLE IF NOT EXISTS movie_categories (
  airline TEXT NOT NULL, month TEXT NOT NULL, track_list TEXT NOT NULL,
  category_id INTEGER NOT NULL, category_name TEXT,
  PRIMARY KEY (airline, month, track_list, category_id)
);
CREATE TABLE IF NOT EXISTS matches (
  airline TEXT NOT NULL, track_list TEXT NOT NULL, tconst TEXT, confidence TEXT NOT NULL,
  score REAL NOT NULL, reasons TEXT NOT NULL, matched_at TEXT NOT NULL,
  PRIMARY KEY (airline, track_list)
);
INSERT OR IGNORE INTO airlines VALUES ('emirates', 'Emirates');
`;

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
  db.exec(SCHEMA + imdbSchema());
  return db;
}

/** Latest snapshot month for an airline, or null if none fetched yet. */
export function latestMonth(db: Database, airline: string): string | null {
  const row = db.query<{ month: string }, [string]>("SELECT month FROM snapshots WHERE airline = ? ORDER BY month DESC LIMIT 1").get(airline);
  return row?.month ?? null;
}
