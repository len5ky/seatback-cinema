// GET API over the same tool handlers as /mcp: query params in, JSON out, CORS open.
// Non-personal calls (airlines, catalogue, picks without a profile) are cached 5 minutes at the edge.
import { ToolError, callTool, type ToolContext } from "./tools.ts";

/** The slice of the Workers Cache API used here (caches.default in production, absent in tests unless stubbed). */
export interface EdgeCache {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
}
export interface WaitUntil { waitUntil(p: Promise<unknown>): void }

export const API_CACHE_SECONDS = 300;
/** As long as an IMDb import is kept (24 h). */
const CODE_REUSE_SECONDS = 24 * 3600;
const FILTER_PARAMS = ["genre", "exclude_genre", "min_year", "max_year", "min_runtime", "max_runtime", "family", "language", "q"] as const;
const PROFILE_PARAMS = ["imdb", "letterboxd", "code"] as const;
const ROUTES: Record<string, readonly string[]> = {
  "/api/airlines": [],
  "/api/catalogue": ["airline", ...FILTER_PARAMS, "limit", "offset"],
  "/api/picks": ["airline", "flight_minutes", ...FILTER_PARAMS, "limit", ...PROFILE_PARAMS],
  "/api/profile": ["imdb"],
};
const INDEX = {
  endpoints: Object.fromEntries(Object.entries(ROUTES).map(([path, params]) => [path, params])),
  notes: "Lists (genre, exclude_genre) are comma-separated; family is true or false. picks takes at most one of imdb (profile URL or ur / p. id), letterboxd (username) or code (taste code). Add pretty=1 for indented JSON.",
};

type Json = Record<string, unknown>;
class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, hint: string) { super(hint); }
}

/** A whole-number param stays a string when it isn't one, so the tool's own range check names it in the error. */
function num(v: string): number | string {
  return /^-?\d+$/.test(v.trim()) ? Number(v) : v;
}

function bool(key: string, v: string): boolean {
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes"].includes(s)) return true;
  if (["0", "false", "no"].includes(s)) return false;
  throw new ApiError(400, "bad_request", `${key} must be true or false`);
}

function filtersFrom(q: URLSearchParams): Json {
  const f: Json = {};
  for (const k of FILTER_PARAMS) {
    const v = q.get(k);
    if (v === null || v.trim() === "") continue;
    if (k === "genre" || k === "exclude_genre") f[k] = v.split(",").map((g) => g.trim()).filter(Boolean);
    else if (k === "family") f.family = bool(k, v);
    else if (k === "language") f.language = v.trim();
    else if (k === "q") f.query = v.trim();
    else f[k] = num(v);
  }
  return f;
}

function ints(q: URLSearchParams, keys: string[]): Json {
  const out: Json = {};
  for (const k of keys) {
    const v = q.get(k);
    if (v !== null && v.trim() !== "") out[k] = num(v);
  }
  return out;
}

/** The route's answer and whether it depends on the person (personal answers are never cached). */
async function route(ctx: ToolContext, path: string, q: URLSearchParams): Promise<{ body: Json; personal: boolean }> {
  const allowed = ROUTES[path]!;
  const unknown = [...q.keys()].filter((k) => k !== "pretty" && !allowed.includes(k));
  if (unknown.length)
    throw new ApiError(400, "unknown_param", `unknown parameter ${[...new Set(unknown)].join(", ")}; ${path} takes ${allowed.length ? allowed.join(", ") : "no parameters"}`);
  const str = (k: string) => q.get(k)?.trim() || undefined;

  switch (path) {
    case "/api/airlines":
      return { body: await callTool(ctx, "list_airlines", {}), personal: false };
    case "/api/catalogue":
      return { body: await callTool(ctx, "catalogue", { airline: str("airline"), filters: filtersFrom(q), ...ints(q, ["limit", "offset"]) }), personal: false };
    case "/api/picks": {
      const given = PROFILE_PARAMS.filter((k) => str(k));
      if (given.length > 1) throw new ApiError(400, "too_many_profiles", `pass one of imdb, letterboxd or code, not ${given.join(" and ")}`);
      const args: Json = { airline: str("airline"), filters: filtersFrom(q), ...ints(q, ["flight_minutes", "limit"]) };
      // Check the airline and filters before spending an IMDb import or a Letterboxd fetch on them.
      if (given.length) await callTool(ctx, "picks", { ...args, limit: 1 });
      const extra: Json = {};
      if (given[0] === "imdb") {
        const imp = await callTool(ctx, "profile_from_imdb_url", { url: str("imdb") });
        args.profile = imp.profile;
        extra.profile_import = { imdb_user: imp.imdb_user, cached: imp.cached, fetched_at: imp.fetched_at, seen: imp.seen, rated: imp.rated, watchlist: imp.watchlist, notes: imp.notes };
      } else if (given[0] === "letterboxd") {
        const lb = await callTool(ctx, "profile_from_letterboxd", { username: str("letterboxd") });
        args.profile = lb.profile;
        extra.profile_import = { username: lb.username, entries: lb.entries, rated: lb.rated, matched: lb.matched, note: lb.note };
      } else if (given[0] === "code") {
        args.profile = { token: str("code") };
      }
      const picks = await callTool(ctx, "picks", args);
      return { body: { ...picks, ...extra }, personal: given.length > 0 };
    }
    case "/api/profile": {
      const url = str("imdb");
      if (!url) throw new ApiError(400, "missing_imdb", "imdb is required: a public IMDb profile URL like https://www.imdb.com/user/ur12345678/ratings/ or the bare ur / p. id");
      const imp = await callTool(ctx, "profile_from_imdb_url", { url });
      // One code per import: repeat calls while the import is cached get the same code, not a new KV entry each time.
      const reuse = `apicode:${String(imp.imdb_user)}:${String(imp.fetched_at)}`;
      let code = await ctx.profiles.get(reuse);
      if (!code) {
        code = String((await callTool(ctx, "save_profile", { profile: imp.profile })).token);
        await ctx.profiles.put(reuse, code, { expirationTtl: CODE_REUSE_SECONDS });
      }
      return { body: { code, rated: imp.rated, watchlist: imp.watchlist }, personal: true };
    }
  }
  throw new ApiError(404, "not_found", `no such endpoint; try ${Object.keys(ROUTES).join(", ")}`);
}

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400",
  "Content-Type": "application/json; charset=utf-8",
};

