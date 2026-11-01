// The MCP tools: schemas (user-facing copy) and implementations.
import type { Catalogue, Filters } from "./catalogue.ts";
import {
  NO_SCORES_NOTE, PROFILE_KINDS, PROFILE_MAX_BYTES, PROFILE_TTL_SECONDS, TOKEN_RE, mergeProfiles, newToken, profileFromText, validateProfile,
  type Profile, type ProfileKind,
} from "./profile.ts";
import {
  CACHE_TTL_SECONDS, DEGRADED_TTL_SECONDS, ImdbClient, ImdbError, ImdbNotFound, ImdbPrivate, ImdbRefusal, importImdbProfile, liveDeps, parseImdbUserUrl, resolveImdbUser,
  type ImdbDeps, type ImdbImport, type ImdbUserRef,
} from "./imdb.ts";
import { LATEST_ONLY_NOTE, LetterboxdError, fetchLetterboxd, parseLetterboxdUser } from "./letterboxd.ts";

/** The slice of Workers KV the tools use (a Map stands in for it in tests). */
export interface ProfileStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
/** The Convex import service (AWS egress, which IMDb answers; Cloudflare's gets HTTP 429). */
export interface Importer { url: string; secret: string; fetch?: Fetcher }
/** imdb: direct IMDb calls (the fallback); importer: Convex; web: other outbound fetches (Letterboxd). Tests stub all three. */
export interface ToolContext { catalogue: Catalogue; profiles: ProfileStore; imdb?: ImdbDeps; importer?: Importer; web?: Fetcher }

/** A failure the caller can fix; its message is shown to the model as a tool error. status and code are what the GET API answers with. */
export class ToolError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "bad_request") { super(message); }
}

type Json = Record<string, unknown>;
const int = (description: string, minimum: number, maximum?: number) => ({ type: "integer", description, minimum, ...(maximum ? { maximum } : {}) });
const strList = (description: string) => ({ type: "array", items: { type: "string" }, description });

