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
//          --family          only family, kids and animation films (each airline names these genres differently)
//          --taste <path>    IMDb / Letterboxd CSV export (file or folder): hide seen films, flag the watchlist
//          --imdb-url <url>  public IMDb profile (https://www.imdb.com/user/p.xxxx/ratings/): ratings + watchlist
//          --letterboxd-url <url>  public Letterboxd profile (https://letterboxd.com/<user>/): films + watchlist
//                            (both fetched from this machine, cached 24 h; combine freely with --taste)
//          --save-profile    save the profile built from the options above on the Seatback server, print its token
//                            (for the Claude app: "My Seatback Cinema taste code is <token>.")
//          --profile-token <t>  use a profile saved with --save-profile (or by the Claude app's connector)
//          --tmdb            add TMDB vote average / count (needs TMDB_API_KEY; cached 30 days)
//          --base <url|dir>  dataset location (also SEATBACK_DATASET_URL; default https://seatback.len5ky.com):
//                            https://..., http://localhost:4173, a local public/ folder or file:///.../public
//          --json            raw JSON films instead of the table   --refresh  ignore the cache
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blockedHelp, fetchImdbProfile, fetchLetterboxdProfile, type FetchedProfile, type FetchOpts, imdbUserId, letterboxdUser, type Profile,
  permanentNote, PROFILE_TTL_MS, type TitleRef, ProfileBlocked } from "./profile.ts";
import { getProfile, pasteSentence, saveProfile } from "./seatback.ts";

const DEFAULT_BASE_URL = "https://seatback.len5ky.com";
const CACHE_ROOT = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "inflight-movie-picker");
let BASE = DEFAULT_BASE_URL; // set in main(): a URL, or a local directory when LOCAL
let LOCAL = false;
let CACHE_DIR = CACHE_ROOT; // the default dataset caches at the root, any other URL in its own subfolder
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

/** Exit with a message, unless a stale cached value can stand in (then warn and return it). */
function fail(msg: string): never;
function fail<T>(msg: string, fallback: T | undefined): T;
function fail<T>(msg: string, fallback?: T): T {
  if (fallback !== undefined) { console.error(`${msg}; using the cached copy`); return fallback; }
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const flags = new Set(["list", "matched", "family", "tmdb", "json", "refresh", "help", "save-profile"]);
  const valued = new Set(["search", "genre", "max-runtime", "base", "taste", "imdb-url", "letterboxd-url", "profile-token"]);
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

function readCache<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; } // missing or corrupt: refetch
}

/** --base, then SEATBACK_DATASET_URL (DATASET_BASE_URL is the older name), then the published dataset. */
function resolveBase(flag: string | undefined): void {
  const raw = (flag ?? process.env.SEATBACK_DATASET_URL ?? process.env.DATASET_BASE_URL ?? DEFAULT_BASE_URL).trim();
  if (/^https?:\/\//i.test(raw)) {
    BASE = raw.replace(/\/+$/, "");
    if (BASE !== DEFAULT_BASE_URL) CACHE_DIR = join(CACHE_ROOT, BASE.replace(/^https?:\/\//i, "").replace(/[^\w.-]+/g, "_"));
    return;
  }
  const dir = resolve(raw.startsWith("file:") ? fileURLToPath(raw) : raw);
  // accept the public/ folder itself or a checkout of the repo that contains it
  const root = [dir, join(dir, "public")].find((d) => existsSync(join(d, "data", "index.json")));
  if (!root) fail(`no data/index.json under ${dir}: point --base or SEATBACK_DATASET_URL at the dataset's public/ folder`);
  BASE = root;
  LOCAL = true;
}

/** A local dataset is read straight from disk, no cache. */
async function datasetJson<T>(rel: string, cacheFile: string, ttlMs: number | null, refresh: boolean): Promise<T> {
  if (!LOCAL) return cachedJson<T>(`${BASE}/${rel}`, cacheFile, ttlMs, refresh);
  const path = join(BASE, rel);
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return fail(`${path} is missing`); }
  try { return JSON.parse(text) as T; } catch { return fail(`${path} is not valid JSON`); }
}

async function cachedJson<T>(url: string, file: string, ttlMs: number | null, refresh: boolean): Promise<T> {
  const path = join(CACHE_DIR, file);
  const fresh = existsSync(path) && (ttlMs === null || Date.now() - statSync(path).mtimeMs < ttlMs);
  if (fresh && !refresh) {
    const hit = readCache<T>(path);
    if (hit !== undefined) return hit;
  }
  const stale = () => (existsSync(path) ? readCache<T>(path) : undefined); // offline or broken upstream: stale cache beats nothing
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    return fail(`cannot reach ${url}: ${e instanceof Error ? e.message : e}`, stale());
  }
  if (!res.ok) {
    const hint = res.status === 404 || res.status === 403
      ? " (nothing is published at this address, or the path is wrong. Point --base or" +
        " SEATBACK_DATASET_URL at another copy: a local public/ folder, or http://localhost:4173 from `bun run serve`" +
        " in a checkout)"
      : "";
    return fail(`${url} -> HTTP ${res.status}${hint}`, stale());
  }
  const text = await res.text();
  let body: T;
  try { body = JSON.parse(text) as T; } catch { return fail(`${url} did not return JSON (${text.slice(0, 80).replace(/\s+/g, " ")})`, stale()); }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text); // only after it parsed, so a bad response never poisons the cache
  return body;
}

