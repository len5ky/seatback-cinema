// Build a taste Profile from a public IMDb or Letterboxd profile, fetched from this machine.
// Used by catalogue.ts (--imdb-url, --letterboxd-url). No dependencies; runs on Bun, Node >= 22.6 and Deno.
//
// IMDb (checked 2026-10-30): /user/<p.id|ur id>/ratings/?page=N is server-rendered with 250 titles per page in the
// __NEXT_DATA__ JSON (advancedTitleSearch: total, pageInfo.hasNextPage, edges[].node.title). The owner's own score
// is not in that HTML: the page asks api.graphql.imdb.com for it (PersonalizedUserData, otherUserId + idArray, a
// persisted query). The watchlist is /user/<id>/watchlist/?page=N (predefinedList.titleListItemSearch). IMDb's WAF
// answers scripted requests from many networks with an empty HTTP 202 (x-amzn-waf-action: challenge).
// Letterboxd: /<user>/films/page/N/ lists every logged film, 72 per page, with the owner's rating as a rated-1..10
// class (half stars, so already on a 10-point scale); /films/ratings/ redirects there. /<user>/watchlist/page/N/
// lists the watchlist. Letterboxd pages carry no IMDb id: slugs map through the dataset's ids.json where it has
// them, the rest are joined on title and year.

/** The profile shape shared with the Seatback MCP server (save_profile / picks). */
export interface Profile {
  seen: string[];
  ratings?: Record<string, number>;
  watchlist?: string[];
  liked_directors?: string[];
  liked_genres?: string[];
  disliked_genres?: string[];
  source?: string;
}

export interface TitleRef { title: string; year: number | null; rating?: number }

/** Profile plus what the skill needs locally: titles for display, and Letterboxd films with no IMDb id. */
export interface FetchedProfile extends Profile {
  titles: Record<string, TitleRef>;
  unmatched: { seen: TitleRef[]; watchlist: TitleRef[] };
  notes: string[];
  fetchedAt: string;
}

export interface ImdbItem { tconst: string; title: string; year: number | null; genres: string[]; directors: string[] }
export interface ImdbPage { kind: "ratings" | "watchlist"; userId: string | null; total: number | null; page: number; hasNext: boolean; items: ImdbItem[] }
export interface LetterboxdItem { slug: string; title: string; year: number | null; rating: number | null }
export interface LetterboxdPage { items: LetterboxdItem[]; hasNext: boolean; lastPage: number }

/** The site refused the request (bot challenge, 202/403/429) or the list is private. */
export class ProfileBlocked extends Error {
  site: "imdb" | "letterboxd";
  constructor(site: "imdb" | "letterboxd", message: string) { super(message); this.site = site; }
}

