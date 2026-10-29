import { parseArgs } from "node:util";
import { existsSync, readdirSync, statSync } from "node:fs";
import { DATA_DIR, latestMonth, openDb, storeFilms } from "./db.ts";
import { adapters } from "./airlines/index.ts";
import { monthDir } from "./airlines/http.ts";
import { downloadImdb, loadImdb } from "./imdb.ts";
import { matchAll } from "./match.ts";
import { loadTaste, picks } from "./rank.ts";
import { PUBLIC_DIR, exportAll } from "./export.ts";
import { syncIds } from "./ratings/ids.ts";
import { SOURCES, syncRatings, type Source } from "./ratings/sync.ts";
import { findLetterboxdExport, importExport, loadExport, parseExport } from "./ratings/letterboxd-export.ts";
import { IMDB_RATINGS_DIR, defaultImdbExports, importImdbExport, isImdbCsv, parseImdbExport } from "./ratings/imdb-export.ts";

const USAGE = `usage: bun run cli <command>
  fetch <airline|all> [--month YYYY-MM] [--refresh]  fetch (or reuse cached) monthly catalogue
  imdb sync [--force]                                download IMDb datasets (if >7 days old) and load them
  match [--airline X]                                match catalogue films to IMDb titles
  picks [--airline emirates] [--top 30] [--genre X] [--min-rating 7] [--language English] [--month YYYY-MM]
  search <title> [--airline X]                       find a film in the latest catalogue of each airline
  stats [--airline X] [--month YYYY-MM]
  export [--month YYYY-MM] [--airline X]             write public/data/<airline>/<month>.json, ids.json, index.json
  taste import [file ...]                            import IMDb ratings/watchlist CSVs and/or a Letterboxd export zip|dir
                                                     (default: newest of each in data/imdb-ratings/ and data/letterboxd/)
  ids sync [--airline X] [--limit N]                 Wikidata crosswalk (TMDB/Letterboxd/RT/MC ids) for new matched films;
                                                     seeds from public/data/ids.json first
  ratings sync [--source tmdb|letterboxd|rt|mc|all] [--airline X] [--limit N]
                                                     fetch ratings for matched films (30-day cache; RT/MC need ids sync)
airlines: ${Object.keys(adapters).join(", ")}`;

const { values: opt, positionals: pos } = parseArgs({
  args: Bun.argv.slice(2), allowPositionals: true,
  options: {
    month: { type: "string" }, refresh: { type: "boolean" }, force: { type: "boolean" }, airline: { type: "string" },
    top: { type: "string" }, genre: { type: "string" }, "min-rating": { type: "string" }, language: { type: "string" },
    limit: { type: "string" }, source: { type: "string" },
  },
});

const db = openDb();
const RAW_DIR = `${DATA_DIR}/raw`;
const currentMonth = new Date().toISOString().slice(0, 7);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
function validMonth(m: string): string {
  if (!MONTH.test(m)) throw new Error(`--month must be YYYY-MM (got "${m}")`);
  return m;
}
function airlineOpt(id: string | undefined): string | undefined {
  if (id !== undefined && !adapters[id]) throw new Error(`unknown airline "${id}" (known: ${Object.keys(adapters).join(", ")})`);
  return id;
}
/** Airlines with at least one snapshot (optionally just one). */
function fetchedAirlines(only?: string): string[] {
  const rows = db.query<{ airline: string }, []>("SELECT DISTINCT airline FROM snapshots ORDER BY airline").all().map((r) => r.airline);
  return only ? rows.filter((a) => a === only) : rows;
}
/** Snapshot month to query: --month (must have been fetched) or the airline's latest snapshot. */
function month(airline: string): string {
  const m = opt.month ? validMonth(opt.month) : latestMonth(db, airline);
  if (!m) throw new Error(`no ${airline} snapshot yet: run \`bun run cli fetch ${airline}\` first`);
  if (!db.query("SELECT 1 FROM snapshots WHERE airline = ? AND month = ?").get(airline, m))
    throw new Error(`no ${airline} snapshot for ${m}: run \`bun run cli fetch ${airline} --month ${m}\` first`);
  return m;
}
function numberOpt(name: string, value: string | undefined, fallback: number | undefined, ok: (n: number) => boolean, rule: string): number | undefined {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (value.trim() === "" || !ok(n)) throw new Error(`--${name} must be ${rule} (got "${value}")`);
  return n;
}
const limitOpt = () => numberOpt("limit", opt.limit, undefined, (n) => Number.isInteger(n) && n > 0, "a positive integer");
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");
/** Newest mtime of the cached raw files: when the data was really fetched, even if reused from cache. */
function rawFetchedAt(dir: string): string {
  const times = existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => statSync(`${e.parentPath}/${e.name}`).mtimeMs) : [];
  return new Date(times.length ? Math.max(...times) : Date.now()).toISOString();
}

