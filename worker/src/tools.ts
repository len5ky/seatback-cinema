// The MCP tools: schemas (user-facing copy) and implementations.
import type { Catalogue, Filters } from "./catalogue.ts";
import {
  NO_SCORES_NOTE, PROFILE_KINDS, PROFILE_MAX_BYTES, PROFILE_TTL_SECONDS, TOKEN_RE, mergeProfiles, newToken, profileFromText, validateProfile,
  type Profile, type ProfileKind,
} from "./profile.ts";
import {
  CACHE_TTL_SECONDS, DEGRADED_TTL_SECONDS, ImdbClient, ImdbError, importImdbProfile, liveDeps, parseImdbUserUrl, resolveImdbUser, type ImdbDeps, type ImdbImport,
} from "./imdb.ts";

/** The slice of Workers KV the tools use (a Map stands in for it in tests). */
export interface ProfileStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}
export interface ToolContext { catalogue: Catalogue; profiles: ProfileStore; imdb?: ImdbDeps }

/** A failure the caller can fix; its message is shown to the model as a tool error. */
export class ToolError extends Error {}

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
          description: "A profile object, { \"token\": \"...\" } for one saved with save_profile, or { \"imdb_user\": \"ur...\" } after profile_from_imdb_url.",
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
    description: "Store a taste profile for a year and get a token the person can reuse on later flights. Stores only film ids, ratings, genres and director names (64 KB max).",
    inputSchema: { type: "object", properties: { profile: PROFILE }, required: ["profile"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "get_profile",
    title: "Load a saved profile",
    description: "Load a taste profile saved with save_profile.",
    inputSchema: { type: "object", properties: { token: { type: "string", description: "The 20-character token from save_profile." } }, required: ["token"], additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "profile_from_imdb_url",
    title: "Import a public IMDb profile",
    description: "Read a public IMDb profile's ratings (with scores, up to 5,000 most recent) and watchlist on the server, from a URL like https://www.imdb.com/user/p.xxxx/ratings/ or /user/ur1234567/. Returns a summary and an imdb_user id: pass profile: { imdb_user } to picks. Kept for 24 hours. Takes up to half a minute for large profiles.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "The IMDb profile, ratings or watchlist URL (or the bare ur / p. id)." } }, required: ["url"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "profile_from_text",
    title: "Build a profile from an export or page",
    description: "Turn text you already have into a taste profile: an IMDb ratings or watchlist CSV export, a Letterboxd ratings.csv / watched.csv / watchlist.csv, or the HTML of an IMDb or Letterboxd ratings page. For several pages, pass the previous result as add_to.",
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
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`airline is required; one of: ${ids}`);
  const a = ctx.catalogue.airline(v);
  if (!a) throw new ToolError(`unknown airline "${v}"; use one of: ${ids}`);
  return a;
}

function profileArg(v: unknown): Profile {
  try { return validateProfile(v); } catch (e) { throw new ToolError((e as Error).message); }
}

const imdbKey = (ur: string) => `imdb:${ur}`;

async function loadImdbProfile(ctx: ToolContext, user: unknown): Promise<Profile> {
  if (typeof user !== "string" || !/^ur\d{5,12}$/.test(user.trim().toLowerCase())) throw new ToolError("imdb_user must be the ur id profile_from_imdb_url returned, e.g. ur12345678");
  const raw = await ctx.profiles.get(imdbKey(user.trim().toLowerCase()));
  if (!raw) throw new ToolError("that IMDb import has expired (imports last 24 hours); call profile_from_imdb_url again with the profile URL");
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

async function loadProfile(ctx: ToolContext, token: unknown): Promise<Profile> {
  if (typeof token !== "string" || !TOKEN_RE.test(token.trim().toLowerCase())) throw new ToolError("token must be the 20-character code save_profile returned");
  const raw = await ctx.profiles.get(`profile:${token.trim().toLowerCase()}`);
  if (!raw) throw new ToolError("no saved profile for that token; it may have expired (profiles last a year). Build a new one with profile_from_text and save it again.");
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
      const profile = profileArg(args.profile);
      const json = JSON.stringify(profile);
      if (new TextEncoder().encode(json).length > PROFILE_MAX_BYTES)
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
      const client = new ImdbClient(ctx.imdb ?? liveDeps);
      try {
        const ur = await resolveImdbUser(client, ref);
        const hit = await ctx.profiles.get(imdbKey(ur));
        if (hit) return importSummary(JSON.parse(hit) as ImdbImport, true);
        const r = await importImdbProfile(client, ur);
        await ctx.profiles.put(imdbKey(ur), JSON.stringify(r), { expirationTtl: r.degraded ? DEGRADED_TTL_SECONDS : CACHE_TTL_SECONDS });
        return importSummary(r, false);
      } catch (e) {
        if (e instanceof ImdbError) throw new ToolError(e.message);
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
      const { note, imdb_user, ...profile } = parsed;
      const merged = args.add_to !== undefined ? mergeProfiles(profileArg(args.add_to), profile) : profile;
      // Pages carry no scores: keep saying so after a merge, as long as nothing in the result has a score.
      const keepNote = note ?? (kind === "imdb_page" && merged.seen.length && !Object.keys(merged.ratings ?? {}).length ? NO_SCORES_NOTE : undefined);
      return { ...merged, ...(keepNote ? { note: keepNote } : {}), ...(imdb_user ? { imdb_user } : {}) };
    }
    default:
      throw new ToolError(`unknown tool ${name}`);
  }
}
