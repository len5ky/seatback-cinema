import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

export const PUBLIC_DIR = process.env.PLANE_MOVIE_PUBLIC ?? "public/data";

/** Published film record: catalogue facts and IDs only (no synopsis, poster or cast). */
export interface ExportFilm {
  sourceId: string; title: string; year: number | null; runtime: number | null; directors: string[]; genres: string[];
  rating: string | null; languages: string[]; categories: string[];
  imdbId: string | null; imdbConfidence: string | null; tmdbId: null; partial?: true;
}
export interface ExportFile { airline: string; name: string; month: string; fetchedAt: string; count: number; films: ExportFilm[] }
export interface IndexFile {
  generatedAt: string;
  airlines: { id: string; name: string; months: { month: string; count: number; fetchedAt: string; path: string }[] }[];
}

interface Row {
  source_id: string; title: string; year: number | null; runtime: number | null; directors: string | null; genres: string | null;
  rating: string | null; languages: string | null; imdb_id: string | null; partial: number; tconst: string | null; confidence: string | null; categories: string | null;
}
const list = (s: string | null) => (s ? s.split(", ") : []);

export function exportSnapshot(db: Database, airline: string, month: string): ExportFile {
  const snap = db.query<{ name: string; fetched_at: string }, [string, string]>(
    "SELECT a.name, s.fetched_at FROM snapshots s JOIN airlines a ON a.code = s.airline WHERE s.airline = ? AND s.month = ?").get(airline, month);
  if (!snap) throw new Error(`no ${airline} snapshot for ${month}`);
  const rows = db.query<Row, [string, string]>(`
    SELECT m.source_id, m.title, m.year, m.runtime, m.directors, m.genres, m.rating, m.languages, m.imdb_id, m.partial,
           x.tconst, x.confidence,
           (SELECT group_concat(category, char(31)) FROM movie_categories c WHERE c.airline = m.airline AND c.month = m.month AND c.source_id = m.source_id) AS categories
    FROM movies m LEFT JOIN matches x ON x.airline = m.airline AND x.source_id = m.source_id
    WHERE m.airline = ? AND m.month = ? ORDER BY m.title, m.source_id`).all(airline, month);
  const films = rows.map((r): ExportFilm => {
    const usable = r.confidence === "high" || r.confidence === "medium";
    return {
      sourceId: r.source_id, title: r.title, year: r.year, runtime: r.runtime, directors: list(r.directors), genres: list(r.genres),
      rating: r.rating, languages: list(r.languages), categories: r.categories ? r.categories.split("\x1f") : [],
      imdbId: usable ? r.tconst : null, imdbConfidence: r.confidence, tmdbId: null, ...(r.partial ? { partial: true as const } : {}),
    };
  });
  return { airline, name: snap.name, month, fetchedAt: snap.fetched_at, count: films.length, films };
}

/** Write one JSON per (airline, month) snapshot (or only `month`), then an index of every exported file on disk. */
export function exportAll(db: Database, o: { month?: string; dir?: string } = {}): { files: { path: string; films: number }[]; index: string } {
  const dir = o.dir ?? PUBLIC_DIR;
  const snaps = db.query<{ airline: string; name: string; month: string; films: number; fetched_at: string }, []>(
    "SELECT s.airline, a.name, s.month, s.films, s.fetched_at FROM snapshots s JOIN airlines a ON a.code = s.airline ORDER BY s.airline, s.month").all();
  const files: { path: string; films: number }[] = [];
  for (const s of snaps.filter((x) => !o.month || x.month === o.month)) {
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
    a.months.push({ month: s.month, count: s.films, fetchedAt: s.fetched_at, path: rel });
  }
  mkdirSync(dir, { recursive: true });
  const indexPath = `${dir}/index.json`;
  writeFileSync(indexPath, `${JSON.stringify(index, null, 1)}\n`);
  return { files, index: indexPath };
}