const FILTERS = {
  type: "object",
  description: "Optional filters. Films without an IMDb match are left out unless matched_only is false.",
  properties: {
    genre: strList("Keep films with any of these genres, e.g. [\"Comedy\", \"Animation\"]."),
    exclude_genre: strList("Drop films with any of these genres."),
    min_year: int("Earliest release year.", 1880, 2100),
    max_year: int("Latest release year.", 1880, 2100),
    min_runtime: int("Shortest runtime in minutes.", 1),
    max_runtime: int("Longest runtime in minutes.", 1),
    family: { type: "boolean", description: "Only films rated G, PG, PG-13, U or similar (no R, 18 or NC-17)." },
    language: { type: "string", description: "Original language, e.g. \"English\" or \"Korean\"." },
    query: { type: "string", description: "Part of a title." },
    matched_only: { type: "boolean", description: "Only films matched to IMDb (default true)." },
  },
  additionalProperties: false,
};
const PROFILE = {
  type: "object",
  description: "What the person has seen and liked. Keys are IMDb ids (tt...) or \"Title (Year)\" when no id is known.",
  properties: {
    seen: strList("Films already watched."),
    ratings: { type: "object", additionalProperties: { type: "number", minimum: 1, maximum: 10 }, description: "Their ratings out of 10." },
    watchlist: strList("Films they want to see."),
    liked_directors: strList("Director names they like."),
    liked_genres: strList("Genres they like."),
    disliked_genres: strList("Genres they avoid."),
    source: { type: "string", description: "Where the profile came from, e.g. imdb_csv." },
  },
  required: ["seen"],
};
const AIRLINE = { type: "string", description: "Airline id from list_airlines, e.g. \"emirates\"." };
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: "list_airlines",
    title: "List airlines",
    description: "Airlines in the dataset with the month of their current film catalogue, film counts, and whether the last update worked.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "catalogue",
    title: "Browse a catalogue",
    description: "One airline's films this month as compact rows (title, year, runtime, genres, IMDb rating, blended score), best first. Use it to check whether a film is on board or to browse; use picks for recommendations.",
    inputSchema: {
      type: "object",
      properties: { airline: AIRLINE, filters: FILTERS, limit: int("Rows to return (default 50, max 200).", 1, 200), offset: int("Rows to skip, for paging.", 0) },
      required: ["airline"], additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "picks",
    title: "Recommend films",
    description: "Ranked film picks for one airline, with synopsis, ratings and the reasons for each pick. Pass a profile (or a saved profile token) to hide films already seen and rank by the person's taste. flight_minutes drops films that would not finish before landing.",
    inputSchema: {
      type: "object",
      properties: {
        airline: AIRLINE,
        flight_minutes: int("Flight length in minutes. Films longer than this minus 30 are dropped.", 30),
        filters: FILTERS,
        profile: {
          description: "A profile object, { \"token\": \"...\" } for a taste code from save_profile, or { \"imdb_user\": \"ur...\" } after profile_from_imdb_url.",
          anyOf: [
            PROFILE,
            { type: "object", properties: { token: { type: "string" } }, required: ["token"], additionalProperties: false },
            { type: "object", properties: { imdb_user: { type: "string" } }, required: ["imdb_user"], additionalProperties: false },
          ],
        },
        limit: int("Picks to return (default 8, max 20).", 1, 20),
      },
      required: ["airline"], additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "save_profile",
    title: "Save a taste profile",
    description: "Store a taste profile for a year and get its taste code (the token field), which the person pastes on later flights. Call it their taste code, not a token. Pass a profile object, or { \"imdb_user\": \"ur...\" } after profile_from_imdb_url to save that import. Stores only film ids, ratings, genres and director names (64 KB max; a bigger IMDb import keeps its most recent films).",
    inputSchema: {
      type: "object",
      properties: {
        profile: {
          anyOf: [PROFILE, { type: "object", properties: { imdb_user: { type: "string" } }, required: ["imdb_user"], additionalProperties: false }],
          description: "The profile to save, or { imdb_user } from profile_from_imdb_url.",
        },
      },
      required: ["profile"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "get_profile",
    title: "Load a saved profile",
    description: "Load a taste profile saved with save_profile.",
    inputSchema: { type: "object", properties: { token: { type: "string", description: "The 20-character taste code from save_profile." } }, required: ["token"], additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "profile_from_imdb_url",
    title: "Import a public IMDb profile",
    description: "Read a public IMDb profile's ratings (with scores, up to 5,000 most recent) and watchlist on the server, from a URL like https://www.imdb.com/user/p.xxxx/ratings/ or /user/ur1234567/. Call it straight away with the link the person gave; don't fetch the IMDb pages yourself first. Returns counts, the genres and directors it learned, notes, and an imdb_user id: pass profile: { imdb_user } to picks. Kept for 24 hours, so calling again is cheap. Takes up to half a minute for large profiles. If it fails, the error says why (private ratings, a daily limit, or IMDb's bot check) and what to do next; don't retry the same link.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "The IMDb profile, ratings or watchlist URL (or the bare ur / p. id)." } }, required: ["url"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "profile_from_letterboxd",
    title: "Read a Letterboxd diary",
    description: "Read a Letterboxd member's public diary feed: their latest 50 logged films with star ratings (doubled to a 10-point scale). Returns a profile to pass to picks as is, plus counts and a note. It covers the latest 50 entries only, so say so, and expect some films they've seen to come back in picks.",
    inputSchema: { type: "object", properties: { username: { type: "string", description: "The Letterboxd username, or any letterboxd.com/<username>/ link." } }, required: ["username"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "profile_from_text",
    title: "Build a profile from an export or page",
    description: "Turn text you already have into a taste profile: an IMDb ratings or watchlist CSV export, a Letterboxd ratings.csv / watched.csv / watchlist.csv, or the HTML of an IMDb or Letterboxd ratings page. For several pages or files, pass the previous result as add_to. Send a CSV over about 200 KB in parts cut at line ends, each starting with the header line.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The CSV or HTML text, unchanged." },
        kind: { type: "string", enum: [...PROFILE_KINDS], description: "What the text is." },
        list: { type: "string", enum: ["watched", "watchlist"], description: "Whether the text lists watched films (default) or a watchlist. Needed for Letterboxd watched.csv / watchlist.csv; IMDb watchlist pages and exports are detected." },
        add_to: { ...PROFILE, description: "A profile to merge this text into (for paginated pages)." },
      },
      required: ["text", "kind"], additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
] as const;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function optInt(a: Json, key: string, min: number, max: number, fallback?: number): number | undefined {
  const v = a[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new ToolError(`${key} must be a whole number from ${min} to ${max}`);
  return v;
}

function parseFilters(v: unknown): Filters {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw new ToolError("filters must be an object, e.g. { \"genre\": [\"Comedy\"], \"max_runtime\": 120 }");
  const known = Object.keys(FILTERS.properties);
  const extra = Object.keys(v).filter((k) => !known.includes(k));
  if (extra.length) throw new ToolError(`unknown filter ${extra.join(", ")}; valid filters: ${known.join(", ")}`);
  const list = (k: string) => {
    const x = v[k];
    if (x === undefined) return undefined;
    const arr = typeof x === "string" ? [x] : x;
    if (!Array.isArray(arr) || arr.some((g) => typeof g !== "string")) throw new ToolError(`filters.${k} must be a list of genre names`);
    return arr as string[];
  };
  const bool = (k: string) => {
    const x = v[k];
    if (x !== undefined && typeof x !== "boolean") throw new ToolError(`filters.${k} must be true or false`);
    return x as boolean | undefined;
  };
  const str = (k: string) => {
    const x = v[k];
    if (x !== undefined && typeof x !== "string") throw new ToolError(`filters.${k} must be text`);
    return x as string | undefined;
  };
  return {
    genre: list("genre"), exclude_genre: list("exclude_genre"),
    min_year: optInt(v, "min_year", 1880, 2100), max_year: optInt(v, "max_year", 1880, 2100),
    min_runtime: optInt(v, "min_runtime", 1, 1000), max_runtime: optInt(v, "max_runtime", 1, 1000),
    family: bool("family"), language: str("language"), query: str("query"), matched_only: bool("matched_only"),
  };
}

function airlineOf(ctx: ToolContext, v: unknown) {
  const ids = ctx.catalogue.bundle.airlines.map((a) => a.id).join(", ");
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`airline is required; one of: ${ids}`, 400, "missing_airline");
  const a = ctx.catalogue.airline(v);
  if (!a) throw new ToolError(`unknown airline "${v}"; use one of: ${ids}`, 404, "unknown_airline");
  return a;
}

function profileArg(v: unknown): Profile {
  try { return validateProfile(v); } catch (e) { throw new ToolError((e as Error).message); }
}

const imdbKey = (ur: string) => `imdb:${ur}`;
/** p. profile id -> ur id, so a repeat p. link skips the resolve call. */
const aliasKey = (p: string) => `imdbp:${p}`;

const IMPORT_TIMEOUT_MS = 90_000;
const NEXT_STEP = "Move on: ask for their Letterboxd username, or run the seen check.";

type ConvexOutcome = { kind: "ok"; import: ImdbImport; cached: boolean } | { kind: "unavailable"; why: string };

/** One call to the Convex import service. Its own refusals (limits, private, bot check) become a ToolError; transport trouble is "unavailable". */
async function importViaConvex(ctx: ToolContext, imp: Importer, ref: ImdbUserRef): Promise<ConvexOutcome> {
  let res: Response;
  try {
    res = await (imp.fetch ?? ((u, i) => fetch(u, i)))(`${imp.url.replace(/\/+$/, "")}/import/imdb`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-import-secret": imp.secret },
      body: JSON.stringify({ user: ref.id }),
      signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
    });
  } catch (e) {
    return { kind: "unavailable", why: (e as Error).name || "network" };
  }
  let body: Json;
  try { body = (await res.json()) as Json; } catch { return { kind: "unavailable", why: `HTTP ${res.status}, not JSON` }; }
  if (res.ok && body.ok === true && isObj(body.import)) {
    const r = body.import as unknown as ImdbImport;
    if (typeof r.imdb_user !== "string" || !/^ur\d+$/.test(r.imdb_user)) return { kind: "unavailable", why: "bad import" };
    try { r.profile = validateProfile(r.profile); } catch { return { kind: "unavailable", why: "bad profile" }; }
    if (!Array.isArray(r.notes)) r.notes = [];
    return { kind: "ok", import: r, cached: body.cached === true };
  }
  const message = typeof body.message === "string" ? body.message : "";
  switch (body.error) {
    case "capped":
      throw new ToolError(body.scope === "user"
        ? `This IMDb profile has been imported as many times as allowed today; the import from earlier is gone or failed. Try again tomorrow. ${NEXT_STEP}`
        : `The IMDb import has reached its limit for today. Try again tomorrow. ${NEXT_STEP}`, 429, "capped");
    case "challenged":
      throw new ToolError(`IMDb turned the import away this time (its bot check), so nothing was read. Don't retry now. ${NEXT_STEP}`, 503, "imdb_bot_check");
    case "private":
      throw new ToolError("IMDb shows no public ratings for this profile, so they are almost certainly private. Tell the person how to make them " +
        "public in one line: on imdb.com, Settings, then Privacy, and set ratings (and the watchlist) to public; then send the link again. " +
        "Meanwhile, ask for their Letterboxd username, or run the seen check.", 403, "private_profile");
    case "not_found":
      throw new ToolError(`IMDb doesn't know this profile id. Ask the person to copy the link again from their IMDb profile (Share, Copy link). ${NEXT_STEP}`, 404, "imdb_not_found");
    case "imdb_error":
      throw new ToolError(message || `The IMDb import failed. ${NEXT_STEP}`, 502, "imdb_error");
    case "bad_request":
      throw new ToolError("that is not an IMDb profile URL; it should look like https://www.imdb.com/user/p.xxxx/ratings/ or https://www.imdb.com/user/ur1234567/");
    default:
      return { kind: "unavailable", why: `HTTP ${res.status}` };
  }
}

function imdbStatus(e: ImdbError): [number, string] {
  if (e instanceof ImdbPrivate) return [403, "private_profile"];
  if (e instanceof ImdbNotFound) return [404, "imdb_not_found"];
  if (e instanceof ImdbRefusal) return [503, "imdb_bot_check"];
  return [502, "imdb_error"];
}

async function remember(ctx: ToolContext, r: ImdbImport, ref: ImdbUserRef) {
  const ttl = r.degraded ? DEGRADED_TTL_SECONDS : CACHE_TTL_SECONDS;
  await ctx.profiles.put(imdbKey(r.imdb_user), JSON.stringify(r), { expirationTtl: ttl });
  if (ref.kind === "p") await ctx.profiles.put(aliasKey(ref.id), r.imdb_user, { expirationTtl: ttl });
}

async function loadImdbProfile(ctx: ToolContext, user: unknown): Promise<Profile> {
  if (typeof user !== "string" || !/^ur\d{5,12}$/.test(user.trim().toLowerCase())) throw new ToolError("imdb_user must be the ur id profile_from_imdb_url returned, e.g. ur12345678");
  const raw = await ctx.profiles.get(imdbKey(user.trim().toLowerCase()));
  if (!raw) throw new ToolError("that IMDb import has expired (imports last 24 hours); call profile_from_imdb_url again with the profile URL", 404, "import_expired");
  return (JSON.parse(raw) as ImdbImport).profile;
}

/** What the model sees after an import: counts and learned preferences, not the id lists. */
function importSummary(r: ImdbImport, cached: boolean): Json {
  const p = r.profile;
  return {
    imdb_user: r.imdb_user, profile: { imdb_user: r.imdb_user }, cached, fetched_at: r.fetched_at,
    seen: p.seen.length, rated: r.rated, total_ratings: r.total_ratings, watchlist: r.watchlist, truncated: r.truncated,
    liked_genres: p.liked_genres ?? [], disliked_genres: p.disliked_genres ?? [], liked_directors: p.liked_directors ?? [],
    notes: r.notes,
  };
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** An IMDb import cut to its most recent films (seen is newest first) until it fits a saved profile. */
function fitProfile(p: Profile): Profile {
  let n = p.seen.length;
  let out = p;
  while (bytes(JSON.stringify(out)) > PROFILE_MAX_BYTES && n > 0) {
    n = Math.floor(n * 0.9);
    const keep = new Set(p.seen.slice(0, n));
    const ratings = Object.fromEntries(Object.entries(p.ratings ?? {}).filter(([k]) => keep.has(k)));
    out = { ...p, seen: p.seen.slice(0, n), ratings, ...(p.watchlist ? { watchlist: p.watchlist.slice(0, 500) } : {}) };
  }
  return out;
}

async function loadProfile(ctx: ToolContext, token: unknown): Promise<Profile> {
  if (typeof token !== "string" || !TOKEN_RE.test(token.trim().toLowerCase())) throw new ToolError("token must be the 20-character taste code save_profile returned");
  const raw = await ctx.profiles.get(`profile:${token.trim().toLowerCase()}`);
  if (!raw) throw new ToolError("no saved profile for that taste code; it may have expired (they last a year) or have a typo. Build a new profile from a link or export, or make a new code at https://seatback.len5ky.com/taste.", 404, "unknown_code");
  return JSON.parse(raw) as Profile;
}

export async function callTool(ctx: ToolContext, name: string, args: Json): Promise<Json> {
  const cat = ctx.catalogue;
  switch (name) {
    case "list_airlines":
      return { airlines: cat.listAirlines() };
    case "catalogue": {
      const a = airlineOf(ctx, args.airline);
      const limit = optInt(args, "limit", 1, 200, 50)!, offset = optInt(args, "offset", 0, 100_000, 0)!;
      const films = cat.filtered(a, parseFilters(args.filters))
        .sort((x, y) => (y.blended ?? -1) - (x.blended ?? -1) || x.title.localeCompare(y.title));
      return {
        airline: a.id, month: a.month, total: films.length, offset,
        rows: films.slice(offset, offset + limit).map((f) => ({
          imdbId: f.imdbId, title: f.title, year: f.year ?? f.imdbYear, runtime: f.runtime, genres: f.genres.length ? f.genres : f.imdbGenres,
          cert: f.cert, imdb: f.imdb, votes: f.votes, blended: f.blended, confidence: f.confidence,
        })),
      };
    }
    case "picks": {
      const a = airlineOf(ctx, args.airline);
      const limit = optInt(args, "limit", 1, 20, 8)!;
      const flightMinutes = optInt(args, "flight_minutes", 30, 2000);
      const p = args.profile;
      let profile = null;
      if (isObj(p) && "token" in p) profile = cat.applyProfile(await loadProfile(ctx, p.token), "saved profile");
      else if (isObj(p) && "imdb_user" in p && !("seen" in p)) profile = cat.applyProfile(await loadImdbProfile(ctx, p.imdb_user), "imdb profile");
      else if (p !== undefined && p !== null) {
        const v = profileArg(p);
        profile = cat.applyProfile(v, v.source ?? "inline profile");
      }
      return cat.picks(a, { filters: parseFilters(args.filters), flightMinutes, profile, limit });
    }
    case "save_profile": {
      const p = args.profile;
      const fromImport = isObj(p) && "imdb_user" in p && !("seen" in p);
      const profile = fromImport ? fitProfile(await loadImdbProfile(ctx, p.imdb_user)) : profileArg(p);
      const json = JSON.stringify(profile);
      if (bytes(json) > PROFILE_MAX_BYTES)
        throw new ToolError("profile is over 64 KB; keep the most recent ratings (about 3,000) and the seen list, then try again");
      const token = newToken();
      await ctx.profiles.put(`profile:${token}`, json, { expirationTtl: PROFILE_TTL_SECONDS });
      return { token };
    }
    case "get_profile":
      return { ...(await loadProfile(ctx, args.token)) };
    case "profile_from_imdb_url": {
      if (typeof args.url !== "string" || !args.url.trim()) throw new ToolError("url is required, e.g. https://www.imdb.com/user/p.xxxx/ratings/");
      const ref = parseImdbUserUrl(args.url);
      if (!ref) throw new ToolError("that is not an IMDb profile URL; it should look like https://www.imdb.com/user/p.xxxx/ratings/ or https://www.imdb.com/user/ur1234567/");
      const knownUr = ref.kind === "ur" ? ref.id : await ctx.profiles.get(aliasKey(ref.id));
      if (knownUr) {
        const hit = await ctx.profiles.get(imdbKey(knownUr));
        if (hit) return importSummary(JSON.parse(hit) as ImdbImport, true);
      }
      if (ctx.importer) {
        const out = await importViaConvex(ctx, ctx.importer, ref);
        if (out.kind === "ok") { await remember(ctx, out.import, ref); return importSummary(out.import, out.cached); }
        console.error("convex import unavailable, trying IMDb directly:", out.why);
      }
      // Direct from Cloudflare: IMDb answers it with HTTP 429 nearly every time; kept for when Convex is down or not configured.
      const client = new ImdbClient(ctx.imdb ?? liveDeps);
      try {
        const ur = await resolveImdbUser(client, ref);
        const hit = await ctx.profiles.get(imdbKey(ur));
        if (hit) return importSummary(JSON.parse(hit) as ImdbImport, true);
        const r = await importImdbProfile(client, ur);
        await remember(ctx, r, ref);
        return importSummary(r, false);
      } catch (e) {
        if (e instanceof ImdbError) throw new ToolError(e.message, ...imdbStatus(e));
        throw e;
      }
    }
    case "profile_from_letterboxd": {
      const user = typeof args.username === "string" ? parseLetterboxdUser(args.username) : null;
      if (!user) throw new ToolError("username is required: the Letterboxd username, e.g. \"dave\", or a link like https://letterboxd.com/dave/");
      try {
        const r = await fetchLetterboxd(ctx.web ?? ((u, i) => fetch(u, i)), user, { tmdb: (id) => cat.tmdb(id), slug: (s) => cat.bundle.letterboxd[s] ?? null });
        return { username: user, entries: r.entries, rated: r.rated, matched: r.matched, profile: r.profile, note: LATEST_ONLY_NOTE };
      } catch (e) {
        if (e instanceof LetterboxdError) throw new ToolError(e.message, e.status, e.status === 404 ? "letterboxd_not_found" : "letterboxd_error");
        throw e;
      }
    }
    case "profile_from_text": {
      if (typeof args.text !== "string" || !args.text.trim()) throw new ToolError("text is required: paste the CSV or page HTML unchanged");
      const kind = args.kind as ProfileKind;
      if (!PROFILE_KINDS.includes(kind)) throw new ToolError(`kind must be one of ${PROFILE_KINDS.join(", ")}`);
      if (args.list !== undefined && args.list !== "watched" && args.list !== "watchlist") throw new ToolError("list must be \"watched\" or \"watchlist\"");
      const list = args.list === "watchlist" ? "watchlist" : "watched";
      let parsed: ReturnType<typeof profileFromText>;
      try { parsed = profileFromText(args.text, kind, cat.bundle.letterboxd, list); } catch (e) { throw new ToolError((e as Error).message); }
      const { note, ...profile } = parsed;
      const prior = isObj(args.add_to) && typeof args.add_to.imdb_user === "string" && /^ur\d+$/.test(args.add_to.imdb_user) ? args.add_to.imdb_user : undefined;
      const imdb_user = parsed.imdb_user ?? prior;
      delete profile.imdb_user;
      const merged = args.add_to !== undefined ? mergeProfiles(profileArg(args.add_to), profile) : profile;
      // Pages carry no scores: keep saying so after a merge, as long as nothing in the result has a score.
      const keepNote = note ?? (kind === "imdb_page" && merged.seen.length && !Object.keys(merged.ratings ?? {}).length ? NO_SCORES_NOTE : undefined);
      return { ...merged, ...(keepNote ? { note: keepNote } : {}), ...(imdb_user ? { imdb_user } : {}) };
    }
    default:
      throw new ToolError(`unknown tool ${name}`);
  }
}