const TMDB_CONCURRENCY = 4;
const TMDB_GAP_MS = 100; // <= 10 requests/s, well under TMDB's ~40/s

async function tmdbScores(films: Film[], refresh: boolean): Promise<Map<string, TmdbScore>> {
  const key = process.env.TMDB_API_KEY;
  if (!key) fail("--tmdb needs TMDB_API_KEY (free: themoviedb.org > Settings > API)");
  const path = join(CACHE_DIR, "tmdb.json");
  const cache: Record<string, TmdbScore> = (existsSync(path) && readCache<Record<string, TmdbScore>>(path)) || {};
  const bearer = key.length > 40; // v4 read access token vs v3 api key
  const todo = [...new Set(films.map((f) => f.imdbId).filter((id): id is string => !!id))]
    .filter((id) => refresh || !cache[id] || Date.now() - cache[id]!.at > TMDB_TTL_MS);
  let next = 0, failed = 0, slot = Date.now();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // every request takes the next start slot, so all workers together stay under 10/s
  const paced = async () => { const wait = (slot = Math.max(slot + TMDB_GAP_MS, Date.now())) - Date.now(); if (wait > 0) await sleep(wait); };
  const worker = async () => {
    while (next < todo.length) {
      const id = todo[next++]!;
      const url = `https://api.themoviedb.org/3/find/${id}?external_source=imdb_id${bearer ? "" : `&api_key=${key}`}`;
      try {
        await paced();
        let res = await fetch(url, bearer ? { headers: { Authorization: `Bearer ${key}` } } : undefined);
        if (res.status === 429) {
          await sleep(Math.min(Number(res.headers.get("retry-after")) || 2, 30) * 1000);
          res = await fetch(url, bearer ? { headers: { Authorization: `Bearer ${key}` } } : undefined);
        }
        if (res.status === 401) fail("TMDB rejected TMDB_API_KEY (401): check the key");
        if (!res.ok) { failed++; continue; }
        const body = (await res.json()) as { movie_results?: { vote_average?: number; vote_count?: number }[]; tv_results?: { vote_average?: number; vote_count?: number }[] };
        const hit = body.movie_results?.[0] ?? body.tv_results?.[0];
        cache[id] = { vote: hit?.vote_average ?? null, votes: hit?.vote_count ?? null, at: Date.now() };
      } catch { failed++; /* network blip: leave uncached, retry next run */ }
    }
  };
  await Promise.all(Array.from({ length: TMDB_CONCURRENCY }, worker));
  if (failed) console.error(`TMDB: ${failed}/${todo.length} lookups failed; those films show "-" (retried next run)`);
  if (todo.length) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(cache));
  }
  return new Map(Object.entries(cache));
}

// ---- taste: IMDb and Letterboxd CSV exports -------------------------------------------------------------------

