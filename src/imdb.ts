import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { DATA_DIR, IMDB_TABLES, imdbSchema } from "./db.ts";
import { normalizeTitle } from "./text.ts";

const BASE = "https://datasets.imdbws.com";
const FILES = ["title.basics", "title.akas", "title.ratings", "title.crew", "name.basics"] as const;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
// tvSpecial/video cover the concert films and documentaries airlines carry
const KEEP_TYPES = new Set(["movie", "tvMovie", "tvSpecial", "video"]);
// English-market and UAE release titles ("Zootropolis", "Philosopher's Stone", "Escape to Victory"), plus the European
// markets whose retitles show up in English-language catalogues ("Vaiana" for Moana). The five European regions add
// ~538k aka rows over the ~2.46M already scanned (Oct 2026 dump, kept title types); keys are deduped, so the table
// grows by less than that. Takes effect on the next `imdb sync --force`.
export const AKA_REGIONS = new Set(["GB", "US", "XWW", "AU", "CA", "IE", "IN", "AE", "NL", "FR", "DE", "IT", "ES"]);
const BATCH = 50_000;

const IMDB_DIR = `${DATA_DIR}/imdb`;
const gzPath = (f: string, dir = IMDB_DIR) => `${dir}/${f}.tsv.gz`;
const num = (s: string | undefined): number | null => (s && s !== "\\N" ? Number(s) : null);

/** Download each dataset unless a copy younger than 7 days exists. Returns files fetched. */
export async function downloadImdb(force = false): Promise<string[]> {
  mkdirSync(IMDB_DIR, { recursive: true });
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
  try {
    for await (const r of rows) {
      fn(r);
      if (++n % BATCH === 0) { db.exec("COMMIT"); db.exec("BEGIN"); }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Rebuild imdb_* tables from the downloaded datasets. Everything loads into `*_new` staging tables and is
 * swapped in by one transaction at the end, so a failure part-way leaves the previous data untouched.
 * Membership checks go through SQLite (indexed) rather than in-memory id sets, keeping memory bounded.
 */
export async function loadImdb(db: Database, log: (m: string) => void = console.log, minTitles = 100_000, dir = IMDB_DIR): Promise<{ titles: number; names: number }> {
  const drop = (suffix: string) => db.exec(IMDB_TABLES.map((t) => `DROP TABLE IF EXISTS ${t}${suffix};`).join(""));
  drop("_new");
  db.exec(imdbSchema("_new") + "CREATE TEMP TABLE IF NOT EXISTS director_ids (nconst TEXT PRIMARY KEY) WITHOUT ROWID; DELETE FROM director_ids;");
  try {
    const insTitle = db.prepare("INSERT INTO imdb_titles_new (tconst, title_type, primary_title, original_title, start_year, runtime, genres) VALUES (?,?,?,?,?,?,?)");
    const insKey = db.prepare("INSERT OR IGNORE INTO imdb_keys_new VALUES (?, ?)");
    let titles = 0;
    // tconst titleType primaryTitle originalTitle isAdult startYear endYear runtimeMinutes genres
    await batched(db, tsvRows(gzPath("title.basics", dir)), ([tconst, type, primary, original, , year, , runtime, genres]) => {
      if (!tconst || !type || !primary || !KEEP_TYPES.has(type)) return;
      titles++;
      insTitle.run(tconst, type, primary, original ?? null, num(year), num(runtime), genres === "\\N" ? null : genres ?? null);
      const a = normalizeTitle(primary);
      insKey.run(a, tconst);
      if (original && original !== primary) {
        const b = normalizeTitle(original);
        if (b !== a) insKey.run(b, tconst);
      }
    });
    log(`  title.basics: ${titles} titles (${[...KEEP_TYPES].join(", ")})`);
    if (titles < minTitles) throw new Error(`title.basics yielded only ${titles} titles; keeping the previous IMDb data`);

    let akas = 0;
    const insAka = db.prepare("INSERT OR IGNORE INTO imdb_keys_new SELECT ?, tconst FROM imdb_titles_new WHERE tconst = ?");
    // titleId ordering title region language types attributes isOriginalTitle
    await batched(db, tsvRows(gzPath("title.akas", dir)), ([tconst, , title, region]) => {
      if (tconst && title && region && AKA_REGIONS.has(region)) akas += insAka.run(normalizeTitle(title), tconst).changes;
    });
    log(`  title.akas: ${akas} extra title keys`);

    const setRating = db.prepare("UPDATE imdb_titles_new SET rating = ?, votes = ? WHERE tconst = ?");
    await batched(db, tsvRows(gzPath("title.ratings", dir)), ([tconst, rating, votes]) => {
      if (tconst) setRating.run(num(rating), num(votes), tconst);
    });
    log("  title.ratings: done");

    const setDirectors = db.prepare("UPDATE imdb_titles_new SET directors = ? WHERE tconst = ?");
    const addDirector = db.prepare("INSERT OR IGNORE INTO director_ids VALUES (?)");
    await batched(db, tsvRows(gzPath("title.crew", dir)), ([tconst, directors]) => {
      if (!tconst || !directors || directors === "\\N") return;
      if (setDirectors.run(directors, tconst).changes) for (const d of directors.split(",")) addDirector.run(d);
    });
    log("  title.crew: done");

    let names = 0;
    const insName = db.prepare("INSERT INTO imdb_names_new SELECT ?, ? WHERE EXISTS (SELECT 1 FROM director_ids WHERE nconst = ?)");
    await batched(db, tsvRows(gzPath("name.basics", dir)), ([nconst, name]) => {
      if (nconst && name) names += insName.run(nconst, name, nconst).changes;
    });
    log(`  name.basics: ${names} director names`);

    db.transaction(() => {
      drop("");
      for (const t of IMDB_TABLES) db.exec(`ALTER TABLE ${t}_new RENAME TO ${t};`);
    })();
    return { titles, names };
  } catch (e) {
    drop("_new");
    throw e;
  } finally {
    db.exec("DELETE FROM director_ids;");
  }
}
