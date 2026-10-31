// Server-side import of a public IMDb profile through IMDb's GraphQL API (the same calls imdb.com makes in the browser).
// Probed 2026-10-30 (tmp/w2/imdb-graphql-probe.md): the HTML pages answer datacenter IPs with a WAF challenge, the API
// does not. Raw queries list ratings and the watchlist; the owner's scores need the persisted PersonalizedUserData query.
import { preferences, type Profile } from "./profile.ts";

export const IMDB_GRAPHQL = "https://api.graphql.imdb.com/";
export const SCORES_QUERY_HASH = "7c4e0771d67f21fc27fd44fc46d49cc589225a9c5e63e51cc0b8d42f39ee99cc";
export const PAGE_SIZE = 250;
export const MAX_TITLES = 5_000;
export const MAX_WATCHLIST = 1_000;
export const GAP_MS = 300;
export const CACHE_TTL_SECONDS = 24 * 3600;
export const DEGRADED_TTL_SECONDS = 3600;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const CSV_HELP =
  "Ask the person for their IMDb ratings CSV export instead (signed in on a computer: https://www.imdb.com/list/ratings/export, " +
  "then download it from Your exports and attach it) and pass it to profile_from_text with kind \"imdb_csv\", " +
  "or point them to https://seatback.len5ky.com/taste, which turns the export into a taste code in their browser.";

