import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { DATA_DIR } from "../db.ts";
import { detectImdbExport, isFilmType, type ImdbExportKind, type parseImdbExport } from "./imdb-csv.ts";
export { detectImdbExport, isFilmType, parseImdbExport, type ImdbExportKind, type ImdbFilm } from "./imdb-csv.ts";

export interface ImdbImportResult { kind: ImdbExportKind; films: number; rated: number; watchlist: number; otherTypes: number; skipped: number; inImdb: number }

/** Replace this kind's rows of user_films (source imdb_ratings | imdb_watchlist), joined straight on Const = tconst. */
export function importImdbExport(db: Database, parsed: ReturnType<typeof parseImdbExport>, now = new Date().toISOString()): ImdbImportResult {
  const { kind, films, skipped } = parsed;
  const source = `imdb_${kind}`;
  const r: ImdbImportResult = { kind, films: films.length, rated: 0, watchlist: 0, otherTypes: 0, skipped, inImdb: 0 };
  const ins = db.prepare("INSERT INTO user_films VALUES (?,?,?,?,?,?,?,?)");
  const known = db.prepare<{ n: number }, [string]>("SELECT 1 AS n FROM imdb_titles WHERE tconst = ?");
  db.transaction(() => {
    db.run("DELETE FROM user_films WHERE source = ?", [source]);
    for (const f of films) {
      const rated = kind === "ratings" && f.rating !== null;
      if (rated) r.rated++;
      if (kind === "watchlist") r.watchlist++;
      if (!isFilmType(f.titleType)) r.otherTypes++;
      if (known.get(f.tconst)) r.inImdb++;
      ins.run(f.tconst, f.title, f.year, rated ? f.rating : null, kind === "ratings" ? 1 : 0, kind === "watchlist" ? 1 : 0, source, now);
    }
  })();
  return r;
}

export const IMDB_RATINGS_DIR = `${DATA_DIR}/imdb-ratings`;

/** True when the file's header row has a Const column. */
export async function isImdbCsv(path: string): Promise<boolean> {
  if (!path.endsWith(".csv") || !existsSync(path) || statSync(path).isDirectory()) return false;
  return detectImdbExport(await Bun.file(path).text()) !== null;
}

/** Newest ratings export and newest watchlist export in data/imdb-ratings/ (either may be missing). */
export async function defaultImdbExports(dir = IMDB_RATINGS_DIR): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const csvs = readdirSync(dir).filter((n) => n.endsWith(".csv")).map((n) => `${dir}/${n}`)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const newest = new Map<ImdbExportKind, string>();
  for (const p of csvs) {
    const kind = detectImdbExport(await Bun.file(p).text());
    if (kind && !newest.has(kind)) newest.set(kind, p);
  }
  return [...newest.values()];
}
