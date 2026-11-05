// Build a taste Profile from a public IMDb or Letterboxd profile, fetched from this machine.
// Used by catalogue.ts (--imdb-url, --letterboxd-url). No dependencies; runs on Bun, Node >= 22.6 and Deno.
//
// IMDb, first route (probed 2026-10-30, tmp/w2/imdb-graphql-probe.md): raw GraphQL POSTs to api.graphql.imdb.com,
// the calls imdb.com itself makes. userProfile(input: { profileId }) turns a p. id into the ur id; advancedTitleSearch
// with singleUserRatingConstraint lists the ratings, 250 a page via jumpToPosition (several pages per request as
// aliases); predefinedList(classType: WATCH_LIST) lists the watchlist (listItem is a client alias for title). The
// owner's scores need the persisted PersonalizedUserData query (otherUserId + idArray, 250 ids a call).
// IMDb, fallback route: /user/<p.id|ur id>/ratings/?page=N is server-rendered with 250 titles per page in the
// __NEXT_DATA__ JSON (advancedTitleSearch: total, pageInfo.hasNextPage, edges[].node.title); the watchlist is
// /user/<id>/watchlist/?page=N (predefinedList.titleListItemSearch). IMDb's WAF answers scripted page requests from
// many networks with an empty HTTP 202 (x-amzn-waf-action: challenge).
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

/** A note a refetch would only repeat (the page cap, a scoreless profile, a private watchlist), unlike a network blip,
 *  a block or a 429 partway. A profile whose notes are all permanent is cached like a clean one. */
export const permanentNote = (note: string) =>
  /-page limit/.test(note) || note.startsWith("IMDb returned no scores for the rated films") || /^watchlist skipped \(.*private\)$/.test(note);
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
    if (o.delayMs) await sleep(o.delayMs);
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
    // A 200 that is not a titles answer is a failed lookup, not a scoreless profile (whose note is cached).
    let titles: unknown;
    try { titles = obj(obj(JSON.parse(text) as Json).data).titles; } catch { titles = undefined; }
    if (!Array.isArray(titles)) throw new Error(`IMDb rating lookup -> HTTP ${res.status} without a titles list`);
    for (const [k, v] of parseImdbOwnerRatings(text)) out.set(k, v);
  }
  return out;
}

// ---- IMDb GraphQL route ---------------------------------------------------------------------------------------

/** Ratings pages fetched per GraphQL request after the first (as aliases p1, p2, ...): 1,000 titles a request. */
export const API_PAGES_PER_REQUEST = 4;
const GQL_TITLE = "id titleText { text } releaseYear { year } titleGenres { genres { genre { text } } } principalCreditsV2 { grouping { text } credits { name { nameText { text } } } }";

const ratingsField = (alias: string, userId: string, page: number) =>
  `${alias}: advancedTitleSearch(first: 250, jumpToPosition: ${page * 250 + 1}, constraints: { singleUserRatingConstraint: { filterType: INCLUDE, userId: ${JSON.stringify(userId)} }, ` +
  `explicitContentConstraint: { explicitContentFilter: INCLUDE_ADULT } }, sort: { sortBy: SINGLE_USER_RATING_DATE, sortOrder: DESC }) ` +
  `{ total pageInfo { hasNextPage } edges { node { title { ${GQL_TITLE} } } } }`;
const watchlistField = (userId: string, after: string | null) =>
  `wl: predefinedList(classType: WATCH_LIST, userId: ${JSON.stringify(userId)}) { titleListItemSearch(first: 250${after ? `, after: ${JSON.stringify(after)}` : ""}) ` +
  `{ total pageInfo { hasNextPage endCursor } edges { listItem: title { id titleText { text } releaseYear { year } } } } }`;

