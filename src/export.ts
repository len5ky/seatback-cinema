import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { normalizeTitle } from "./text.ts";

export const PUBLIC_DIR = process.env.PLANE_MOVIE_PUBLIC ?? "public/data";

/** Published film record: catalogue facts and IDs only (no synopsis, poster or cast). `versions` counts the airline rows folded into it. */
export interface ExportFilm {
  sourceId: string; title: string; year: number | null; runtime: number | null; directors: string[]; genres: string[];
  rating: string | null; languages: string[]; categories: string[];
  imdbId: string | null; imdbConfidence: string | null; tmdbId: number | null; versions: number; partial?: true;
}
export interface ExportFile { airline: string; name: string; month: string; fetchedAt: string; count: number; films: ExportFilm[] }
export interface IndexFile {
  generatedAt: string;
  airlines: { id: string; name: string; months: { month: string; count: number; fetchedAt: string; path: string }[] }[];
}

interface Row {
  source_id: string; title: string; year: number | null; runtime: number | null; directors: string | null; genres: string | null;
  rating: string | null; languages: string | null; imdb_id: string | null; partial: number; tconst: string | null; confidence: string | null; categories: string | null;
  tmdb_id: number | null;
}
const list = (s: string | null) => (s ? s.split(", ") : []);

export function exportSnapshot(db: Database, airline: string, month: string): ExportFile {
  const snap = db.query<{ name: string; fetched_at: string }, [string, string]>(
    "SELECT a.name, s.fetched_at FROM snapshots s JOIN airlines a ON a.code = s.airline WHERE s.airline = ? AND s.month = ?").get(airline, month);
  if (!snap) throw new Error(`no ${airline} snapshot for ${month}`);
  const rows = db.query<Row, [string, string]>(`
    SELECT m.source_id, m.title, m.year, m.runtime, m.directors, m.genres, m.rating, m.languages, m.imdb_id, m.partial,
           x.tconst, x.confidence, e.tmdb_id,
           (SELECT group_concat(category, char(31)) FROM movie_categories c WHERE c.airline = m.airline AND c.month = m.month AND c.source_id = m.source_id) AS categories
    FROM movies m LEFT JOIN matches x ON x.airline = m.airline AND x.source_id = m.source_id
    LEFT JOIN external_ids e ON e.tconst = x.tconst AND x.confidence IN ('high', 'medium')
    WHERE m.airline = ? AND m.month = ? ORDER BY m.title, m.source_id`).all(airline, month);
  const films = rows.map((r): ExportFilm => {
    const usable = r.confidence === "high" || r.confidence === "medium";
    return {
      sourceId: r.source_id, title: r.title, year: r.year, runtime: r.runtime, directors: list(r.directors), genres: list(r.genres),
      rating: r.rating, languages: list(r.languages), categories: r.categories ? r.categories.split("\x1f") : [],
      imdbId: usable ? r.tconst : null, imdbConfidence: r.confidence, tmdbId: usable ? r.tmdb_id : null, versions: 1,
      ...(r.partial ? { partial: true as const } : {}),
    };
  });
  const merged = dedupe(films);
  return { airline, name: snap.name, month, fetchedAt: snap.fetched_at, count: merged.length, films: merged };
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

/** One row per film: airlines list the same film several times (Emirates per audio track list, AD versions). The key is the
 *  IMDb id when matched, else the normalised title and year. The first row (title order) wins; lists are unioned. */
export function dedupe(films: ExportFilm[]): ExportFilm[] {
  const byKey = new Map<string, ExportFilm>();
  for (const f of films) {
    const key = f.imdbId ? `id:${f.imdbId}` : `t:${normalizeTitle(f.title)}|${f.year ?? ""}`;
    const kept = byKey.get(key);
    if (!kept) { byKey.set(key, { ...f }); continue; }
    kept.versions += f.versions;
    kept.categories = union(kept.categories, f.categories);
    kept.languages = union(kept.languages, f.languages);
    kept.genres = union(kept.genres, f.genres);
    kept.directors = union(kept.directors, f.directors);
    kept.year ??= f.year; kept.runtime ??= f.runtime; kept.rating ??= f.rating; kept.tmdbId ??= f.tmdbId;
    if (kept.partial && !f.partial) delete kept.partial;
  }
  return [...byKey.values()];
}

/** Published crosswalk entry; CC0 because only Wikidata-sourced rows are written. */
export interface IdsEntry { tmdb: number | null; letterboxd: string | null; rt: string | null; mc: string | null }
export type IdsFile = Record<string, IdsEntry>;

/** Write `ids.json` ({tconst: {tmdb, letterboxd, rt, mc}}): the existing file overlaid with every Wikidata row in the DB,
 *  so an export from a partial DB (CI, one airline) never drops published ids. Sorted, one entry per line. */
export function writeIdsFile(db: Database, dir: string = PUBLIC_DIR): { path: string; count: number } {
  const path = `${dir}/ids.json`;
  const ids: IdsFile = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as IdsFile) : {};
  const rows = db.query<{ tconst: string; tmdb_id: number | null; letterboxd_slug: string | null; rt_slug: string | null; mc_slug: string | null }, []>(
    "SELECT tconst, tmdb_id, letterboxd_slug, rt_slug, mc_slug FROM external_ids WHERE source = 'wikidata'").all();
  for (const r of rows) ids[r.tconst] = { tmdb: r.tmdb_id, letterboxd: r.letterboxd_slug, rt: r.rt_slug, mc: r.mc_slug };
  const keys = Object.keys(ids).sort();
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `{\n${keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(ids[k])}`).join(",\n")}\n}\n`);
  return { path, count: keys.length };
}

/** Write one JSON per (airline, month) snapshot (or only `month` / `airline`), the ids crosswalk, then an index of every exported file on disk. */
export function exportAll(db: Database, o: { month?: string; airline?: string; dir?: string } = {}): { files: { path: string; films: number }[]; index: string; ids: { path: string; count: number } } {
  const dir = o.dir ?? PUBLIC_DIR;
  const snaps = db.query<{ airline: string; name: string; month: string; films: number; fetched_at: string }, []>(
    "SELECT s.airline, a.name, s.month, s.films, s.fetched_at FROM snapshots s JOIN airlines a ON a.code = s.airline ORDER BY s.airline, s.month").all();
  const files: { path: string; films: number }[] = [];
  for (const s of snaps.filter((x) => (!o.month || x.month === o.month) && (!o.airline || x.airline === o.airline))) {
    const data = exportSnapshot(db, s.airline, s.month);
    mkdirSync(`${dir}/${s.airline}`, { recursive: true });
    const path = `${dir}/${s.airline}/${s.month}.json`;
    writeFileSync(path, `${JSON.stringify(data, null, 1)}\n`);
    files.push({ path, films: data.count });
  }
  const index: IndexFile = { generatedAt: new Date().toISOString(), airlines: [] };
  for (const s of snaps) {
    const rel = `${s.airline}/${s.month}.json`;
    if (!existsSync(`${dir}/${rel}`) && !files.some((f) => f.path === `${dir}/${rel}`)) continue;
    let a = index.airlines.find((x) => x.id === s.airline);
    if (!a) index.airlines.push((a = { id: s.airline, name: s.name, months: [] }));
    const count = (JSON.parse(readFileSync(`${dir}/${rel}`, "utf8")) as ExportFile).count;
    a.months.push({ month: s.month, count, fetchedAt: s.fetched_at, path: rel });
  }
  mkdirSync(dir, { recursive: true });
  const indexPath = `${dir}/index.json`;
  writeFileSync(indexPath, `${JSON.stringify(index, null, 1)}\n`);
  return { files, index: indexPath, ids: writeIdsFile(db, dir) };
}
