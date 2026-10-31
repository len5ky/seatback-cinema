// Taste profiles: validation, tokens, and parsing of text Claude already fetched (CSV exports, IMDb / Letterboxd pages).
import { parseCsv } from "../../src/csv.ts";
import { parseImdbExport } from "../../src/ratings/imdb-csv.ts";
import { learnAffinities } from "../../src/rank-core.ts";

/** seen / watchlist / ratings keys are tconsts, or "Title (Year)" / "lb:<slug>" when no IMDb id is known (resolved against the catalogue). */
export interface Profile {
  seen: string[]; ratings?: Record<string, number>; watchlist?: string[];
  liked_directors?: string[]; liked_genres?: string[]; disliked_genres?: string[]; source?: string;
}
export type ProfileKind = "imdb_csv" | "letterboxd_csv" | "imdb_page" | "letterboxd_page";
export const PROFILE_KINDS: readonly ProfileKind[] = ["imdb_csv", "letterboxd_csv", "imdb_page", "letterboxd_page"];

export const PROFILE_MAX_BYTES = 64 * 1024;
export const PROFILE_TTL_SECONDS = 365 * 24 * 3600;
const KEY_MAX = 200, NAME_MAX = 100, LIST_MAX = 50, KEYS_MAX = 20_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function strings(v: unknown, field: string, maxLen: number, maxCount: number): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`profile.${field} must be a list of strings`);
  return [...new Set((v as string[]).map((s) => s.trim().slice(0, maxLen)).filter(Boolean))].slice(0, maxCount);
}

/** A clean copy with only the known fields (no free text beyond ids, names and genres). Throws a message the caller can show. */
export function validateProfile(v: unknown): Profile {
  if (!isObj(v)) throw new Error("profile must be an object like { seen: [\"tt1234567\"], ratings: { \"tt1234567\": 8 } }");
  const p: Profile = { seen: strings(v.seen, "seen", KEY_MAX, KEYS_MAX) };
  if (v.ratings !== undefined) {
    if (!isObj(v.ratings)) throw new Error("profile.ratings must be an object of { id: rating 1-10 }");
    const r: Record<string, number> = {};
    for (const [k, x] of Object.entries(v.ratings).slice(0, KEYS_MAX)) {
      if (typeof x !== "number" || !(x >= 1 && x <= 10)) throw new Error(`profile.ratings["${k.slice(0, 40)}"] must be a number from 1 to 10`);
      if (k.trim()) r[k.trim().slice(0, KEY_MAX)] = Math.round(x * 2) / 2;
    }
    p.ratings = r;
  }
  const watchlist = strings(v.watchlist, "watchlist", KEY_MAX, KEYS_MAX);
  if (watchlist.length) p.watchlist = watchlist;
  for (const f of ["liked_directors", "liked_genres", "disliked_genres"] as const) {
    const list = strings(v[f], f, NAME_MAX, LIST_MAX);
    if (list.length) p[f] = list;
  }
  if (typeof v.source === "string" && v.source.trim()) p.source = v.source.trim().slice(0, NAME_MAX);
  return p;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** 20 random base32 characters (100 bits). */
export function newToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(20))].map((b) => B32[b & 31]).join("");
}
export const TOKEN_RE = /^[a-z2-7]{20}$/;

/** Profile key for a film known only by name. */
export const titleKey = (title: string, year: number | null) => (year ? `${title} (${year})` : title);

/** Genre and director preferences learned from ratings that carry them (IMDb's export has Genres and Directors columns). */
export function preferences(films: { rating: number; genres: string[]; directors: string[] }[]): Pick<Profile, "liked_genres" | "disliked_genres" | "liked_directors"> {
  if (films.length < 5) return {};
  const m = learnAffinities(films);
  const top = (map: Map<string, { value: number; n: number }>, ok: (a: { value: number; n: number }) => boolean, n: number, dir: 1 | -1) =>
    [...map].filter(([, a]) => ok(a)).sort((a, b) => dir * (b[1].value - a[1].value)).slice(0, n).map(([k]) => k);
  const out: Pick<Profile, "liked_genres" | "disliked_genres" | "liked_directors"> = {};
  const lg = top(m.genres, (a) => a.value >= 0.5 && a.n >= 3, 5, 1);
  const dg = top(m.genres, (a) => a.value <= -0.5 && a.n >= 3, 5, -1);
  const ld = top(m.directors, (a) => a.value >= 0.8 && a.n >= 2, 10, 1);
  if (lg.length) out.liked_genres = lg;
  if (dg.length) out.disliked_genres = dg;
  if (ld.length) out.liked_directors = ld;
  return out;
}

