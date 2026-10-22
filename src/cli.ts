import { parseArgs } from "node:util";
import { latestMonth, openDb } from "./db.ts";
import { fetchEmirates } from "./airlines/emirates.ts";
import { downloadImdb, loadImdb } from "./imdb.ts";
import { matchAll } from "./match.ts";
import { loadTaste, picks } from "./rank.ts";

const USAGE = `usage: bun run cli <command>
  fetch emirates [--month YYYY-MM] [--refresh]   fetch (or reuse cached) monthly catalogue
  imdb sync [--force]                            download IMDb datasets (if >7 days old) and load them
  match                                          match catalogue films to IMDb titles
  picks [--top 30] [--genre X] [--min-rating 7] [--language English] [--month YYYY-MM]
  search <title> [--month YYYY-MM]
  stats [--month YYYY-MM]`;

const { values: opt, positionals: pos } = parseArgs({
  args: Bun.argv.slice(2), allowPositionals: true,
  options: {
    month: { type: "string" }, refresh: { type: "boolean" }, force: { type: "boolean" },
    top: { type: "string" }, genre: { type: "string" }, "min-rating": { type: "string" }, language: { type: "string" },
  },
});

const db = openDb();
const currentMonth = new Date().toISOString().slice(0, 7);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
function validMonth(m: string): string {
  if (!MONTH.test(m)) throw new Error(`--month must be YYYY-MM (got "${m}")`);
  return m;
}
/** Snapshot month to query: --month (must have been fetched) or the latest snapshot. */
function month(): string {
  const m = opt.month ? validMonth(opt.month) : latestMonth(db, "emirates");
  if (!m) throw new Error("no snapshot yet: run `bun run cli fetch emirates` first");
  if (!db.query("SELECT 1 FROM snapshots WHERE airline = 'emirates' AND month = ?").get(m))
    throw new Error(`no Emirates snapshot for ${m}: run \`bun run cli fetch emirates --month ${m}\` first`);
  return m;
}
function numberOpt(name: string, value: string | undefined, fallback: number | undefined, ok: (n: number) => boolean, rule: string): number | undefined {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (value.trim() === "" || !ok(n)) throw new Error(`--${name} must be ${rule} (got "${value}")`);
  return n;
}
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");

async function main(): Promise<void> {
  const [cmd, arg] = pos;
  switch (cmd) {
    case "fetch": {
      if (arg !== "emirates") throw new Error("only `fetch emirates` is supported");
      const m = validMonth(opt.month ?? currentMonth);
      const r = await fetchEmirates(db, m, opt.refresh ?? false);
      console.log(`emirates ${m}: ${r.rows} rows -> ${r.films} films${r.cached ? " (cached raw file; --refresh to refetch)" : ""}`);
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
      const c = matchAll(db);
      const total = c.high + c.medium + c.low + c.none;
      console.log(`matched ${total} films: high ${c.high}, medium ${c.medium}, low ${c.low} (flagged, not ranked), none ${c.none}`);
      return;
    }
    case "picks": {
      const top = numberOpt("top", opt.top, 30, (n) => Number.isInteger(n) && n > 0, "a positive integer") ?? 30;
      const minRating = numberOpt("min-rating", opt["min-rating"], undefined, (n) => n >= 0 && n <= 10, "a number from 0 to 10");
      const m = month();
      const taste = await loadTaste();
      const r = picks(db, taste, { month: m, top, genre: opt.genre, language: opt.language, minRating });
      console.log(`Emirates ${m}: top ${r.picks.length} picks (excluded: ${r.excludedLow} low-confidence, ${r.unmatched} unmatched)\n`);
      r.picks.forEach((p, i) => {
        const x = p.row;
        console.log(`${String(i + 1).padStart(2)}. ${x.title}${x.start_year && !/\(\d{4}\)$/.test(x.title) ? ` (${x.start_year})` : ""}  score ${p.score.toFixed(2)}  ${x.duration ?? "?"} min  ${x.genre ?? ""}`);
        console.log(`    ${p.reasons.join(", ")}; ${x.director ?? "?"}; ${x.primary_language ?? "?"}; https://www.imdb.com/title/${x.tconst}/ (${x.confidence})`);
      });
      return;
    }
    case "search": {
      if (!arg) throw new Error("usage: search <title>");
      const rows = db.query<Record<string, string | number | null>, [string, string]>(`
        SELECT m.title, m.director, m.duration, m.genre, m.primary_language AS lang, x.confidence, x.tconst, t.primary_title AS imdb, t.start_year AS year, t.rating, t.votes, x.reasons
        FROM movies m LEFT JOIN matches x ON x.airline = m.airline AND x.track_list = m.track_list
        LEFT JOIN imdb_titles t ON t.tconst = x.tconst WHERE m.month = ? AND m.title LIKE ? ORDER BY m.title LIMIT 50`).all(month(), `%${arg}%`);
      if (!rows.length) console.log("no match in catalogue");
      for (const r of rows) {
        console.log(`${r.title} | ${r.director} | ${r.duration} min | ${r.genre} | ${r.lang}`);
        console.log(`  imdb: ${r.tconst ? `${r.imdb} (${r.year}) ${r.rating ?? "-"} / ${r.votes ?? 0} votes ${r.tconst}` : "-"} [${r.confidence ?? "unmatched"}] ${r.reasons ?? ""}`);
      }
      return;
    }
    case "stats": {
      const m = month();
      const snap = db.query<{ rows: number; films: number; fetched_at: string; source_date: string }, [string]>(
        "SELECT rows, films, fetched_at, source_date FROM snapshots WHERE airline = 'emirates' AND month = ?").get(m);
      console.log(`Emirates ${m}: ${snap?.films} films from ${snap?.rows} rows (date=${snap?.source_date}, fetched ${snap?.fetched_at})`);
      const cats = db.query<{ n: number }, [string]>("SELECT COUNT(DISTINCT category_id) AS n FROM movie_categories WHERE month = ?").get(m);
      const imdb = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM imdb_titles").get();
      console.log(`categories: ${cats?.n}; IMDb titles loaded: ${imdb?.n}`);
      const rows = db.query<{ english: number; confidence: string | null; n: number }, [string]>(`
        SELECT (m.primary_language = 'English') AS english, x.confidence, COUNT(*) AS n
        FROM movies m LEFT JOIN matches x ON x.airline = m.airline AND x.track_list = m.track_list
        WHERE m.month = ? GROUP BY 1, 2`).all(m);
      for (const [label, filter] of [["all", () => true], ["English", (e: number) => e === 1], ["non-English", (e: number) => e === 0]] as const) {
        const sel = rows.filter((r) => filter(r.english));
        const total = sel.reduce((s, r) => s + r.n, 0);
        const by = (c: string | null) => sel.filter((r) => r.confidence === c).reduce((s, r) => s + r.n, 0);
        const hm = by("high") + by("medium");
        console.log(`${label.padEnd(11)} ${String(total).padStart(5)} films | high ${pct(by("high"), total)} medium ${pct(by("medium"), total)} low ${pct(by("low"), total)} none ${pct(by("none"), total)} unmatched-yet ${pct(by(null), total)} | usable (high+medium) ${pct(hm, total)}`);
      }
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