export const MAX_PAGES = 50;
export const PROFILE_TTL_MS = 24 * 3600 * 1000;
export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};
/** PersonalizedUserData persisted query as the IMDb web app sends it (2026-10-30). IMDb may rotate the hash. */
const IMDB_RATINGS_QUERY_HASH = "7c4e0771d67f21fc27fd44fc46d49cc589225a9c5e63e51cc0b8d42f39ee99cc";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };
const obj = (v: Json | undefined): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : {});
const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const str = (v: Json | undefined): string | null => (typeof v === "string" ? v : null);
const num = (v: Json | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ---- URLs ------------------------------------------------------------------------------------------------------

/** "https://www.imdb.com/user/p.xxxx/ratings/", ".../user/ur123/", or a bare p.xxxx / ur123 -> the user id. */
export function imdbUserId(input: string): string {
  const m = input.trim().match(/^(?:(?:https?:\/\/)?(?:www\.|m\.)?imdb\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?user\/)?((?:p\.[a-z0-9]+)|(?:ur\d+))(?:[/?#]|$)/i);
  if (!m) throw new Error(`not an IMDb profile URL: ${input} (expected https://www.imdb.com/user/p.xxxx/ratings/ or .../user/ur1234567/)`);
  const id = m[1]!;
  return /^ur/i.test(id) ? id.toLowerCase() : id;
}

const LB_RESERVED = new Set(["film", "films", "list", "lists", "search", "settings", "members", "journal", "about", "sign-in", "create-account", "pro", "activity"]);
/** "https://letterboxd.com/dave/films/ratings/" or a bare "dave" -> "dave". */
export function letterboxdUser(input: string): string {
  const raw = input.trim();
  const m = /^[A-Za-z0-9_]+$/.test(raw) ? [raw, raw] : raw.match(/^(?:https?:\/\/)?(?:www\.)?letterboxd\.com\/([A-Za-z0-9_]+)(?:[/?#]|$)/i);
  const user = m?.[1];
  if (!user || LB_RESERVED.has(user.toLowerCase())) throw new Error(`not a Letterboxd profile URL: ${input} (expected https://letterboxd.com/<username>/)`);
  return user;
}

// ---- parsers (pure) --------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
  if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) ? String.fromCodePoint(n) : all; }
  return ENTITIES[e.toLowerCase()] ?? all;
});

function nextData(html: string): Obj | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return obj(JSON.parse(m[1]!) as Json); } catch { return null; }
}

function imdbItem(t: Obj): ImdbItem | null {
  const tconst = str(t.id);
  if (!tconst || !/^tt\d+$/.test(tconst)) return null;
  const directors: string[] = [];
  for (const g of arr(t.principalCreditsV2)) {
    if (!/^director/i.test(str(obj(obj(g).grouping).text) ?? "")) continue;
    for (const c of arr(obj(g).credits)) { const n = str(obj(obj(obj(c).name).nameText).text); if (n) directors.push(n); }
  }
  return {
    tconst,
    title: str(obj(t.titleText).text) ?? tconst,
    year: num(obj(t.releaseYear).year),
    genres: arr(obj(t.titleGenres).genres).map((g) => str(obj(obj(g).genre).text)).filter((g): g is string => !!g),
    directors,
  };
}

/** One IMDb ratings or watchlist page. Throws ProfileBlocked on a challenge page or a private list. */
export function parseImdbPage(html: string): ImdbPage {
  const d = nextData(html);
  if (!d) throw new ProfileBlocked("imdb", "IMDb returned a page without its list data (a bot challenge, or the page layout changed)");
  const pp = obj(obj(d.props).pageProps);
  if (pp.showPrivateListMessaging === true || pp.isBlockedByViewer === true) throw new ProfileBlocked("imdb", "this IMDb list is private");
  const mcd = obj(pp.mainColumnData);
  const ratings = mcd.advancedTitleSearch !== undefined;
  const search = obj(ratings ? mcd.advancedTitleSearch : obj(mcd.predefinedList).titleListItemSearch);
  const items: ImdbItem[] = [];
  for (const e of arr(search.edges)) {
    const eo = obj(e);
    const it = imdbItem(ratings ? obj(obj(eo.node).title) : obj(eo.listItem));
    if (it) items.push(it);
  }
  if (!ratings && mcd.predefinedList === undefined) throw new ProfileBlocked("imdb", "IMDb page has no ratings or watchlist data (wrong URL, or the layout changed)");
  return {
    kind: ratings ? "ratings" : "watchlist",
    userId: str(obj(pp.aboveTheFoldData).authorId),
    total: num(search.total) ?? num(pp.totalItems),
    page: num(pp.initialPageNumber) ?? 1,
    hasNext: obj(search.pageInfo).hasNextPage === true,
    items,
  };
}

/** The PersonalizedUserData GraphQL answer -> tconst -> the profile owner's 1-10 rating. */
export function parseImdbOwnerRatings(json: string): Map<string, number> {
  const out = new Map<string, number>();
  let body: Json;
  try { body = JSON.parse(json) as Json; } catch { return out; }
  for (const t of arr(obj(obj(body).data).titles)) {
    const id = str(obj(t).id);
    const v = num(obj(obj(t).otherUserRating).value);
    if (id && v !== null && v >= 1 && v <= 10) out.set(id, v);
  }
  return out;
}

/** One Letterboxd films or watchlist page. */
export function parseLetterboxdPage(html: string): LetterboxdPage {
  const items: LetterboxdItem[] = [];
  const blocks = html.split(/<li class="(?:griditem|poster-container)[^"]*"/).slice(1);
  for (const b of blocks) {
    const slug = b.match(/data-(?:item|film)-slug="([^"]+)"/)?.[1];
    if (!slug) continue;
    const name = decodeEntities(b.match(/data-item-name="([^"]*)"/)?.[1] ?? b.match(/data-original-title="([^"]*)"/)?.[1] ?? slug);
    const ym = name.match(/^(.*) \((\d{4})\)$/);
    const r = b.match(/\brated-(\d{1,2})\b/);
    const rating = r ? Number(r[1]) : null;
    items.push({ slug, title: ym ? ym[1]! : name, year: ym ? Number(ym[2]) : null, rating: rating && rating >= 1 && rating <= 10 ? rating : null });
  }
  const pages = [...html.matchAll(/\/page\/(\d+)\//g)].map((m) => Number(m[1]));
  return { items, hasNext: /<a class="next"/.test(html), lastPage: pages.length ? Math.max(...pages) : 1 };
}

/** True when a response looks like a bot wall rather than the page. */
export function isChallenge(status: number, headers: Headers, body: string): boolean {
  if (status === 202 || status === 403 || status === 429 || status === 503) return true;
  if (headers.get("x-amzn-waf-action") || headers.get("cf-mitigated")) return true;
  return /<title>\s*(Just a moment|Attention Required|Access denied)/i.test(body);
}

// ---- taste summary ---------------------------------------------------------------------------------------------

/** Genres and directors the person rates above or below their own mean, damped so one film moves little. */
export function affinities(items: ImdbItem[], ratings: Map<string, number>) {
  const rated = items.filter((i) => ratings.has(i.tconst));
  if (rated.length < 5) return {};
  const mean = rated.reduce((s, i) => s + ratings.get(i.tconst)!, 0) / rated.length;
  const tally = (key: (i: ImdbItem) => string[]) => {
    const m = new Map<string, { sum: number; n: number }>();
    for (const i of rated) for (const k of new Set(key(i))) {
      const e = m.get(k) ?? { sum: 0, n: 0 };
      e.sum += ratings.get(i.tconst)! - mean; e.n++; m.set(k, e);
    }
    return [...m].map(([k, e]) => ({ k, a: e.sum / (e.n + 3), n: e.n }));
  };
  const genres = tally((i) => i.genres);
  const directors = tally((i) => i.directors);
  const top = (xs: { k: string; a: number }[], keep: (a: number) => boolean, dir: 1 | -1) =>
    xs.filter((x) => keep(x.a)).sort((a, b) => dir * (b.a - a.a)).slice(0, 8).map((x) => x.k);
  return {
    liked_genres: top(genres, (a) => a >= 0.25, 1),
    disliked_genres: top(genres, (a) => a <= -0.25, -1),
    liked_directors: top(directors.filter((d) => d.n >= 2), (a) => a >= 0.5, 1),
  };
}

// ---- fetching --------------------------------------------------------------------------------------------------

export interface FetchOpts {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  delayMs?: number; // between page requests; tests pass 0
  imdbOrigin?: string; // test hooks: point at a loopback server serving fixtures
  imdbGraphql?: string;
  letterboxdOrigin?: string;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getPage(url: string, site: "imdb" | "letterboxd", o: FetchOpts): Promise<string | null> {
  const f = o.fetch ?? fetch;
  let res: Response;
  try { res = await f(url, { headers: BROWSER_HEADERS, redirect: "follow" }); }
  catch (e) { throw new Error(`cannot reach ${url}: ${e instanceof Error ? e.message : String(e)}`); }
  const body = await res.text();
  if (res.status === 404) return null;
  if (isChallenge(res.status, res.headers, body)) {
    const waf = res.headers.get("x-amzn-waf-action") ?? res.headers.get("cf-mitigated");
    throw new ProfileBlocked(site, `${site === "imdb" ? "IMDb" : "Letterboxd"} refused the request (HTTP ${res.status}${waf ? `, ${waf}` : ""})`);
  }
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return body;
}

/** A refusal after page 1 keeps what was read so far and says so; on page 1 it propagates. */
function stopEarly(e: unknown, page: number, what: string, kept: number, notes: string[]): void {
  if (!(e instanceof ProfileBlocked) || page === 1) throw e;
  notes.push(`${what}: stopped at page ${page} (${e.message}); kept the first ${kept}`);
}

async function imdbList(base: string, kind: "ratings" | "watchlist", o: FetchOpts, notes: string[]) {
  const items: ImdbItem[] = [];
  const seen = new Set<string>();
  let userId: string | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1 && o.delayMs) await sleep(o.delayMs);
    let html: string | null, p: ImdbPage;
    try {
      html = await getPage(`${base}/${kind}/${page > 1 ? `?page=${page}` : ""}`, "imdb", o);
      if (html === null) { if (page === 1) throw new Error(`IMDb has no ${kind} page for this user (check the URL)`); break; }
      p = parseImdbPage(html);
    } catch (e) { stopEarly(e, page, `IMDb ${kind}`, items.length, notes); break; }
    userId ??= p.userId;
    const fresh = p.items.filter((i) => !seen.has(i.tconst));
    for (const i of fresh) { seen.add(i.tconst); items.push(i); }
    o.log?.(`IMDb ${kind}: page ${page}, ${items.length}${p.total ? ` of ${p.total}` : ""}`);
    if (!p.hasNext || !fresh.length || (p.total !== null && items.length >= p.total)) break;
    if (page === MAX_PAGES) notes.push(`IMDb ${kind}: stopped at the ${MAX_PAGES}-page limit; kept the first ${items.length}${p.total ? ` of ${p.total}` : ""}`);
  }
  return { items, userId };
}

async function imdbOwnerRatings(userId: string, ids: string[], o: FetchOpts): Promise<Map<string, number>> {
  const f = o.fetch ?? fetch;
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 250) {
    const body = {
      operationName: "PersonalizedUserData",
      variables: { locale: "en-US", idArray: ids.slice(i, i + 250), includeUserData: false, includeWatchedData: false,
        location: { postalCodeLocation: { country: "US", postalCode: "10001" } }, otherUserId: userId, fetchOtherUserRating: true },
      extensions: { persistedQuery: { version: 1, sha256Hash: IMDB_RATINGS_QUERY_HASH } },
    };
    const res = await f(o.imdbGraphql ?? "https://api.graphql.imdb.com/", {
      method: "POST",
      headers: { ...BROWSER_HEADERS, Accept: "application/json", "Content-Type": "application/json", Origin: "https://www.imdb.com", Referer: "https://www.imdb.com/" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok || isChallenge(res.status, res.headers, text)) throw new Error(`IMDb rating lookup -> HTTP ${res.status}${res.headers.get("x-amzn-waf-action") ? ", bot check" : ""}`);
    for (const [k, v] of parseImdbOwnerRatings(text)) out.set(k, v);
    if (o.delayMs && i + 250 < ids.length) await sleep(o.delayMs);
  }
  return out;
}

/** Ratings and watchlist of a public IMDb profile. Throws ProfileBlocked when IMDb challenges the request. */
export async function fetchImdbProfile(url: string, o: FetchOpts = {}): Promise<FetchedProfile> {
  const id = imdbUserId(url);
  const base = `${(o.imdbOrigin ?? "https://www.imdb.com").replace(/\/+$/, "")}/user/${id}`;
  const notes: string[] = [];
  const rated = await imdbList(base, "ratings", o, notes);
  let watch: ImdbItem[] = [];
  try { watch = (await imdbList(base, "watchlist", o, notes)).items; }
  catch (e) { if (e instanceof ProfileBlocked) notes.push(`watchlist skipped (${e.message})`); else throw e; }
  const userId = rated.userId ?? (id.startsWith("ur") ? id : null);
  let ratings = new Map<string, number>();
  if (userId && rated.items.length) {
    let failed = false;
    try { ratings = await imdbOwnerRatings(userId, rated.items.map((i) => i.tconst), o); }
    catch (e) { failed = true; notes.push(`could not read the scores themselves (${e instanceof Error ? e.message : String(e)}); rated films still count as seen`); }
    if (!ratings.size && !failed) notes.push("IMDb returned no scores for the rated films; they still count as seen");
  }
  const titles: Record<string, TitleRef> = {};
  for (const i of [...rated.items, ...watch]) titles[i.tconst] = { title: i.title, year: i.year, ...(ratings.has(i.tconst) ? { rating: ratings.get(i.tconst)! } : {}) };
  return {
    seen: rated.items.map((i) => i.tconst),
    ...(ratings.size ? { ratings: Object.fromEntries(ratings) } : {}),
    watchlist: watch.map((i) => i.tconst),
    ...affinities(rated.items, ratings),
    source: `imdb:${id}`,
    titles, unmatched: { seen: [], watchlist: [] }, notes, fetchedAt: new Date().toISOString(),
  };
}

async function letterboxdList(base: string, path: "films" | "watchlist", o: FetchOpts, notes: string[]): Promise<LetterboxdItem[]> {
  const items: LetterboxdItem[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1 && o.delayMs) await sleep(o.delayMs);
    let html: string | null;
    try {
      html = await getPage(`${base}/${path}/${page > 1 ? `page/${page}/` : ""}`, "letterboxd", o);
    } catch (e) { stopEarly(e, page, `Letterboxd ${path}`, items.length, notes); break; }
    if (html === null) { if (page === 1) throw new Error(`Letterboxd has no ${path} page for this user (check the username)`); break; }
    const p = parseLetterboxdPage(html);
    const fresh = p.items.filter((i) => !seen.has(i.slug));
    for (const i of fresh) { seen.add(i.slug); items.push(i); }
    o.log?.(`Letterboxd ${path}: page ${page} of ${p.lastPage}, ${items.length} films`);
    if (!p.hasNext || !fresh.length || page >= p.lastPage) break;
    if (page === MAX_PAGES) notes.push(`Letterboxd ${path}: stopped at the ${MAX_PAGES}-page limit of ${p.lastPage}; kept the first ${items.length}`);
  }
  return items;
}

/**
 * Logged films and watchlist of a public Letterboxd profile. `slugToImdb` (from the dataset's ids.json) turns
 * Letterboxd slugs into IMDb ids where it can; everything else stays in `unmatched` for the title/year join.
 */
export async function fetchLetterboxdProfile(url: string, slugToImdb: Map<string, string>, o: FetchOpts = {}): Promise<FetchedProfile> {
  const user = letterboxdUser(url);
  const base = `${(o.letterboxdOrigin ?? "https://letterboxd.com").replace(/\/+$/, "")}/${user}`;
  const notes: string[] = [];
  const films = await letterboxdList(base, "films", o, notes);
  let watch: LetterboxdItem[] = [];
  try { watch = await letterboxdList(base, "watchlist", o, notes); }
  catch (e) { if (e instanceof ProfileBlocked) notes.push(`watchlist skipped (${e.message})`); else throw e; }
  const seen: string[] = [], watchlist: string[] = [], ratings: Record<string, number> = {}, titles: Record<string, TitleRef> = {};
  const unmatched: FetchedProfile["unmatched"] = { seen: [], watchlist: [] };
  for (const [list, ids, miss] of [[films, seen, unmatched.seen], [watch, watchlist, unmatched.watchlist]] as const) {
    for (const f of list) {
      const ref: TitleRef = { title: f.title, year: f.year, ...(f.rating ? { rating: f.rating } : {}) };
      const tt = slugToImdb.get(f.slug);
      if (!tt) { miss.push(ref); continue; }
      ids.push(tt); titles[tt] = ref;
      if (f.rating && list === films) ratings[tt] = f.rating;
    }
  }
  return {
    seen, ...(Object.keys(ratings).length ? { ratings } : {}), watchlist, source: `letterboxd:${user}`,
    titles, unmatched, notes, fetchedAt: new Date().toISOString(),
  };
}

/** Two lines for the model and the person when a profile page refuses us. */
export function blockedHelp(site: "imdb" | "letterboxd", reason: string): string {
  return site === "imdb"
    ? `${reason}. Use the CSV export instead: open https://www.imdb.com/list/ratings/export (and your Watchlist's Export), download the files from Your exports,\n` +
      `then rerun with --taste <folder with the CSVs> in place of --imdb-url.`
    : `${reason}. Use the export instead: letterboxd.com, Settings, Data, Export your data; unzip the download,\n` +
      `then rerun with --taste <unzipped folder> in place of --letterboxd-url.`;
}