function fromImdbCsv(text: string, list: "watched" | "watchlist"): Profile {
  const { kind, films } = parseImdbExport(text);
  if (kind === "watchlist" || list === "watchlist") return { seen: [], watchlist: films.map((f) => f.tconst), source: "imdb_csv" };
  const ratings: Record<string, number> = {};
  for (const f of films) if (f.rating !== null) ratings[f.tconst] = f.rating;
  const rated = films.filter((f): f is typeof f & { rating: number } => f.rating !== null);
  return { seen: films.map((f) => f.tconst), ratings, ...preferences(rated), source: "imdb_csv" };
}

/** ratings.csv (has Rating) or watched.csv / watchlist.csv (same columns, so `list` says which). Stars become a 10-point scale. */
function fromLetterboxdCsv(text: string, list: "watched" | "watchlist"): Profile {
  const rows = parseCsv(text);
  if (!rows.length || !("Name" in rows[0]!)) throw new Error("no Name column: is this a Letterboxd ratings.csv, watched.csv or watchlist.csv? When you send a big file in parts, start every part with the file's header line.");
  const keys: string[] = [], ratings: Record<string, number> = {};
  for (const r of rows) {
    const name = r.Name?.trim();
    if (!name) continue;
    const key = titleKey(name, Number(r.Year) || null);
    keys.push(key);
    const stars = Number(r.Rating);
    if (r.Rating && stars > 0 && stars <= 5) ratings[key] = stars * 2;
  }
  if (Object.keys(ratings).length) return { seen: keys, ratings, source: "letterboxd_csv" };
  return list === "watchlist" ? { seen: [], watchlist: keys, source: "letterboxd_csv" } : { seen: keys, source: "letterboxd_csv" };
}

/** Every value of the given keys in a JSON tree. */
function walk(v: unknown, visit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(v)) for (const x of v) walk(x, visit);
  else if (isObj(v)) { visit(v); for (const x of Object.values(v)) walk(x, visit); }
}
/** The page owner's ur id, when the page data carries it (IMDb profile pages: aboveTheFoldData.authorId). */
function imdbAuthor(data: unknown): string | null {
  let found: string | null = null;
  walk(data, (o) => { if (!found && typeof o.authorId === "string" && /^ur\d+$/.test(o.authorId)) found = o.authorId; });
  return found;
}

export const NO_SCORES_NOTE =
  "IMDb pages do not include the owner's scores, so these films count as seen only. For scores, ask for the IMDb ratings CSV export " +
  "and pass it with kind \"imdb_csv\", or call profile_from_imdb_url with the profile link, which reads the scores too.";

/**
 * IMDb ratings / watchlist / list page. Ids come from the Next.js data blob (ratings: advancedTitleSearch edges; watchlist:
 * predefinedList items), else from every /title/tt link. The owner's scores are never on the page, so no ratings are returned.
 */
