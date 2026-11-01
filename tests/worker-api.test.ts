// GET /api/*: same handlers as the MCP tools, fixture catalogue, Convex and Letterboxd stubbed, edge cache as a Map.
import { expect, test } from "bun:test";
import type { Bundle } from "../src/bundle.ts";
import { handleApi, type EdgeCache } from "../worker/src/api.ts";
import { createApp, type Env } from "../worker/src/app.ts";
import { Catalogue } from "../worker/src/catalogue.ts";
import type { ImdbImport } from "../worker/src/imdb.ts";
import { callTool, type ProfileStore, type ToolContext } from "../worker/src/tools.ts";

const bundle = (await Bun.file(`${import.meta.dir}/../worker/test/fixtures/catalogue.sample.json`).json()) as Bundle;
const catalogue = new Catalogue(bundle);
const rss = await Bun.file(`${import.meta.dir}/fixtures/letterboxd/rss.xml`).text();
const B = "https://seatback.test";

function memoryStore(): ProfileStore {
  const data = new Map<string, string>();
  return { async get(k) { return data.get(k) ?? null; }, async put(k, v) { data.set(k, v); } };
}

function mapCache() {
  const m = new Map<string, Response>();
  let puts = 0;
  const cache: EdgeCache = {
    async match(r) { return m.get(r.url)?.clone() as Response | undefined; },
    async put(r, res) { puts++; m.set(r.url, res); },
  };
  return { cache, puts: () => puts };
}

/** Two seen films that are top Emirates picks in the fixture, so hiding them is visible. */
async function topEmirates(n: number): Promise<string[]> {
  const r = await callTool({ catalogue, profiles: memoryStore() }, "picks", { airline: "emirates", limit: n });
  return (r.picks as { imdbId: string }[]).map((p) => p.imdbId);
}
const seen = await topEmirates(2);
const IMPORT: ImdbImport = {
  imdb_user: "ur00000001", rated: 2, total_ratings: 2, watchlist: 1, truncated: false, degraded: false, fetched_at: "2026-10-31T12:00:00.000Z", notes: [],
  profile: { seen, ratings: { [seen[0]!]: 9, [seen[1]!]: 4 }, watchlist: [], source: "imdb_profile" },
};

function setup(convex: () => Response = () => Response.json({ ok: true, cached: true, import: IMPORT })) {
  const calls: string[] = [];
  const ctx: ToolContext = {
    catalogue, profiles: memoryStore(),
    importer: { url: "https://x.convex.site", secret: "s", fetch: async (u, init) => { calls.push(String(init.body)); return convex(); } },
    imdb: { sleep: async () => {}, fetch: async () => new Response("no", { status: 429 }) },
    web: async () => new Response(rss, { status: 200 }),
  };
  const c = mapCache();
  const get = async (path: string, method = "GET") => {
    const res = await handleApi(new Request(B + path, { method }), ctx, c.cache);
    return { res, body: method === "GET" ? ((await res.json()) as Record<string, unknown>) : {} };
  };
  return { ctx, get, calls, puts: c.puts };
}

test("airlines: tool output, open CORS, cached 5 minutes at the edge (miss, then hit)", async () => {
  const t = setup();
  const a = await t.get("/api/airlines");
  expect(a.res.status).toBe(200);
  expect(a.res.headers.get("access-control-allow-origin")).toBe("*");
  expect(a.res.headers.get("cache-control")).toBe("public, max-age=300");
  expect(a.res.headers.get("x-seatback-cache")).toBe("miss");
  expect(a.body).toEqual(await callTool(t.ctx, "list_airlines", {}));
  const b = await t.get("/api/airlines");
  expect(b.res.headers.get("x-seatback-cache")).toBe("hit");
  expect(b.body).toEqual(a.body);
  expect(t.puts()).toBe(1);
});

test("catalogue: query params become the tool's filters", async () => {
  const t = setup();
  const { res, body } = await t.get("/api/catalogue?airline=emirates&genre=Drama,Comedy&min_year=2000&max_runtime=200&q=&limit=3&offset=1");
  expect(res.status).toBe(200);
  expect(body).toEqual(await callTool(t.ctx, "catalogue", {
    airline: "emirates", filters: { genre: ["Drama", "Comedy"], min_year: 2000, max_runtime: 200 }, limit: 3, offset: 1,
  }));
  const fam = await t.get("/api/catalogue?airline=emirates&family=true");
  expect(fam.body).toEqual(await callTool(t.ctx, "catalogue", { airline: "emirates", filters: { family: true } }));
});

test("picks without a profile: the MCP tool's cards, cached", async () => {
  const t = setup();
  const { res, body } = await t.get("/api/picks?airline=emirates&flight_minutes=420&min_year=2010&limit=3");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  expect(body).toEqual(await callTool(t.ctx, "picks", { airline: "emirates", flight_minutes: 420, filters: { min_year: 2010 }, limit: 3 }));
  expect(Object.keys((body.picks as Record<string, unknown>[])[0]!).sort())
    .toEqual(Object.keys(((await callTool(t.ctx, "picks", { airline: "emirates", limit: 1 })).picks as Record<string, unknown>[])[0]!).sort());
});

test("picks with imdb: Convex import, seen films hidden, never cached, KV reused on the next call", async () => {
  const t = setup();
  const { res, body } = await t.get("/api/picks?airline=emirates&imdb=p.examplepublicid00000000&limit=3");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("x-seatback-cache")).toBe("bypass");
  expect(body.hidden_seen).toBe(2);
  expect(body.profile_source).toBe("imdb profile");
  expect((body.picks as { imdbId: string }[]).some((p) => seen.includes(p.imdbId))).toBe(false);
  expect(body.profile_import).toMatchObject({ imdb_user: "ur00000001", cached: true, seen: 2, rated: 2, watchlist: 1 });
  expect(t.calls).toEqual([JSON.stringify({ user: "p.examplepublicid00000000" })]);
  await t.get("/api/picks?airline=emirates&imdb=https://www.imdb.com/user/ur00000001/ratings/");
  expect(t.calls.length).toBe(1);
  expect(t.puts()).toBe(0);
});