function reply(body: unknown, status: number, pretty: boolean, cacheControl: string): Response {
  return new Response(JSON.stringify(body, null, pretty ? 2 : undefined) + (pretty ? "\n" : ""), { status, headers: { ...HEADERS, "Cache-Control": cacheControl } });
}

/** GET /api/... ; cache is the edge cache for non-personal answers. HEAD gets the same headers and no body. */
export async function handleApi(req: Request, ctx: ToolContext, cache?: EdgeCache, wait?: WaitUntil): Promise<Response> {
  const res = await answer(req, ctx, cache, wait);
  return req.method === "HEAD" ? new Response(null, res) : res;
}

async function answer(req: Request, ctx: ToolContext, cache?: EdgeCache, wait?: WaitUntil): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  const url = new URL(req.url);
  const pretty = ["1", "true"].includes(url.searchParams.get("pretty") ?? "");
  if (req.method !== "GET" && req.method !== "HEAD") {
    const r = reply({ error: "method_not_allowed", hint: "the API is read-only; use GET" }, 405, pretty, "no-store");
    r.headers.set("Allow", "GET, HEAD, OPTIONS");
    return r;
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/api") return reply(INDEX, 200, pretty, `public, max-age=${API_CACHE_SECONDS}`);
  if (!(path in ROUTES)) return reply({ error: "not_found", hint: `no such endpoint; try ${Object.keys(ROUTES).join(", ")}` }, 404, pretty, "no-store");

  // Only profile-free calls can be cached; checking the params first keeps a personal call from ever reaching the cache.
  // Any profile param, even a blank or repeated one, keeps the call out of the cache.
  const personalCall = path === "/api/profile" || PROFILE_PARAMS.some((k) => url.searchParams.has(k));
  const key = new Request(url.toString(), { method: "GET" });
  if (!personalCall && cache) {
    const hit = await cache.match(key);
    if (hit) {
      const r = new Response(hit.body, hit);
      r.headers.set("X-Seatback-Cache", "hit");
      return r;
    }
  }

  let res: Response;
  try {
    const { body, personal } = await route(ctx, path, url.searchParams);
    res = reply(body, 200, pretty, personal || personalCall ? "private, no-store" : `public, max-age=${API_CACHE_SECONDS}`);
    if (!personal && !personalCall && cache) {
      const put = cache.put(key, res.clone() as Response).catch((err: unknown) => console.error("edge cache put failed", err));
      if (wait) wait.waitUntil(put); else await put;
    }
  } catch (e) {
    if (e instanceof ApiError || e instanceof ToolError) {
      res = reply({ error: e.code, hint: e.message }, e.status, pretty, "no-store");
    } else {
      console.error("api failed", path, e);
      res = reply({ error: "internal", hint: "something broke on our side; try again, and report it if it keeps failing" }, 500, pretty, "no-store");
    }
  }
  res.headers.set("X-Seatback-Cache", personalCall ? "bypass" : "miss");
  return res;
}