/** One GraphQL POST. A bot check throws ProfileBlocked; an HTTP error or an answer with no data throws Error. */
async function gql(body: Obj, what: string, o: FetchOpts, first: boolean): Promise<Obj> {
  if (!first && o.delayMs) await sleep(o.delayMs);
  const f = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(o.imdbGraphql ?? "https://api.graphql.imdb.com/", {
      method: "POST",
      headers: { ...BROWSER_HEADERS, Accept: "application/json", "Content-Type": "application/json", Origin: "https://www.imdb.com", Referer: "https://www.imdb.com/" },
      body: JSON.stringify(body),
    });
  } catch (e) { throw new Error(`cannot reach IMDb's API for the ${what}: ${e instanceof Error ? e.message : String(e)}`); }
  const text = await res.text();
  if (isChallenge(res.status, res.headers, text)) throw new ProfileBlocked("imdb", `IMDb's API refused the ${what} (HTTP ${res.status}${res.headers.get("x-amzn-waf-action") ? ", bot check" : ""})`);
  let json: Obj;
  try { json = obj(JSON.parse(text) as Json); } catch { throw new Error(`IMDb's API sent an unreadable ${what} (HTTP ${res.status})`); }
  const err = str(obj(arr(json.errors)[0]).message);
  if (!res.ok || json.data === undefined || json.data === null) throw new Error(`IMDb's API rejected the ${what} (${(err ?? `HTTP ${res.status}`).slice(0, 160)})`);
  return obj(json.data);
}

interface ApiSearch { total: number | null; hasNext: boolean; items: ImdbItem[] }
function apiRatings(v: Json | undefined): ApiSearch | null {
  const s = obj(v);
  if (!Array.isArray(s.edges)) return null;
  const items = s.edges.map((e) => imdbItem(obj(obj(obj(e).node).title))).filter((i): i is ImdbItem => i !== null);
  return { total: num(s.total), hasNext: obj(s.pageInfo).hasNextPage === true, items };
}
function apiWatchlist(v: Json | undefined): (ApiSearch & { cursor: string | null }) | null {
  const s = obj(obj(v).titleListItemSearch);
  if (!Array.isArray(s.edges)) return null;
  const items = s.edges.map((e) => imdbItem(obj(obj(e).listItem))).filter((i): i is ImdbItem => i !== null);
  const info = obj(s.pageInfo);
  return { total: num(s.total), hasNext: info.hasNextPage === true, items, cursor: str(info.endCursor) };
}

/**
 * Ratings and watchlist over raw GraphQL. Throws when the route can't start (refused, p. id unresolved, API error,
 * no ratings), so the caller can try the pages; a failure after the first ratings request keeps what it has, with a note.
 */
export async function imdbViaApi(id: string, o: FetchOpts, notes: string[]): Promise<{ userId: string; rated: ImdbItem[]; watch: ImdbItem[] }> {
  let calls = 0;
  const call = (body: Obj, what: string) => gql(body, what, o, calls++ === 0);
  let userId = id;
  if (!id.startsWith("ur")) {
    const d = await call({ query: `query { userProfile(input: { profileId: ${JSON.stringify(id)} }) { userId } }` }, "profile id");
    const ur = str(obj(d.userProfile).userId);
    if (!ur || !/^ur\d+$/.test(ur)) throw new Error(`IMDb's API did not resolve the profile id ${id}`);
    userId = ur;
  }
  const first = await call({ query: `query { ${ratingsField("p0", userId, 0)} ${watchlistField(userId, null)} }` }, "ratings list");
  const p0 = apiRatings(first.p0);
  if (!p0) throw new Error("IMDb's API returned no ratings list");
  if (!p0.items.length) throw new Error(`IMDb's API lists no public ratings for ${userId}`);
  const rated: ImdbItem[] = [];
  const seen = new Set<string>();
  const add = (xs: ImdbItem[], into: ImdbItem[], ids: Set<string>) => { let n = 0; for (const i of xs) if (!ids.has(i.tconst)) { ids.add(i.tconst); into.push(i); n++; } return n; };
  add(p0.items, rated, seen);
  const total = p0.total;
  o.log?.(`IMDb ratings (API): ${rated.length}${total ? ` of ${total}` : ""}`);
  let more = p0.hasNext && (total === null || rated.length < total);
  let page = 1;
  while (more && page < MAX_PAGES) {
    const pages = Array.from({ length: Math.min(API_PAGES_PER_REQUEST, MAX_PAGES - page) }, (_, k) => page + k);
    let d: Obj;
    try { d = await call({ query: `query { ${pages.map((n) => ratingsField(`p${n}`, userId, n)).join(" ")} }` }, "ratings list"); }
    catch (e) { notes.push(`IMDb ratings: stopped at page ${page + 1} (${e instanceof Error ? e.message : String(e)}); kept the first ${rated.length}`); more = false; break; }
    for (const n of pages) {
      const r = apiRatings(d[`p${n}`]);
      if (!r) { notes.push(`IMDb ratings: stopped at page ${n + 1} (IMDb's API returned no data for it); kept the first ${rated.length}`); more = false; break; }
      const fresh = add(r.items, rated, seen);
      page = n + 1;
      if (!r.hasNext || !fresh || (total !== null && rated.length >= total)) { more = false; break; }
    }
    o.log?.(`IMDb ratings (API): ${rated.length}${total ? ` of ${total}` : ""}`);
  }
  if (more) notes.push(`IMDb ratings: stopped at the ${MAX_PAGES}-page limit; kept the first ${rated.length}${total ? ` of ${total}` : ""}`);

  const watch: ImdbItem[] = [];
  const wseen = new Set<string>();
  let wl = apiWatchlist(first.wl);
  if (!wl) notes.push("watchlist skipped (IMDb's API returned none; it may be private)");
  for (let wpage = 1; wl; wpage++) {
    add(wl.items, watch, wseen);
    if (!wl.hasNext || !wl.cursor || !wl.items.length) break;
    if (wpage >= MAX_PAGES) { notes.push(`IMDb watchlist: stopped at the ${MAX_PAGES}-page limit; kept the first ${watch.length}${wl.total ? ` of ${wl.total}` : ""}`); break; }
    const stop = (why: string) => notes.push(`IMDb watchlist: stopped at page ${wpage + 1} (${why}); kept the first ${watch.length}`);
    try { wl = apiWatchlist((await call({ query: `query { ${watchlistField(userId, wl.cursor)} }` }, "watchlist")).wl); }
    catch (e) { stop(e instanceof Error ? e.message : String(e)); break; }
    if (!wl) stop("IMDb's API returned no data for it");
  }
  return { userId, rated, watch };
}

