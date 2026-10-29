#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// Print an airline's in-flight film catalogue as a compact table for a model to reason over.
// Runs on Bun (`bun catalogue.ts`), Node >= 22.6 (`node --experimental-strip-types catalogue.ts`; flag not needed
// on Node >= 23.6) or Deno (`deno run -A catalogue.ts`). No dependencies.
//
//   catalogue.ts --list                         airlines and months in the dataset
//   catalogue.ts <airline> [YYYY-MM] [options]  one catalogue (default: the airline's latest month)
//
// options: --search <text>   only titles containing text      --genre <name>  only films with that genre
//          --max-runtime <m> only films up to m minutes        --matched       only films with an IMDb id
//          --tmdb            add TMDB vote average / count (needs TMDB_API_KEY; cached 30 days)
//          --json            raw JSON films instead of the table   --refresh  ignore the cache
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// TODO: set to the published repo, e.g. https://raw.githubusercontent.com/<owner>/<repo>/main/public
const DEFAULT_BASE_URL = "https://raw.githubusercontent.com/OWNER/REPO/main/public";
const BASE_URL = (process.env.DATASET_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
const CACHE_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "plane-movies");
const INDEX_TTL_MS = 12 * 3600 * 1000;
const TMDB_TTL_MS = 30 * 24 * 3600 * 1000;

interface Film {
  sourceId: string; title: string; year: number | null; runtime: number | null; directors: string[]; genres: string[];
  rating: string | null; languages: string[]; categories: string[]; imdbId: string | null; imdbConfidence: string | null;
  tmdbId: number | null; versions?: number; partial?: boolean;
}
interface CatalogueFile { airline: string; name: string; month: string; fetchedAt: string; count: number; films: Film[] }
interface IndexFile { generatedAt: string; airlines: { id: string; name: string; months: { month: string; count: number; fetchedAt: string; path: string }[] }[] }
interface TmdbScore { vote: number | null; votes: number | null; at: number }

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const flags = new Set(["list", "matched", "tmdb", "json", "refresh", "help"]);
  const valued = new Set(["search", "genre", "max-runtime"]);
  const opts: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const key = a.slice(2);
    if (flags.has(key)) opts[key] = true;
    else if (valued.has(key)) {
      const v = argv[++i];
      if (v === undefined) fail(`--${key} needs a value`);
      opts[key] = v;
    } else fail(`unknown option ${a}`);
  }
  return { opts, pos };
}

async function cachedJson<T>(url: string, file: string, ttlMs: number | null, refresh: boolean): Promise<T> {
  const path = join(CACHE_DIR, file);
  const fresh = existsSync(path) && (ttlMs === null || Date.now() - statSync(path).mtimeMs < ttlMs);
  if (fresh && !refresh) return JSON.parse(readFileSync(path, "utf8")) as T;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as T; // offline: stale cache beats nothing
    fail(`cannot reach ${url}: ${e instanceof Error ? e.message : e}`);
  }
  if (!res.ok) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as T;
    fail(`${url} -> HTTP ${res.status}${BASE_URL === DEFAULT_BASE_URL ? " (DATASET_BASE_URL is still the placeholder)" : ""}`);
  }
  const text = await res.text();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return JSON.parse(text) as T;
}

async function tmdbScores(films: Film[], refresh: boolean): Promise<Map<string, TmdbScore>> {
  const key = process.env.TMDB_API_KEY;
  if (!key) fail("--tmdb needs TMDB_API_KEY (free: themoviedb.org > Settings > API)");
  const path = join(CACHE_DIR, "tmdb.json");
  const cache: Record<string, TmdbScore> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const bearer = key.length > 40; // v4 read access token vs v3 api key
  const todo = [...new Set(films.map((f) => f.imdbId).filter((id): id is string => !!id))]
    .filter((id) => refresh || !cache[id] || Date.now() - cache[id]!.at > TMDB_TTL_MS);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const id = todo[next++]!;
      const url = `https://api.themoviedb.org/3/find/${id}?external_source=imdb_id${bearer ? "" : `&api_key=${key}`}`;
      try {
        const res = await fetch(url, bearer ? { headers: { Authorization: `Bearer ${key}` } } : undefined);
        if (!res.ok) continue;
        const body = (await res.json()) as { movie_results?: { vote_average?: number; vote_count?: number }[]; tv_results?: { vote_average?: number; vote_count?: number }[] };
        const hit = body.movie_results?.[0] ?? body.tv_results?.[0];
        cache[id] = { vote: hit?.vote_average ?? null, votes: hit?.vote_count ?? null, at: Date.now() };
      } catch { /* network blip: leave uncached, retry next run */ }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  if (todo.length) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(cache));
  }
  return new Map(Object.entries(cache));
}

