// profile_from_imdb_url through the Convex import service (stubbed), with the direct IMDb route as the fallback.
import { expect, test } from "bun:test";
import type { Bundle } from "../src/bundle.ts";
import { Catalogue } from "../worker/src/catalogue.ts";
import type { ImdbDeps, ImdbImport } from "../worker/src/imdb.ts";
import { callTool, ToolError, type ProfileStore, type ToolContext } from "../worker/src/tools.ts";

const bundle = (await Bun.file(`${import.meta.dir}/../worker/test/fixtures/catalogue.sample.json`).json()) as Bundle;
const catalogue = new Catalogue(bundle);
const P = "https://www.imdb.com/user/p.examplepublicid00000000/ratings/";

const IMPORT: ImdbImport = {
  imdb_user: "ur00000001", rated: 2, total_ratings: 2, watchlist: 1, truncated: false, degraded: false, fetched_at: "2026-10-31T12:00:00.000Z", notes: [],
  profile: { seen: ["tt31193180", "tt5950044"], ratings: { tt31193180: 9, tt5950044: 4 }, watchlist: ["tt26581740"], liked_genres: ["Horror"], source: "imdb_profile" },
};

function memoryStore() {
  const data = new Map<string, { value: string; ttl?: number }>();
  const s: ProfileStore = { async get(k) { return data.get(k)?.value ?? null; }, async put(k, value, opt) { data.set(k, { value, ttl: opt?.expirationTtl }); } };
  return { s, data };
}

/** Convex answering with `res`; IMDb direct counting its calls (and refusing, as it does from Cloudflare). */
function setup(res: () => Response | Promise<Response>) {
  const store = memoryStore();
  const convex: { url: string; init: RequestInit }[] = [];
  let direct = 0;
  const imdb: ImdbDeps = { sleep: async () => {}, fetch: async () => { direct++; return new Response("Too many network requests", { status: 429 }); } };
  const ctx: ToolContext = {
    catalogue, profiles: store.s, imdb,
    importer: { url: "https://example-123.convex.site/", secret: "s3cret", fetch: async (url, init) => { convex.push({ url, init }); return res(); } },
  };
  return { ctx, store, convex, direct: () => direct };
}

const ok = (cached = false) => () => Response.json({ ok: true, cached, import: IMPORT });
const err = (status: number, body: Record<string, unknown>) => () => Response.json({ ok: false, ...body }, { status });

test("Convex first: one POST with the secret, KV cache 24 h by ur id plus the p. alias, then cache hits make no call at all", async () => {
  const t = setup(ok());
  const r = await callTool(t.ctx, "profile_from_imdb_url", { url: P });
  expect(r).toMatchObject({ imdb_user: "ur00000001", profile: { imdb_user: "ur00000001" }, cached: false, seen: 2, rated: 2, watchlist: 1, liked_genres: ["Horror"] });
  expect(t.convex.length).toBe(1);
  expect(t.convex[0]!.url).toBe("https://example-123.convex.site/import/imdb");
  expect((t.convex[0]!.init.headers as Record<string, string>)["x-import-secret"]).toBe("s3cret");
  expect(JSON.parse(String(t.convex[0]!.init.body))).toEqual({ user: "p.examplepublicid00000000" });
  expect(t.store.data.get("imdb:ur00000001")!.ttl).toBe(24 * 3600);
  expect(t.store.data.get("imdbp:p.examplepublicid00000000")).toEqual({ value: "ur00000001", ttl: 24 * 3600 });
  expect(t.direct()).toBe(0);
  expect(JSON.stringify(r)).not.toContain("tt31193180");

  for (const url of [P, "ur00000001"]) expect((await callTool(t.ctx, "profile_from_imdb_url", { url })).cached).toBe(true);
  expect(t.convex.length).toBe(1);

  const picks = await callTool(t.ctx, "picks", { airline: "emirates", profile: { imdb_user: "ur00000001" } });
  expect(picks.profile_source).toBe("imdb profile");
  expect((picks.picks as { imdbId: string }[]).some((p) => p.imdbId === "tt31193180")).toBe(false);
});

test("Convex refusals become clear errors and never fall through to the direct route", async () => {
  const cases: [() => Response, RegExp][] = [
    [err(429, { error: "capped", scope: "daily" }), /limit for today/],
    [err(429, { error: "capped", scope: "user" }), /as many times as allowed today/],
    [err(502, { error: "challenged", message: "IMDb refused" }), /bot check.*Don't retry/s],
    [err(422, { error: "private", message: "no public ratings" }), /private.*Settings, Privacy/s],
    [err(422, { error: "not_found", message: "x" }), /doesn't know this profile id/],
    [err(422, { error: "imdb_error", message: "IMDb's API rejected the request for the scores" }), /API rejected/],
  ];
  for (const [res, msg] of cases) {
    const t = setup(res);
    const e = await callTool(t.ctx, "profile_from_imdb_url", { url: P }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ToolError);
    expect((e as Error).message).toMatch(msg);
    expect(t.direct()).toBe(0);
    expect(t.store.data.size).toBe(0);
  }
});

test("Convex down (5xx, 401, network, junk) falls back to the direct route, which reports IMDb's refusal", async () => {
  const downs: (() => Response | Promise<Response>)[] = [
    () => new Response("oops", { status: 500 }),
    err(401, { error: "unauthorized" }),
    () => Promise.reject(new TypeError("fetch failed")),
    () => Response.json({ ok: true, import: { imdb_user: "nope" } }),
  ];
  for (const res of downs) {
    const t = setup(res);
    const e = await callTool(t.ctx, "profile_from_imdb_url", { url: "ur00000001" }).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/refused.*HTTP 429/s);
    expect(t.convex.length).toBe(1);
    expect(t.direct()).toBe(1);
  }
});

test("A degraded import from Convex is cached for an hour; a bad profile id list is cleaned", async () => {
  const t = setup(() => Response.json({ ok: true, cached: false, import: { ...IMPORT, degraded: true, profile: { ...IMPORT.profile, seen: ["tt31193180", " tt31193180 "] } } }));
  const r = await callTool(t.ctx, "profile_from_imdb_url", { url: "ur00000001" });
  expect(r.seen).toBe(1);
  expect(t.store.data.get("imdb:ur00000001")!.ttl).toBe(3600);
});

test("Without an importer the tool goes straight to IMDb, as before", async () => {
  const t = setup(ok());
  delete t.ctx.importer;
  await expect(callTool(t.ctx, "profile_from_imdb_url", { url: "ur00000001" })).rejects.toThrow(/HTTP 429/);
  expect(t.convex.length).toBe(0);
  expect(t.direct()).toBe(1);
});
