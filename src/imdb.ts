import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { DATA_DIR } from "./db.ts";
import { normalizeTitle } from "./text.ts";

const BASE = "https://datasets.imdbws.com";
const FILES = ["title.basics", "title.akas", "title.ratings", "title.crew", "name.basics"] as const;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
// tvSpecial/video cover the concert films and documentaries airlines carry
const KEEP_TYPES = new Set(["movie", "tvMovie", "tvSpecial", "video"]);
// English-market and UAE release titles: "Zootropolis", "Philosopher's Stone", "Escape to Victory"
const AKA_REGIONS = new Set(["GB", "US", "XWW", "AU", "CA", "IE", "IN", "AE"]);
const BATCH = 50_000;

const dir = () => `${DATA_DIR}/imdb`;
const gzPath = (f: string) => `${dir()}/${f}.tsv.gz`;
const num = (s: string | undefined): number | null => (s && s !== "\\N" ? Number(s) : null);

/** Download each dataset unless a copy younger than 7 days exists. Returns files fetched. */
export async function downloadImdb(force = false): Promise<string[]> {
  mkdirSync(dir(), { recursive: true });
  const fetched: string[] = [];
  for (const f of FILES) {
    const path = gzPath(f);
    if (!force && existsSync(path) && Date.now() - statSync(path).mtimeMs < MAX_AGE_MS) continue;
    const res = await fetch(`${BASE}/${f}.tsv.gz`);
    if (!res.ok || !res.body) throw new Error(`download ${f} -> ${res.status}`);
    await Bun.write(`${path}.part`, res);
    renameSync(`${path}.part`, path);
    fetched.push(f);
  }
  return fetched;
}

/** Stream a gzipped TSV line by line (header skipped), split into fields. */
async function* tsvRows(path: string): AsyncGenerator<string[]> {
  const stream = Bun.file(path).stream().pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream());
  let buf = "";
  let header = true;
  for await (const chunk of stream) {
    buf += chunk;
    let nl: number;
    let start = 0;
    while ((nl = buf.indexOf("\n", start)) !== -1) {
      const line = buf.slice(start, nl);
      start = nl + 1;
      if (header) { header = false; continue; }
      if (line) yield line.split("\t");
    }
    buf = buf.slice(start);
  }
  if (buf && !header) yield buf.split("\t");
}

/** Run `fn` over rows in batched transactions so memory and journal stay bounded. */
async function batched(db: Database, rows: AsyncGenerator<string[]>, fn: (r: string[]) => void): Promise<void> {
  let n = 0;
  db.exec("BEGIN");
  for await (const r of rows) {
    fn(r);
    if (++n % BATCH === 0) { db.exec("COMMIT"); db.exec("BEGIN"); }
  }
  db.exec("COMMIT");
}

/** Rebuild imdb_* tables from the downloaded datasets (movies and TV movies only). */
export async function loadImdb(db: Database, log: (m: string) => void = console.log): Promise<{ titles: number; names: number }> {
  db.exec("DELETE FROM imdb_titles; DELETE FROM imdb_keys; DELETE FROM imdb_names;");
  const insTitle = db.prepare("INSERT INTO imdb_titles (tconst, title_type, primary_title, original_title, start_year, runtime, genres) VALUES (?,?,?,?,?,?,?)");
  const insKey = db.prepare("INSERT OR IGNORE INTO imdb_keys VALUES (?, ?)");
  const kept = new Set<string>();

  // tconst titleType primaryTitle originalTitle isAdult startYear endYear runtimeMinutes genres
  await batched(db, tsvRows(gzPath("title.basics")), ([tconst, type, primary, original, , year, , runtime, genres]) => {
    if (!tconst || !type || !primary || !KEEP_TYPES.has(type)) return;
    kept.add(tconst);
    insTitle.run(tconst, type, primary, original ?? null, num(year), num(runtime), genres === "\\N" ? null : genres ?? null);
    const a = normalizeTitle(primary);
    insKey.run(a, tconst);
    if (original && original !== primary) {
      const b = normalizeTitle(original);
      if (b !== a) insKey.run(b, tconst);
    }
  });
  log(`  title.basics: ${kept.size} titles (${[...KEEP_TYPES].join(", ")})`);

  let akas = 0;
  // titleId ordering title region language types attributes isOriginalTitle
  await batched(db, tsvRows(gzPath("title.akas")), ([tconst, , title, region]) => {
    if (!tconst || !title || !region || !AKA_REGIONS.has(region) || !kept.has(tconst)) return;
    if (insKey.run(normalizeTitle(title), tconst).changes) akas++;
  });
  log(`  title.akas: ${akas} extra title keys`);

  const setRating = db.prepare("UPDATE imdb_titles SET rating = ?, votes = ? WHERE tconst = ?");
  await batched(db, tsvRows(gzPath("title.ratings")), ([tconst, rating, votes]) => {
    if (tconst && kept.has(tconst)) setRating.run(num(rating), num(votes), tconst);
  });
  log("  title.ratings: done");

  const directorIds = new Set<string>();
  const setDirectors = db.prepare("UPDATE imdb_titles SET directors = ? WHERE tconst = ?");
  await batched(db, tsvRows(gzPath("title.crew")), ([tconst, directors]) => {
    if (!tconst || !kept.has(tconst) || !directors || directors === "\\N") return;
    setDirectors.run(directors, tconst);
    for (const d of directors.split(",")) directorIds.add(d);
  });
  kept.clear();
  log(`  title.crew: ${directorIds.size} distinct directors`);

  const insName = db.prepare("INSERT INTO imdb_names VALUES (?, ?)");
  let names = 0;
  await batched(db, tsvRows(gzPath("name.basics")), ([nconst, name]) => {
    if (nconst && name && directorIds.has(nconst)) { insName.run(nconst, name); names++; }
  });
  log(`  name.basics: ${names} director names`);
  const titles = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM imdb_titles").get()?.n ?? 0;
  return { titles, names };
}