export interface ImdbDeps { fetch: (url: string, init: RequestInit) => Promise<Response>; sleep: (ms: number) => Promise<void> }
export const liveDeps: ImdbDeps = { fetch: (url, init) => fetch(url, init), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** A failure the model can act on; the message says what to do next. */
export class ImdbError extends Error {}
/** IMDb's bot check: no point in trying further calls in this import. */
export class ImdbRefusal extends ImdbError {}
const isRefusal = (e: unknown) => e instanceof ImdbRefusal;

export type ImdbUserRef = { kind: "ur"; id: string } | { kind: "p"; id: string };

/** ur / p. id from a profile URL (any locale prefix, ratings / watchlist / lists path) or a bare id. */
export function parseImdbUserUrl(input: string): ImdbUserRef | null {
  const s = input.trim();
  const m = s.match(/^(ur\d{5,12}|p\.[a-z0-9]{10,40})$/i)
    ?? s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?imdb\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?user\/(ur\d{5,12}|p\.[a-z0-9]{10,40})(?:[/?#]|$)/i);
  if (!m) return null;
  const id = m[1]!;
  return id.toLowerCase().startsWith("ur") ? { kind: "ur", id: id.toLowerCase() } : { kind: "p", id: id.toLowerCase() };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export class ImdbClient {
  private calls = 0;
  constructor(private deps: ImdbDeps) {}

  /** One POST, 300 ms after the previous one. Challenges and HTTP errors become an ImdbError with the CSV fallback. */
  async post(body: Obj, what: string): Promise<Obj> {
    if (this.calls++ > 0) await this.deps.sleep(GAP_MS);
    let res: Response;
    try {
      res = await this.deps.fetch(IMDB_GRAPHQL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "user-agent": UA, origin: "https://www.imdb.com", referer: "https://www.imdb.com/" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ImdbError(`Could not reach IMDb while reading the ${what}. ${CSV_HELP}`);
    }
    const challenged = res.headers.get("x-amzn-waf-action") !== null || res.status === 202 || res.status === 403 || res.status === 429;
    if (challenged) throw new ImdbRefusal(
      `IMDb refused the request for the ${what} (HTTP ${res.status}, bot check); it often turns this server away, so don't retry. ` +
      `If you haven't yet, fetch https://www.imdb.com/user/<id>/ratings/ with your web fetch tool and pass each page to profile_from_text with kind "imdb_page". ` +
      `If that is blocked too: ${CSV_HELP.charAt(0).toLowerCase()}${CSV_HELP.slice(1)}`,
    );
    let json: Obj;
    try { json = obj(await res.json()); } catch { throw new ImdbError(`IMDb sent an unreadable answer for the ${what} (HTTP ${res.status}). ${CSV_HELP}`); }
    if (!res.ok && !("data" in json)) {
      const msg = str(obj(arr(json.errors)[0]).message) ?? `HTTP ${res.status}`;
      throw new ImdbError(`IMDb's API rejected the request for the ${what} (${msg.slice(0, 160)}); it may have changed. ${CSV_HELP}`);
    }
    return json;
  }

  async resolveProfileId(profileId: string): Promise<string | null> {
    const q = `query { userProfile(input: { profileId: ${JSON.stringify(profileId)} }) { userId } }`;
    let r: Obj;
    try { r = await this.post({ query: q }, "profile id"); } catch (e) { if (isRefusal(e)) throw e; return null; }
    const id = str(obj(obj(r.data).userProfile).userId);
    return id && /^ur\d+$/.test(id) ? id : null;
  }

  async ratingsPage(userId: string, position: number) {
    const q = `query { advancedTitleSearch(first: ${PAGE_SIZE}, jumpToPosition: ${position}, constraints: { singleUserRatingConstraint: { filterType: INCLUDE, userId: ${JSON.stringify(userId)} }, explicitContentConstraint: { explicitContentFilter: INCLUDE_ADULT } }, sort: { sortBy: SINGLE_USER_RATING_DATE, sortOrder: DESC }) { total pageInfo { hasNextPage } edges { node { title { ${TITLE_FIELDS} } } } } }`;
    const r = await this.post({ query: q }, "ratings list");
    const s = obj(obj(r.data).advancedTitleSearch);
    if (!("edges" in s)) throw new ImdbError(`IMDb returned no ratings list${apiError(r)}; the ratings may be private (IMDb, Settings, Privacy) or the API changed. ${CSV_HELP}`);
    const titles = arr(s.edges).map((e) => titleOf(obj(obj(e).node).title)).filter((t): t is Title => t !== null);
    return { total: typeof s.total === "number" ? s.total : null, titles, hasNext: obj(s.pageInfo).hasNextPage === true };
  }

  async watchlistPage(userId: string, after: string | null) {
    const q = `query { predefinedList(classType: WATCH_LIST, userId: ${JSON.stringify(userId)}) { titleListItemSearch(first: ${PAGE_SIZE}${after ? `, after: ${JSON.stringify(after)}` : ""}) { total pageInfo { hasNextPage endCursor } edges { listItem: title { id } } } } }`;
    const r = await this.post({ query: q }, "watchlist");
    const s = obj(obj(obj(r.data).predefinedList).titleListItemSearch);
    if (!("edges" in s)) return null;
    const ids = arr(s.edges).map((e) => str(obj(obj(e).listItem).id)).filter((x): x is string => !!x && /^tt\d+$/.test(x));
    const info = obj(s.pageInfo);
    return { ids, total: typeof s.total === "number" ? s.total : null, next: info.hasNextPage === true ? str(info.endCursor) : null };
  }

  /** The owner's scores for up to 250 ids, through the persisted query imdb.com uses. null when it failed or carried no scores. */
  async scores(userId: string, ids: string[]): Promise<Map<string, number> | null> {
    const body = {
      operationName: "PersonalizedUserData",
      variables: { locale: "en-US", idArray: ids, includeUserData: false, includeWatchedData: false, otherUserId: userId, fetchOtherUserRating: true },
      extensions: { persistedQuery: { version: 1, sha256Hash: SCORES_QUERY_HASH } },
    };
    let r: Obj;
    try { r = await this.post(body, "scores"); } catch (e) { if (isRefusal(e)) throw e; return null; }
    const titles = arr(obj(r.data).titles);
    if (!titles.length) return null;
    const out = new Map<string, number>();
    for (const t of titles) {
      const id = str(obj(t).id), v = obj(obj(t).otherUserRating).value;
      if (id && typeof v === "number" && v >= 1 && v <= 10) out.set(id, v);
    }
    return out.size ? out : null;
  }
}

const TITLE_FIELDS = "id titleText { text } releaseYear { year } titleGenres { genres { genre { text } } } principalCreditsV2 { grouping { text } credits { name { nameText { text } } } }";

interface Title { id: string; genres: string[]; directors: string[] }
function titleOf(v: unknown): Title | null {
  const t = obj(v), id = str(t.id);
  if (!id || !/^tt\d+$/.test(id)) return null;
  const genres = arr(obj(t.titleGenres).genres).map((g) => str(obj(obj(g).genre).text)).filter((x): x is string => !!x);
  const directors = arr(t.principalCreditsV2)
    .filter((c) => /^director/i.test(str(obj(obj(c).grouping).text) ?? ""))
    .flatMap((c) => arr(obj(c).credits).map((x) => str(obj(obj(obj(x).name).nameText).text)))
    .filter((x): x is string => !!x);
  return { id, genres, directors };
}
const apiError = (r: Obj) => {
  const m = str(obj(arr(r.errors)[0]).message);
  return m ? ` (${m.slice(0, 160)})` : "";
};

export interface ImdbImport {
  imdb_user: string; profile: Profile; rated: number; total_ratings: number; watchlist: number; truncated: boolean;
  /** Scores could not be read: cache briefly so a retry can pick them up. */
  degraded: boolean;
  fetched_at: string; notes: string[];
}

const WATCHLIST_PAGES = Math.ceil(MAX_WATCHLIST / PAGE_SIZE);

/** The ur id for a URL's user: as given, or resolved from a p. profile id. */
export async function resolveImdbUser(c: ImdbClient, ref: ImdbUserRef): Promise<string> {
  if (ref.kind === "ur") return ref.id;
  const ur = await c.resolveProfileId(ref.id);
  if (ur) return ur;
  throw new ImdbError(
    `Could not turn the profile id ${ref.id} into an IMDb user id. Fetch https://www.imdb.com/user/${ref.id}/ratings/ with your web fetch tool and ` +
    `look for an id that starts with "ur" (authorId in the page data, or a link like /user/ur12345678/), then call profile_from_imdb_url again ` +
    `with https://www.imdb.com/user/<that id>/ratings/. If the page is blocked or has no ur id, ${CSV_HELP.charAt(0).toLowerCase()}${CSV_HELP.slice(1)}`,
  );
}

/** Ratings (most recent first, up to 5,000) with the owner's scores, plus the watchlist (up to 1,000). */
export async function importImdbProfile(c: ImdbClient, userId: string): Promise<ImdbImport> {
  const notes: string[] = [];
  const titles: Title[] = [];
  let total: number | null = null, more = false;
  for (let pos = 1; pos <= MAX_TITLES; pos += PAGE_SIZE) {
    const page = await c.ratingsPage(userId, pos);
    total = page.total ?? total;
    titles.push(...page.titles);
    more = page.hasNext && page.titles.length > 0;
    if (!more || (total !== null && titles.length >= total)) { more = false; break; }
  }
  if (!titles.length)
    throw new ImdbError(`${userId} has no public ratings. The person can make them public (IMDb, Settings, Privacy) and try again. ${CSV_HELP}`);
  const n = (x: number) => x.toLocaleString("en-US");
  const truncated = more || (total !== null && total > titles.length);
  if (truncated) notes.push(`Read the ${n(titles.length)} most recent of ${total !== null ? n(total) : "more"} ratings.`);

  const ratings: Record<string, number> = {};
  let scoresOk = true;
  for (let i = 0; i < titles.length; i += PAGE_SIZE) {
    const m = await c.scores(userId, titles.slice(i, i + PAGE_SIZE).map((t) => t.id));
    if (!m) { scoresOk = false; break; }
    for (const [id, v] of m) ratings[id] = v;
  }
  if (!scoresOk)
    notes.push("IMDb's score lookup failed, so some or all of these films count as seen without scores and taste ranking is weaker. " +
      "Try again in an hour, or ask for the IMDb ratings CSV export and pass it to profile_from_text.");

  const watchlist = new Set<string>();
  let after: string | null = null, wlTotal: number | null = null, wlMore = false, watchlistOk = true;
  for (let i = 0; i < WATCHLIST_PAGES; i++) {
    let page: Awaited<ReturnType<ImdbClient["watchlistPage"]>>;
    try { page = await c.watchlistPage(userId, after); } catch (e) { if (isRefusal(e)) throw e; page = null; }
    if (!page) { watchlistOk = false; break; }
    const before = watchlist.size;
    for (const id of page.ids) if (watchlist.size < MAX_WATCHLIST) watchlist.add(id);
    wlTotal = page.total ?? wlTotal;
    wlMore = page.next !== null && page.next !== after && watchlist.size > before;
    if (!wlMore) break;
    after = page.next;
  }
  if (!watchlistOk) notes.push("The watchlist could not be read (it may be private); only ratings were imported.");
  else if (wlMore || (wlTotal !== null && wlTotal > watchlist.size))
    notes.push(`Read ${n(watchlist.size)} of ${wlTotal !== null ? n(wlTotal) : "more"} watchlist titles.`);

  const rated = titles.filter((t) => ratings[t.id] !== undefined).map((t) => ({ rating: ratings[t.id]!, genres: t.genres, directors: t.directors }));
  const profile: Profile = {
    seen: titles.map((t) => t.id), ratings, ...(watchlist.size ? { watchlist: [...watchlist] } : {}),
    ...preferences(rated), source: "imdb_profile",
  };
  return {
    imdb_user: userId, profile, rated: Object.keys(ratings).length, total_ratings: total ?? titles.length, watchlist: watchlist.size,
    truncated, degraded: !scoresOk, fetched_at: new Date().toISOString(), notes,
  };
}