async function fetchOne(id: string, m: string): Promise<void> {
  const adapter = adapters[id]!;
  const dir = monthDir(RAW_DIR, id, m);
  const cached = !opt.refresh && existsSync(dir);
  const raw = await adapter.fetchMonth(m, { cacheDir: RAW_DIR, refresh: opt.refresh ?? false });
  const films = adapter.parse(raw);
  if (!films.length) throw new Error(`${id} ${m}: parsed 0 films, snapshot not stored`);
  storeFilms(db, adapter, m, films, dir, rawFetchedAt(dir));
  console.log(`${id} ${m}: ${films.length} films${cached ? " (cached raw files; --refresh to refetch)" : ""}`);
}

function stats(airline: string): void {
  const m = month(airline);
  const snap = db.query<{ films: number; fetched_at: string }, [string, string]>(
    "SELECT films, fetched_at FROM snapshots WHERE airline = ? AND month = ?").get(airline, m);
  const cats = db.query<{ n: number }, [string, string]>("SELECT COUNT(DISTINCT category) AS n FROM movie_categories WHERE airline = ? AND month = ?").get(airline, m);
  const withYear = db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM movies WHERE airline = ? AND month = ? AND year IS NOT NULL").get(airline, m);
  console.log(`${adapters[airline]?.name ?? airline} ${m}: ${snap?.films} films, ${cats?.n} categories, year on ${pct(withYear?.n ?? 0, snap?.films ?? 0)} (fetched ${snap?.fetched_at})`);
  const rows = db.query<{ english: number; confidence: string | null; n: number }, [string, string]>(`
    SELECT (m.primary_language = 'English') AS english, x.confidence, COUNT(*) AS n
    FROM movies m LEFT JOIN matches x ON x.airline = m.airline AND x.source_id = m.source_id
    WHERE m.airline = ? AND m.month = ? GROUP BY 1, 2`).all(airline, m);
  for (const [label, filter] of [["all", () => true], ["English", (e: number) => e === 1], ["non-English", (e: number) => e !== 1]] as const) {
    const sel = rows.filter((r) => filter(r.english));
    const total = sel.reduce((s, r) => s + r.n, 0);
    const by = (c: string | null) => sel.filter((r) => r.confidence === c).reduce((s, r) => s + r.n, 0);
    const hm = by("high") + by("medium");
    console.log(`  ${label.padEnd(11)} ${String(total).padStart(5)} films | high ${pct(by("high"), total)} medium ${pct(by("medium"), total)} low ${pct(by("low"), total)} none ${pct(by("none"), total)} unmatched-yet ${pct(by(null), total)} | usable (high+medium) ${pct(hm, total)}`);
  }
}