/**
 * Ratings and watchlist of a public IMDb profile: IMDb's GraphQL API first, the HTML pages when the API route can't
 * start. Throws ProfileBlocked when the pages are refused too.
 */
export async function fetchImdbProfile(url: string, o: FetchOpts = {}): Promise<FetchedProfile> {
  const id = imdbUserId(url);
  let notes: string[] = [];
  let rated: ImdbItem[], watch: ImdbItem[] = [], userId: string | null;
  try {
    ({ userId, rated, watch } = await imdbViaApi(id, o, notes));
  } catch (apiErr) {
    o.log?.(`IMDb API route failed (${apiErr instanceof Error ? apiErr.message : String(apiErr)}); trying the profile pages`);
    notes = [];
    const base = `${(o.imdbOrigin ?? "https://www.imdb.com").replace(/\/+$/, "")}/user/${id}`;
    if (o.delayMs) await sleep(o.delayMs);
    const r = await imdbList(base, "ratings", o, notes);
    rated = r.items;
    try { watch = (await imdbList(base, "watchlist", o, notes)).items; }
    catch (e) { if (e instanceof ProfileBlocked) notes.push(`watchlist skipped (${e.message})`); else throw e; }
    userId = r.userId ?? (id.startsWith("ur") ? id : null);
  }
  let ratings = new Map<string, number>();
  if (userId && rated.length) {
    let failed = false;
    try { ratings = await imdbOwnerRatings(userId, rated.map((i) => i.tconst), o); }
    catch (e) { failed = true; notes.push(`could not read the scores themselves (${e instanceof Error ? e.message : String(e)}); rated films still count as seen`); }
    if (!ratings.size && !failed) notes.push("IMDb returned no scores for the rated films; they still count as seen");
  }
  const titles: Record<string, TitleRef> = {};
  for (const i of [...rated, ...watch]) titles[i.tconst] = { title: i.title, year: i.year, ...(ratings.has(i.tconst) ? { rating: ratings.get(i.tconst)! } : {}) };
  return {
    seen: rated.map((i) => i.tconst),
    ...(ratings.size ? { ratings: Object.fromEntries(ratings) } : {}),
    watchlist: watch.map((i) => i.tconst),
    ...affinities(rated, ratings),
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