interface Taste { seenIds: Set<string>; watchIds: Set<string>; seenKeys: Map<string, (number | null)[]>; watchKeys: Map<string, (number | null)[]>;
  rated: { title: string; year: number | null; rating: number }[]; files: string[]; seen: number; watchlist: number;
  /** For --save-profile: IMDb-id ratings, films known only by name ("Title (Year)", the server's key), learned preferences. */
  ratings: Map<string, number>; named: { seen: string[]; watchlist: string[] }; prefs: Pick<Profile, "liked_genres" | "disliked_genres" | "liked_directors"> }

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, newlines inside quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** Title key for the Letterboxd join: lowercase, no accents or punctuation, no leading article. */
const titleKey = (t: string) => t.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ")
  .replace(/['\u2019]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/^(the|a|an) /, "");

function csvFiles(path: string): string[] {
  if (/\.zip$/i.test(path)) fail(`${path} is a zip: unzip it first (unzip "${path}" -d letterboxd) and pass the folder`);
  if (!existsSync(path)) fail(`--taste: ${path} does not exist`);
  if (!statSync(path).isDirectory()) return [path];
  const out: string[] = [];
  for (const e of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    if (e.isFile() && /\.csv$/i.test(e.name)) out.push(p);
    else if (e.isDirectory()) for (const f of readdirSync(p)) if (/\.csv$/i.test(f)) out.push(join(p, f)); // one level down
  }
  return out;
}

const emptyTaste = (): Taste => ({ seenIds: new Set(), watchIds: new Set(), seenKeys: new Map(), watchKeys: new Map(), rated: [], files: [], seen: 0, watchlist: 0,
  ratings: new Map(), named: { seen: [], watchlist: [] }, prefs: {} });
/** A film known only by title (Letterboxd): joined on title key here, saved under "Title (Year)". */
function addNamed(t: Taste, list: "seen" | "watchlist", title: string, year: number | null): void {
  const k = titleKey(title); if (!k) return;
  const m = list === "seen" ? t.seenKeys : t.watchKeys;
  m.set(k, [...(m.get(k) ?? []), year]);
  t.named[list].push(year ? `${title} (${year})` : title);
}

function loadTaste(path: string, t: Taste = emptyTaste()): Taste {
  for (const file of csvFiles(path)) {
    const [head, ...rows] = parseCsv(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (!head) continue;
    const col = (name: string) => head.findIndex((h) => h.trim().toLowerCase() === name);
    const [iConst, iMine, iTitle, iYear, iName, iUri, iRating] =
      [col("const"), col("your rating"), col("title"), col("year"), col("name"), col("letterboxd uri"), col("rating")];
    const year = (r: string[], i: number) => { const y = Number(r[i]); return i >= 0 && Number.isInteger(y) && y > 1800 ? y : null; };
    if (iConst >= 0) { // IMDb: ratings export has "Your Rating", the watchlist export does not
      const watch = iMine < 0;
      for (const r of rows) {
        const id = r[iConst]?.trim(); if (!id?.startsWith("tt")) continue;
        if (watch) { t.watchIds.add(id); t.watchlist++; continue; }
        t.seenIds.add(id); t.seen++;
        const rating = Number(r[iMine]);
        if (rating >= 1 && rating <= 10) t.ratings.set(id, rating);
        if (rating > 0 && iTitle >= 0) t.rated.push({ title: r[iTitle]!, year: year(r, iYear), rating });
      }
    } else if (iName >= 0 && iUri >= 0) { // Letterboxd: watchlist.csv, or ratings/watched/diary/reviews (all seen)
      const watch = /^watchlist/i.test(basename(file));
      for (const r of rows) {
        const name = r[iName]?.trim(); if (!name) continue;
        const y = year(r, iYear);
        if (watch) { addNamed(t, "watchlist", name, y); t.watchlist++; continue; }
        addNamed(t, "seen", name, y); t.seen++;
        const stars = iRating >= 0 ? Number(r[iRating]) : 0;
        if (stars > 0) t.rated.push({ title: name, year: y, rating: stars * 2 });
      }
    } else continue; // not an export we know
    t.files.push(basename(file));
  }
  if (!t.files.length) fail(`--taste: no IMDb (Const column) or Letterboxd (Name, Letterboxd URI columns) CSV found at ${path}`);
  return t;
}

/** Fold a fetched IMDb / Letterboxd profile into the taste: ids join exactly, unmatched Letterboxd films on title. */
function addProfile(t: Taste, p: FetchedProfile): void {
  for (const id of p.seen) t.seenIds.add(id);
  for (const id of p.watchlist ?? []) t.watchIds.add(id);
  for (const r of p.unmatched.seen) addNamed(t, "seen", r.title, r.year);
  for (const r of p.unmatched.watchlist) addNamed(t, "watchlist", r.title, r.year);
  for (const [id, rating] of Object.entries(p.ratings ?? {})) {
    t.ratings.set(id, rating);
    const ref = p.titles[id];
    if (ref) t.rated.push({ title: ref.title, year: ref.year, rating });
  }
  for (const f of ["liked_genres", "disliked_genres", "liked_directors"] as const)
    if (p[f]?.length) t.prefs[f] = [...new Set([...(t.prefs[f] ?? []), ...p[f]])];
  for (const r of p.unmatched.seen) if (r.rating) t.rated.push({ title: r.title, year: r.year, rating: r.rating });
  t.seen += p.seen.length + p.unmatched.seen.length;
  t.watchlist += (p.watchlist?.length ?? 0) + p.unmatched.watchlist.length;
  t.files.push(p.source ?? "profile");
}

/** A saved profile (--profile-token): ids only, so seen keys that aren't IMDb ids join on title like Letterboxd rows. */
function addSaved(t: Taste, p: Profile, label: string): void {
  const split = (keys: string[]) => {
    const ids: string[] = [], named: TitleRef[] = [];
    for (const k of keys) {
      if (/^tt\d+$/.test(k)) { ids.push(k); continue; }
      const m = /^(.*) \((\d{4})\)$/.exec(k);
      named.push(m ? { title: m[1]!, year: Number(m[2]) } : { title: k, year: null });
    }
    return { ids, named };
  };
  const seen = split([...new Set([...p.seen, ...Object.keys(p.ratings ?? {})])]), watch = split(p.watchlist ?? []);
  const ratings = Object.fromEntries(Object.entries(p.ratings ?? {}).filter(([k]) => /^tt\d+$/.test(k)));
  addProfile(t, { ...p, seen: seen.ids, watchlist: watch.ids, ratings, source: label, titles: {}, unmatched: { seen: seen.named, watchlist: watch.named }, notes: [], fetchedAt: "" });
}

/** The taste as the server's Profile, for --save-profile. */
function toProfile(t: Taste): Profile {
  const ids = (s: Set<string>) => [...s].filter((x) => /^tt\d+$/.test(x));
  return {
    seen: [...ids(t.seenIds), ...t.named.seen],
    ...(t.ratings.size ? { ratings: Object.fromEntries(t.ratings) } : {}),
    watchlist: [...ids(t.watchIds), ...t.named.watchlist],
    ...t.prefs,
    source: t.files.join(", "),
  };
}

/** The Seatback MCP server sits next to the published dataset; a local dataset has none. */
function mcpBase(flag: string): string {
  if (LOCAL) fail(`--${flag} talks to the Seatback server: use an https --base (the default is ${DEFAULT_BASE_URL}), not a local folder`);
  return BASE;
}

/** Test hooks (undocumented): serve fixtures from a loopback server instead of imdb.com / letterboxd.com. */
function profileFetchOpts(): FetchOpts {
  const env = process.env;
  return {
    delayMs: env.INFLIGHT_PROFILE_DELAY_MS !== undefined ? Number(env.INFLIGHT_PROFILE_DELAY_MS) : 1000,
    ...(env.INFLIGHT_IMDB_ORIGIN ? { imdbOrigin: env.INFLIGHT_IMDB_ORIGIN } : {}),
    ...(env.INFLIGHT_IMDB_GRAPHQL ? { imdbGraphql: env.INFLIGHT_IMDB_GRAPHQL } : {}),
    ...(env.INFLIGHT_LETTERBOXD_ORIGIN ? { letterboxdOrigin: env.INFLIGHT_LETTERBOXD_ORIGIN } : {}),
    log: (m) => console.error(m),
  };
}

/** A profile fetched in the last 24 h is reused; a refusal prints the export route and exits. */
async function loadProfile(site: "imdb" | "letterboxd", url: string, refresh: boolean): Promise<FetchedProfile> {
  let key: string;
  try { key = site === "imdb" ? imdbUserId(url) : letterboxdUser(url).toLowerCase(); }
  catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
  const path = join(CACHE_ROOT, "profiles", `${site}-${key.replace(/[^\w.-]+/g, "_")}.json`);
  if (!refresh && existsSync(path) && Date.now() - statSync(path).mtimeMs < PROFILE_TTL_MS) {
    const hit = readCache<FetchedProfile>(path);
    if (hit?.seen) return hit;
  }
  const opts = profileFetchOpts();
  let p: FetchedProfile;
  try {
    if (site === "imdb") p = await fetchImdbProfile(url, opts);
    else {
      const ids = await datasetJson<Record<string, { letterboxd?: string }>>("data/ids.json", "ids.json", INDEX_TTL_MS, refresh);
      const slugs = new Map<string, string>();
      for (const [tt, x] of Object.entries(ids)) if (x.letterboxd) slugs.set(x.letterboxd, tt);
      p = await fetchLetterboxdProfile(url, slugs, opts);
    }
  } catch (e) {
    if (e instanceof ProfileBlocked) { console.error(blockedHelp(e.site, e.message)); process.exit(1); }
    return fail(e instanceof Error ? e.message : String(e));
  }
  // A partial profile (a block partway, scores unreadable) is not cached, so the next run tries again;
  // one cut at the page cap, scoreless or with a private watchlist is, since a refetch would say the same.
  if (p.notes.every(permanentNote)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(p));
  }
  return p;
}

/** Joined on the IMDb id where we have one, else on title key with years within 1 (or a missing year: Emirates). */
function tasteHit(f: Film, ids: Set<string>, keys: Map<string, (number | null)[]>): boolean {
  if (f.imdbId && ids.has(f.imdbId)) return true;
  const years = keys.get(titleKey(f.title));
  return !!years?.some((y) => y === null || f.year === null || Math.abs(y - f.year) <= 1);
}

const cell = (s: string | number | null | undefined) => (s === null || s === undefined || s === "" ? "-" : String(s).replaceAll("|", "/"));

async function main(): Promise<void> {
  const { opts, pos } = parseArgs(process.argv.slice(2));
  const refresh = opts.refresh === true;
  if (opts.help) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).slice(0, 21).map((l) => l.slice(3)).join("\n"));
    return;
  }
  resolveBase(typeof opts.base === "string" ? opts.base : undefined);
  const index = await datasetJson<IndexFile>("data/index.json", "index.json", INDEX_TTL_MS, refresh);

  if (opts.list || !pos[0]) {
    console.log(`dataset ${BASE} (generated ${index.generatedAt})`);
    console.log("airline | name | months (films)");
    for (const a of index.airlines) console.log(`${a.id} | ${a.name} | ${a.months.map((m) => `${m.month} (${m.count})`).join(", ")}`);
    if (!pos[0] && !opts.list) console.log("\nusage: catalogue.ts <airline> [YYYY-MM] [--search t] [--genre g] [--max-runtime m] [--family] [--matched] [--taste path] [--imdb-url url] [--letterboxd-url url] [--profile-token t] [--save-profile] [--tmdb] [--base url|dir] [--json]");
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
  const cat = await datasetJson<CatalogueFile>(`data/${m.path}`, join(airline, `${m.month}.json`), m.month >= current ? INDEX_TTL_MS : null, refresh);

  let films = cat.films;
  if (typeof opts.search === "string") { const q = opts.search.toLowerCase(); films = films.filter((f) => f.title.toLowerCase().includes(q)); }
  if (typeof opts.genre === "string") { const g = opts.genre.toLowerCase(); films = films.filter((f) => f.genres.some((x) => x.toLowerCase().includes(g))); }
  if (typeof opts["max-runtime"] === "string") {
    const max = Number(opts["max-runtime"]);
    if (!Number.isFinite(max)) fail("--max-runtime must be a number of minutes");
    films = films.filter((f) => f.runtime !== null && f.runtime <= max);
  }
  if (opts.matched) films = films.filter((f) => f.imdbId);
  if (opts.family) films = films.filter((f) => f.genres.some((g) => /famil|kid|child|anim|cartoon/i.test(g)));
  let taste: Taste | null = typeof opts.taste === "string" ? loadTaste(opts.taste) : null;
  const notes: string[] = [];
  for (const [flag, site] of [["imdb-url", "imdb"], ["letterboxd-url", "letterboxd"]] as const) {
    const url = opts[flag];
    if (typeof url !== "string") continue;
    const p = await loadProfile(site, url, refresh);
    taste ??= emptyTaste();
    addProfile(taste, p);
    notes.push(...p.notes.map((n) => `${p.source}: ${n}`));
  }
  if (typeof opts["profile-token"] === "string") {
    let p: Profile;
    try { p = await getProfile(mcpBase("profile-token"), opts["profile-token"]); }
    catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
    taste ??= emptyTaste();
    addSaved(taste, p, `saved profile${p.source ? ` (${p.source})` : ""}`);
  }
  let saved: string[] = [];
  if (opts["save-profile"]) {
    if (!taste) fail("--save-profile needs a profile to save: add --imdb-url, --letterboxd-url, --taste or --profile-token");
    let r: Awaited<ReturnType<typeof saveProfile>>;
    try { r = await saveProfile(mcpBase("save-profile"), toProfile(taste)); }
    catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
    if (r.dropped) notes.push(`saved profile: over the server's 64 KB limit, so it left out the ${r.dropped}`);
    saved = [`taste code: ${r.token} (kept for a year)`, `for the Claude app, paste: ${pasteSentence(r.token)}`];
  }
  let hidden = 0;
  if (taste) {
    const before = films.length;
    films = films.filter((f) => !tasteHit(f, taste.seenIds, taste.seenKeys));
    hidden = before - films.length;
  }
  const onWatchlist = (f: Film) => !!taste && tasteHit(f, taste.watchIds, taste.watchKeys);
  const tmdb = opts.tmdb ? await tmdbScores(films, refresh) : null;

  if (opts.json) {
    console.log(JSON.stringify(films.map((f) => ({
      ...f,
      ...(tmdb && f.imdbId ? { tmdb: tmdb.get(f.imdbId) ?? null } : {}),
      ...(taste ? { watchlist: onWatchlist(f) } : {}),
    }))));
    for (const l of saved) console.error(l); // stdout stays JSON
    return;
  }
  const matched = cat.films.filter((f) => f.imdbId).length;
  console.log(`${cat.name} ${cat.month}: ${cat.count} films, ${matched} with an IMDb id, fetched ${cat.fetchedAt.slice(0, 10)}; showing ${films.length}`);
  if (taste) {
    const fmt = (r: Taste["rated"][number]) => `${r.title}${r.year ? ` (${r.year})` : ""} ${r.rating}`;
    const loved = taste.rated.filter((r) => r.rating >= 9).slice(0, 20);
    const hated = taste.rated.filter((r) => r.rating <= 4).slice(0, 10);
    console.log(`taste (${taste.files.join(", ")}): ${taste.seen} seen, ${taste.watchlist} on the watchlist; hid ${hidden} seen films`);
    if (loved.length) console.log(`loved (9-10/10): ${loved.map(fmt).join("; ")}`);
    if (hated.length) console.log(`disliked (1-4/10): ${hated.map(fmt).join("; ")}`);
    const pr = taste.prefs; // a saved profile has ids, not titles: show what it learned instead
    if (!loved.length && (pr.liked_genres || pr.disliked_genres || pr.liked_directors))
      console.log([pr.liked_genres && `liked genres: ${pr.liked_genres.join(", ")}`, pr.disliked_genres && `disliked genres: ${pr.disliked_genres.join(", ")}`,
        pr.liked_directors && `liked directors: ${pr.liked_directors.join(", ")}`].filter(Boolean).join("; "));
    for (const n of notes) console.log(`note: ${n}`);
  }
  // imdb is the id, with "(medium)" when the match rests on one signal; cert is the airline's own age rating
  console.log(`title | year | min | genres | cert | imdb${taste ? " | you" : ""}${tmdb ? " | tmdb (votes)" : ""}`);
  for (const f of films) {
    const imdb = f.imdbId ? `${f.imdbId}${f.imdbConfidence === "medium" ? " (medium)" : ""}` : null;
    const row = [cell(f.title), cell(f.year), cell(f.runtime), cell(f.genres.join(", ")), cell(f.rating), cell(imdb)];
    if (taste) row.push(onWatchlist(f) ? "watchlist" : "-");
    if (tmdb) {
      const s = f.imdbId ? tmdb.get(f.imdbId) : undefined;
      row.push(s?.vote ? `${s.vote.toFixed(1)} (${s.votes})` : "-");
    }
    console.log(row.join(" | "));
  }
  if (saved.length) console.log(["", ...saved].join("\n")); // last, so it is the first thing a person sees
}

await main();