const cell = (s: string | number | null | undefined) => (s === null || s === undefined || s === "" ? "-" : String(s).replaceAll("|", "/"));

async function main(): Promise<void> {
  const { opts, pos } = parseArgs(process.argv.slice(2));
  const refresh = opts.refresh === true;
  if (opts.help) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).slice(0, 11).map((l) => l.slice(3)).join("\n"));
    return;
  }
  const index = await cachedJson<IndexFile>(`${BASE_URL}/data/index.json`, "index.json", INDEX_TTL_MS, refresh);

  if (opts.list || !pos[0]) {
    console.log(`dataset ${BASE_URL} (generated ${index.generatedAt})`);
    console.log("airline | name | months (films)");
    for (const a of index.airlines) console.log(`${a.id} | ${a.name} | ${a.months.map((m) => `${m.month} (${m.count})`).join(", ")}`);
    if (!pos[0] && !opts.list) console.log("\nusage: catalogue.ts <airline> [YYYY-MM] [--search t] [--genre g] [--max-runtime m] [--matched] [--tmdb] [--json]");
    return;
  }

  const airline = pos[0].toLowerCase();
  const entry = index.airlines.find((a) => a.id === airline);
  if (!entry) fail(`unknown airline "${airline}"; known: ${index.airlines.map((a) => a.id).join(", ")}`);
  const months = [...entry.months].sort((a, b) => a.month.localeCompare(b.month));
  const want = pos[1];
  if (want && !/^\d{4}-(0[1-9]|1[0-2])$/.test(want)) fail(`month must be YYYY-MM (got "${want}")`);
  const m = want ? months.find((x) => x.month === want) : months.at(-1);
  if (!m) fail(`${entry.name} has no ${want} catalogue; available: ${months.map((x) => x.month).join(", ")}. Using another month is a guess: say so.`);

  // a published month never changes after the month ends, so it is cached without expiry; the current month for 12h
  const current = new Date().toISOString().slice(0, 7);
  const cat = await cachedJson<CatalogueFile>(`${BASE_URL}/data/${m.path}`, join(airline, `${m.month}.json`), m.month >= current ? INDEX_TTL_MS : null, refresh);

  let films = cat.films;
  if (typeof opts.search === "string") { const q = opts.search.toLowerCase(); films = films.filter((f) => f.title.toLowerCase().includes(q)); }
  if (typeof opts.genre === "string") { const g = opts.genre.toLowerCase(); films = films.filter((f) => f.genres.some((x) => x.toLowerCase().includes(g))); }
  if (typeof opts["max-runtime"] === "string") {
    const max = Number(opts["max-runtime"]);
    if (!Number.isFinite(max)) fail("--max-runtime must be a number of minutes");
    films = films.filter((f) => f.runtime !== null && f.runtime <= max);
  }
  if (opts.matched) films = films.filter((f) => f.imdbId);
  const tmdb = opts.tmdb ? await tmdbScores(films, refresh) : null;

  if (opts.json) {
    console.log(JSON.stringify(films.map((f) => (tmdb && f.imdbId ? { ...f, tmdb: tmdb.get(f.imdbId) ?? null } : f))));
    return;
  }
  const matched = cat.films.filter((f) => f.imdbId).length;
  console.log(`${cat.name} ${cat.month}: ${cat.count} films, ${matched} with an IMDb id, fetched ${cat.fetchedAt.slice(0, 10)}; showing ${films.length}`);
  console.log(`title | year | min | genres | imdb${tmdb ? " | tmdb (votes)" : ""}`);
  for (const f of films) {
    const row = [cell(f.title), cell(f.year), cell(f.runtime), cell(f.genres.join(", ")), cell(f.imdbId)];
    if (tmdb) {
      const s = f.imdbId ? tmdb.get(f.imdbId) : undefined;
      row.push(s?.vote ? `${s.vote.toFixed(1)} (${s.votes})` : "-");
    }
    console.log(row.join(" | "));
  }
}

await main();