async function main(): Promise<void> {
  const [cmd, arg] = pos;
  switch (cmd) {
    case "fetch": {
      if (!arg || (arg !== "all" && !adapters[arg])) throw new Error(`usage: fetch <${Object.keys(adapters).join("|")}|all>`);
      const m = validMonth(opt.month ?? currentMonth);
      const ids = arg === "all" ? Object.keys(adapters) : [arg];
      let failed = 0;
      for (const id of ids) {
        try { await fetchOne(id, m); } catch (e) {
          failed++;
          console.error(`${id} ${m}: FAILED ${e instanceof Error ? e.message : e}`);
        }
      }
      if (failed) process.exitCode = 1;
      return;
    }
    case "imdb": {
      if (arg !== "sync") throw new Error("usage: imdb sync");
      const fetched = await downloadImdb(opt.force ?? false);
      console.log(fetched.length ? `downloaded: ${fetched.join(", ")}` : "datasets fresh (<7 days), skipping download");
      const t0 = performance.now();
      const r = await loadImdb(db);
      console.log(`loaded ${r.titles} titles, ${r.names} director names in ${((performance.now() - t0) / 1000).toFixed(0)}s, peak RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
      return;
    }
    case "match": {
      for (const a of fetchedAirlines(airlineOpt(opt.airline))) {
        const c = matchAll(db, a);
        const total = c.high + c.medium + c.low + c.none;
        console.log(`${a}: matched ${total} films: high ${c.high}, medium ${c.medium}, low ${c.low} (flagged, not ranked), none ${c.none}`);
      }
      return;
    }
    case "picks": {
      const airline = airlineOpt(opt.airline) ?? "emirates";
      const top = numberOpt("top", opt.top, 30, (n) => Number.isInteger(n) && n > 0, "a positive integer") ?? 30;
      const minRating = numberOpt("min-rating", opt["min-rating"], undefined, (n) => n >= 0 && n <= 10, "a number from 0 to 10");
      const m = month(airline);
      const taste = await loadTaste();
      const r = picks(db, taste, { airline, month: m, top, genre: opt.genre, language: opt.language, minRating });
      console.log(`${adapters[airline]?.name} ${m}: top ${r.picks.length} picks (excluded: ${r.excludedLow} low-confidence, ${r.unmatched} unmatched, ${r.watched} already watched)`);
      console.log(r.model
        ? `taste: ${r.model.rated} ratings (mean ${r.model.mean.toFixed(1)}/10), ${r.model.watched.size} watched, ${r.model.watchlist.size} on watchlist; taste.json as overrides\n`
        : "taste: taste.json only (no IMDb or Letterboxd export imported: `bun run cli taste import`)\n");
      r.picks.forEach((p, i) => {
        const x = p.row;
        console.log(`${String(i + 1).padStart(2)}. ${x.title} (${x.start_year ?? x.year ?? "?"})  score ${p.score.toFixed(2)}  ${x.runtime ?? "?"} min  ${x.genres ?? ""}`);
        console.log(`    ${p.reasons.join(", ")}; ${x.directors ?? "?"}; ${x.primary_language ?? "?"}; https://www.imdb.com/title/${x.tconst}/ (${x.confidence})`);
        console.log(`    sources: ${p.sources.join(" + ")}`);
      });
      return;
    }
    case "search": {
      if (!arg) throw new Error("usage: search <title>");
      let found = 0;
      for (const a of fetchedAirlines(airlineOpt(opt.airline))) {
        const rows = db.query<Record<string, string | number | null>, [string, string, string]>(`
          SELECT m.title, m.year AS ayear, m.directors, m.runtime, m.genres, m.primary_language AS lang, x.confidence, x.tconst,
                 t.primary_title AS imdb, t.start_year AS year, t.rating, t.votes, x.reasons
          FROM movies m LEFT JOIN matches x ON x.airline = m.airline AND x.source_id = m.source_id
          LEFT JOIN imdb_titles t ON t.tconst = x.tconst WHERE m.airline = ? AND m.month = ? AND m.title LIKE ? ORDER BY m.title LIMIT 50`)
          .all(a, month(a), `%${arg}%`);
        found += rows.length;
        for (const r of rows) {
          console.log(`[${a}] ${r.title}${r.ayear ? ` (${r.ayear})` : ""} | ${r.directors} | ${r.runtime} min | ${r.genres} | ${r.lang}`);
          console.log(`  imdb: ${r.tconst ? `${r.imdb} (${r.year}) ${r.rating ?? "-"} / ${r.votes ?? 0} votes ${r.tconst}` : "-"} [${r.confidence ?? "unmatched"}] ${r.reasons ?? ""}`);
        }
      }
      if (!found) console.log("no match in any catalogue");
      return;
    }
    case "stats": {
      const imdb = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM imdb_titles").get();
      console.log(`IMDb titles loaded: ${imdb?.n}`);
      const list = fetchedAirlines(airlineOpt(opt.airline));
      if (!list.length) throw new Error("no snapshot yet: run `bun run cli fetch <airline>` first");
      for (const a of list) {
        if (opt.month && !db.query("SELECT 1 FROM snapshots WHERE airline = ? AND month = ?").get(a, opt.month)) continue;
        stats(a);
      }
      return;
    }
    case "export": {
      const r = exportAll(db, { month: opt.month ? validMonth(opt.month) : undefined, airline: airlineOpt(opt.airline) });
      for (const f of r.files) console.log(`wrote ${f.path} (${f.films} films)`);
      console.log(`wrote ${r.ids.path} (${r.ids.count} ids)`);
      console.log(`wrote ${r.index}`);
      return;
    }
    case "taste": {
      if (arg !== "import") throw new Error("usage: taste import [imdb-ratings.csv|imdb-watchlist.csv|letterboxd-export.zip|dir ...]");
      let paths = pos.slice(2);
      if (!paths.length) {
        const lb = findLetterboxdExport();
        paths = [...(await defaultImdbExports()), ...(lb ? [lb] : [])];
        if (!paths.length) throw new Error(`no taste export found: drop IMDb's Your Ratings / Watchlist CSV into ${IMDB_RATINGS_DIR}/ or a Letterboxd zip into data/letterboxd/`);
      }
      for (const p of paths) {
        if (await isImdbCsv(p)) {
          const r = importImdbExport(db, parseImdbExport(await Bun.file(p).text()));
          const what = r.kind === "ratings" ? `${r.rated} rated` : `${r.watchlist} on watchlist`;
          console.log(`${p}: IMDb ${r.kind}, ${r.films} titles (${what}); ${r.inImdb} in local IMDb data, ${r.otherTypes} not films (series, episodes, shorts...)${r.skipped ? `, ${r.skipped} rows without a tt id skipped` : ""}`);
          continue;
        }
        const { path, files } = await loadExport(p);
        const r = importExport(db, parseExport(files));
        const ok = r.matched.high + r.matched.medium;
        console.log(`${path}: ${r.films} films (${r.rated} rated, ${r.watched} watched, ${r.watchlist} on watchlist)`);
        console.log(`matched to IMDb: ${ok} (${pct(ok, r.films)}; high ${r.matched.high}, medium ${r.matched.medium}), unmatched ${r.unmatched.length}`);
        if (r.unmatched.length) console.log(`unmatched (ignored for taste): ${r.unmatched.slice(0, 20).join("; ")}${r.unmatched.length > 20 ? "; ..." : ""}`);
      }
      return;
    }
    case "ratings": {
      if (arg !== "sync") throw new Error("usage: ratings sync [--source tmdb|letterboxd|rt|mc|all] [--airline X] [--limit N]");
      const src = opt.source ?? "all";
      if (src !== "all" && !(SOURCES as readonly string[]).includes(src)) throw new Error(`--source must be one of ${SOURCES.join(", ")}, all`);
      const sources = src === "all" ? [...SOURCES] : [src as Source];
      const r = await syncRatings(db, { sources, airline: airlineOpt(opt.airline), limit: limitOpt(), tmdbKey: process.env.TMDB_API_KEY || undefined, log: console.log });
      for (const [s, x] of Object.entries(r)) {
        console.log(`${s}: ${x.checked} films, ${x.cached} cached, ${x.noSlug} without a slug, ${x.fetched} fetched (${x.found} with a score), ${x.failed} failed${x.aborted ? ` [${x.aborted}]` : ""}`);
        // an aborted crawl is incomplete; a missing TMDB key under --source all is a deliberate skip
        const keySkip = s === "tmdb" && src === "all" && !process.env.TMDB_API_KEY;
        if (x.aborted && !keySkip) process.exitCode = 1;
      }
      return;
    }
    case "ids": {
      if (arg !== "sync") throw new Error("usage: ids sync [--airline X] [--limit N]");
      const r = await syncIds(db, { airline: airlineOpt(opt.airline), limit: limitOpt(), seedFile: `${PUBLIC_DIR}/ids.json`, log: console.log });
      console.log(`ids sync: ${r.seeded} seeded from ids.json, ${r.queried} tconsts queried, ${r.known} known to Wikidata (${pct(r.known, r.queried)}), ${r.failedBatches} failed batches`);
      if (r.failedBatches) process.exitCode = 1;
      return;
    }
    default:
      console.log(USAGE);
      if (cmd) process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