test("profile: imports and returns a taste code that picks?code= reads", async () => {
  const t = setup();
  const { res, body } = await t.get("/api/profile?imdb=https://www.imdb.com/user/ur00000001/");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(body).toEqual({ code: expect.stringMatching(/^[a-z0-9]{20}$/), rated: 2, watchlist: 1 });
  const p = await t.get(`/api/picks?airline=emirates&code=${String(body.code)}`);
  expect(p.body).toMatchObject({ hidden_seen: 2, profile_source: "saved profile" });
  expect(t.puts()).toBe(0);
});

test("picks with letterboxd: the feed's profile is applied", async () => {
  const t = setup();
  const { res, body } = await t.get("/api/picks?airline=emirates&letterboxd=dave");
  expect(res.status).toBe(200);
  expect(body.profile_import).toMatchObject({ username: "dave", entries: 5 });
  expect(body.profile_source).not.toBe("none");
});

test("errors are { error, hint } with real status codes", async () => {
  const t = setup();
  const cases: [string, number, string][] = [
    ["/api/picks?airline=klingon", 404, "unknown_airline"],
    ["/api/picks", 400, "missing_airline"],
    ["/api/catalogue?airline=emirates&min_year=soon", 400, "bad_request"],
    ["/api/catalogue?airline=emirates&family=maybe", 400, "bad_request"],
    ["/api/picks?airline=emirates&colour=red", 400, "unknown_param"],
    ["/api/picks?airline=emirates&imdb=ur1234567&code=abc", 400, "too_many_profiles"],
    ["/api/picks?airline=emirates&imdb=https://example.com/me", 400, "bad_request"],
    ["/api/picks?airline=emirates&code=nope", 400, "bad_request"],
    ["/api/picks?airline=emirates&code=aaaaaaaaaaaaaaaaaaaa", 404, "unknown_code"],
    ["/api/profile", 400, "missing_imdb"],
    ["/api/films", 404, "not_found"],
  ];
  for (const [path, status, error] of cases) {
    const { res, body } = await t.get(path);
    expect([path, res.status, body.error]).toEqual([path, status, error]);
    expect(typeof body.hint).toBe("string");
    expect(res.headers.get("cache-control")).toBe("no-store");
  }
  expect(t.calls.length).toBe(0); // a bad airline or filter is caught before any import
  const lb = setup();
  lb.ctx.web = async () => new Response("", { status: 404 });
  expect((await lb.get("/api/picks?airline=emirates&letterboxd=nobody")).res.status).toBe(404);
  const post = await t.get("/api/airlines", "POST");
  expect(post.res.status).toBe(405);
});

test("Convex refusals map to 429 / 403 / 503 and never fall back to IMDb directly", async () => {
  for (const [body, status, error] of [
    [{ error: "capped", scope: "day" }, 429, "capped"],
    [{ error: "private" }, 403, "private_profile"],
    [{ error: "challenged" }, 503, "imdb_bot_check"],
    [{ error: "not_found" }, 404, "imdb_not_found"],
  ] as const) {
    const t = setup(() => Response.json({ ok: false, ...body }, { status: 400 }));
    const r = await t.get("/api/profile?imdb=ur00000001");
    expect([r.res.status, r.body.error]).toEqual([status, error]);
  }
});

test("pretty=1 indents; the app routes /api and OPTIONS through the same handler", async () => {
  const t = setup();
  const res = await handleApi(new Request(`${B}/api/airlines?pretty=1`), t.ctx);
  expect(await res.text()).toStartWith("{\n  \"airlines\"");
  const app = createApp(bundle, { cache: mapCache().cache });
  const env: Env = { PROFILES: memoryStore(), ASSETS: { fetch: async () => new Response("asset") } };
  const r = await app.fetch(new Request(`${B}/api/catalogue?airline=qantas&limit=2`), env);
  expect(r.status).toBe(200);
  expect(((await r.json()) as { rows: unknown[] }).rows.length).toBe(2);
  expect((await app.fetch(new Request(`${B}/api/picks`, { method: "OPTIONS" }), env)).status).toBe(204);
  expect((await app.fetch(new Request(`${B}/api`), env)).status).toBe(200);
});

test("review fixes: blank or repeated profile params bypass the cache, /api/profile reuses its code, HEAD has no body", async () => {
  const t = setup();
  for (const q of ["code=", "imdb=%20%20", "code=&code=aaaaaaaaaaaaaaaaaaaa", "letterboxd="]) {
    const { res } = await t.get(`/api/picks?airline=emirates&${q}`);
    expect([q, res.headers.get("x-seatback-cache")]).toEqual([q, "bypass"]);
  }
  expect(t.puts()).toBe(0);
  const a = await t.get("/api/profile?imdb=ur00000001");
  const b = await t.get("/api/profile?imdb=https://www.imdb.com/user/ur00000001/ratings/");
  expect(b.body.code).toBe(a.body.code);
  for (const path of ["/api", "/api/nope", "/api/airlines", "/api/profile?imdb=ur00000001"]) {
    const res = await handleApi(new Request(B + path, { method: "HEAD" }), t.ctx);
    expect([path, await res.text()]).toEqual([path, ""]);
  }
});