function fromImdbPage(html: string, list: "watched" | "watchlist"): ProfileResult {
  const ids: string[] = [];
  const add = (id: unknown) => { if (typeof id === "string" && /^tt\d+$/.test(id) && !ids.includes(id)) ids.push(id); };
  let isWatchlist = list === "watchlist";
  let author: string | null = null;
  const blob = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (blob) {
    try {
      const data: unknown = JSON.parse(blob);
      author = imdbAuthor(data);
      walk(data, (o) => {
        const wl = o.predefinedList;
        if (isObj(wl) && isObj(wl.titleListItemSearch)) {
          isWatchlist = true;
          for (const e of Array.isArray(wl.titleListItemSearch.edges) ? wl.titleListItemSearch.edges : []) if (isObj(e) && isObj(e.listItem)) add(e.listItem.id);
        }
        const ats = o.advancedTitleSearch;
        if (isObj(ats)) for (const e of Array.isArray(ats.edges) ? ats.edges : []) if (isObj(e) && isObj(e.node) && isObj(e.node.title)) add(e.node.title.id);
      });
      if (!ids.length) walk(data, (o) => add([o.id, o.const, o.tconst, o.titleId].find((x) => typeof x === "string" && /^tt\d+$/.test(x))));
    } catch { /* fall through to links */ }
  }
  if (!ids.length) for (const m of html.matchAll(/\/title\/(tt\d{7,9})/g)) add(m[1]);
  if (!ids.length) throw new Error("no IMDb title ids found: was the page blocked or empty? Ask the user for their IMDb ratings CSV export instead.");
  const extra = author ? { imdb_user: author } : {};
  if (isWatchlist) return { seen: [], watchlist: ids, source: "imdb_page", ...extra };
  return { seen: ids, source: "imdb_page", note: NO_SCORES_NOTE, ...extra };
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** Letterboxd films / ratings / watchlist page: one poster per film with a slug, a name and maybe a rated-N class (N already out of 10). */
function fromLetterboxdPage(html: string, slugs: Record<string, string>, list: "watched" | "watchlist"): Profile {
  const keys: string[] = [], ratings: Record<string, number> = {};
  const marks = [...html.matchAll(/data-(?:film|item)-slug="([a-z0-9-]+)"|data-target-link="\/film\/([a-z0-9-]+)\/"/g)];
  const starts = marks.map((m) => Math.max(0, html.lastIndexOf("<", m.index))); // the tag holding the slug also holds the name
  const done = new Set<string>();
  marks.forEach((m, i) => {
    const slug = (m[1] ?? m[2])!;
    if (done.has(slug)) return;
    done.add(slug);
    const seg = html.slice(starts[i], starts[i + 1] ?? starts[i]! + 3000);
    const name = seg.match(/data-(?:item|film)-name="([^"]+)"/)?.[1] ?? seg.match(/<img[^>]*alt="([^"]+)"/)?.[1];
    const year = Number(seg.match(/data-film-release-year="(\d{4})"/)?.[1]) || null;
    const key = slugs[slug] ?? (name ? (year && !/\(\d{4}\)$/.test(name) ? titleKey(decode(name), year) : decode(name)) : `lb:${slug}`);
    keys.push(key);
    const r = Number(seg.match(/\brated-(\d{1,2})\b/)?.[1]);
    if (r >= 1 && r <= 10) ratings[key] = r;
  });
  if (!keys.length) throw new Error("no Letterboxd films found: was the page blocked or empty? Ask the user for their Letterboxd export (ratings.csv) instead.");
  if (list === "watchlist" && !Object.keys(ratings).length) return { seen: [], watchlist: keys, source: "letterboxd_page" };
  return { seen: keys, ratings, source: "letterboxd_page" };
}

export const TEXT_MAX = 4_000_000;

/** A parsed profile plus what the model should know about it (not stored by save_profile). */
export type ProfileResult = Profile & { note?: string; imdb_user?: string };

export function profileFromText(text: string, kind: ProfileKind, slugs: Record<string, string>, list: "watched" | "watchlist" = "watched"): ProfileResult {
  if (text.length > TEXT_MAX) throw new Error("text is over 4 MB: send one page or one CSV file at a time");
  switch (kind) {
    case "imdb_csv": return fromImdbCsv(text, list);
    case "letterboxd_csv": return fromLetterboxdCsv(text, list);
    case "imdb_page": return fromImdbPage(text, list);
    case "letterboxd_page": return fromLetterboxdPage(text, slugs, list);
  }
}

/** Union of two profiles (later ratings win), for combining several pages or files. */
export function mergeProfiles(a: Profile, b: Profile): Profile {
  const u = (x?: string[], y?: string[]) => [...new Set([...(x ?? []), ...(y ?? [])])];
  return validateProfile({
    seen: u(a.seen, b.seen), ratings: { ...a.ratings, ...b.ratings }, watchlist: u(a.watchlist, b.watchlist),
    liked_directors: u(a.liked_directors, b.liked_directors), liked_genres: u(a.liked_genres, b.liked_genres),
    disliked_genres: u(a.disliked_genres, b.disliked_genres), source: b.source ?? a.source,
  });
}
