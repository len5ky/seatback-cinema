// The Convex import service's logic (convex/importCore.ts) with an in-memory store that applies the same cap and cache rules as convex/store.ts.
import { expect, test } from "bun:test";
import {
  CACHE_MS, DEFAULT_CAPS, DEGRADED_MS, capsFromEnv, checkCaps, dayOf, expiresAt, runImport, safeEqual, type Caps, type ImportStore, type Reservation,
} from "../convex/importCore.ts";
import type { ImdbDeps, ImdbImport } from "../worker/src/imdb.ts";

type Obj = Record<string, unknown>;
const IDS = ["tt0111161", "tt0068646", "tt0468569", "tt0071562", "tt0050083", "tt0108052"];

/** A tiny IMDb GraphQL: p. id -> ur00000001, one ratings page, scores, a watchlist. */
function fakeImdb(o: { challenge?: boolean; noRatings?: boolean; unknownProfile?: boolean } = {}) {
  const ops: string[] = [];
  const deps: ImdbDeps = {
    sleep: async () => {},
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body)) as Obj;
      const q = String(body.query ?? body.operationName);
      const op = q.includes("userProfile") ? "profile" : q.includes("advancedTitleSearch") ? "ratings" : q.includes("predefinedList") ? "watchlist" : "scores";
      ops.push(op);
      if (o.challenge) return new Response("", { status: 429 });
      const ok = (data: unknown) => Response.json({ data });
      if (op === "profile") return ok({ userProfile: o.unknownProfile ? null : { userId: "ur00000001" } });
      if (op === "ratings") {
        const edges = o.noRatings ? [] : IDS.map((id) => ({ node: { title: { id, titleGenres: { genres: [{ genre: { text: "Drama" } }] }, principalCreditsV2: [] } } }));
        return ok({ advancedTitleSearch: { total: edges.length, pageInfo: { hasNextPage: false }, edges } });
      }
      if (op === "watchlist") return ok({ predefinedList: { titleListItemSearch: { total: 1, pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ listItem: { id: "tt9999999" } }] } } });
      const ids = (body.variables as { idArray: string[] }).idArray;
      return ok({ titles: ids.map((id, i) => ({ id, otherUserRating: { value: 5 + i } })) });
    },
  };
  return { deps, ops };
}

/** Same rules as convex/store.ts: cache rows by key with alias rows, counters per UTC day. */
function memoryStore(caps: Caps = DEFAULT_CAPS, clock = { now: Date.UTC(2026, 9, 31, 12) }) {
  const rows = new Map<string, { ur: string; data?: string; expiresAt: number }>();
  const counters = new Map<string, number>();
  const store: ImportStore = {
    async cached(key) {
      const row = rows.get(key);
      if (!row || row.expiresAt <= clock.now) return null;
      const target = row.data !== undefined ? row : rows.get(row.ur);
      return target?.data !== undefined && target.expiresAt > clock.now ? (JSON.parse(target.data) as ImdbImport) : null;
    },
    async reserve(key, countGlobal): Promise<Reservation> {
      const day = dayOf(clock.now), g = `g:${day}`, u = `u:${key}:${day}`;
      const r = checkCaps(countGlobal ? counters.get(g) ?? 0 : null, counters.get(u) ?? 0, caps);
      if (r.ok) { if (countGlobal) counters.set(g, (counters.get(g) ?? 0) + 1); counters.set(u, (counters.get(u) ?? 0) + 1); }
      return r;
    },
    async save(imp, alias) {
      const exp = expiresAt(imp, clock.now);
      rows.set(imp.imdb_user, { ur: imp.imdb_user, data: JSON.stringify(imp), expiresAt: exp });
      if (alias) rows.set(alias, { ur: imp.imdb_user, expiresAt: exp });
    },
  };
  return { store, rows, counters, clock };
}

const P = "https://www.imdb.com/user/p.examplepublicid00000000/ratings/";

test("caps come from IMPORT_DAILY_CAP / IMPORT_PER_USER_CAP with 2,000 and 10 as defaults", () => {
  expect(DEFAULT_CAPS).toEqual({ daily: 2000, perUser: 10 });
  expect(capsFromEnv({})).toEqual({ daily: 2000, perUser: 10 });
  expect(capsFromEnv({ IMPORT_DAILY_CAP: "50", IMPORT_PER_USER_CAP: "2" })).toEqual({ daily: 50, perUser: 2 });
  expect(capsFromEnv({ IMPORT_DAILY_CAP: "lots", IMPORT_PER_USER_CAP: "-1" })).toEqual({ daily: 2000, perUser: 10 });
  expect(capsFromEnv({ IMPORT_DAILY_CAP: "0" })).toEqual({ daily: 0, perUser: 10 });
});

test("checkCaps: the global cap first, then the profile's own; null skips the global check", () => {
  const caps = { daily: 3, perUser: 2 };
  expect(checkCaps(2, 1, caps)).toEqual({ ok: true });
  expect(checkCaps(3, 0, caps)).toEqual({ ok: false, scope: "daily" });
  expect(checkCaps(0, 2, caps)).toEqual({ ok: false, scope: "user" });
  expect(checkCaps(null, 1, caps)).toEqual({ ok: true });
});

test("safeEqual compares the whole secret", () => {
  expect(safeEqual("abc123", "abc123")).toBe(true);
  expect(safeEqual("abc123", "abc124")).toBe(false);
  expect(safeEqual("abc", "abc123")).toBe(false);
  expect(safeEqual("", "x")).toBe(false);
});

test("runImport: imports a p. link, caches it 24 h under the ur id and the alias, then answers from cache with no IMDb call", async () => {
  const m = memoryStore(), f = fakeImdb();
  const r = await runImport(m.store, f.deps, P);
  expect(r.status).toBe(200);
  if (!r.body.ok) throw new Error("expected ok");
  expect(r.body.cached).toBe(false);
  expect(r.body.import).toMatchObject({ imdb_user: "ur00000001", rated: 6, watchlist: 1, degraded: false });
  expect(r.body.import.profile.ratings).toMatchObject({ tt0111161: 5, tt0108052: 10 });
  expect(f.ops).toEqual(["profile", "ratings", "scores", "watchlist"]);
  expect(r.calls).toBe(4);
  expect(m.rows.get("ur00000001")!.expiresAt - m.clock.now).toBe(CACHE_MS);
  expect(m.rows.get("p.examplepublicid00000000")).toMatchObject({ ur: "ur00000001" });
  // p. id counted once globally and once per id; the ur id once more for itself.
  expect([...m.counters]).toEqual([["g:2026-10-31", 1], ["u:p.examplepublicid00000000:2026-10-31", 1], ["u:ur00000001:2026-10-31", 1]]);

  for (const user of [P, "ur00000001"]) {
    const again = await runImport(m.store, f.deps, user);
    expect(again.body).toMatchObject({ ok: true, cached: true });
    expect(again.calls).toBe(0);
  }
  expect(f.ops.length).toBe(4);
  expect(m.counters.get("g:2026-10-31")).toBe(1);

  m.clock.now += CACHE_MS + 1;
  const later = await runImport(m.store, f.deps, "ur00000001");
  expect(later.body).toMatchObject({ ok: true, cached: false });
});

test("runImport: a degraded import (no scores) is kept an hour", () => {
  const imp = { degraded: true } as ImdbImport;
  expect(expiresAt(imp, 1000)).toBe(1000 + DEGRADED_MS);
});

test("runImport: the per-profile cap stops repeat imports of one profile; the daily cap stops everyone", async () => {
  const caps = { daily: 3, perUser: 2 };
  const m = memoryStore(caps), f = fakeImdb();
  for (let i = 0; i < 2; i++) {
    expect((await runImport(m.store, f.deps, "ur00000001")).status).toBe(200);
    m.rows.clear(); // force a fresh import each time
  }
  const third = await runImport(m.store, f.deps, "ur00000001");
  expect(third).toMatchObject({ status: 429, body: { ok: false, error: "capped", scope: "user" }, calls: 0 });
  expect((await runImport(m.store, f.deps, "ur1234567")).status).toBe(200);
  const full = await runImport(m.store, f.deps, "ur7654321");
  expect(full).toMatchObject({ status: 429, body: { error: "capped", scope: "daily" }, calls: 0 });
  // A new UTC day resets both.
  m.clock.now += 24 * 3600_000;
  expect((await runImport(m.store, f.deps, "ur7654321")).status).toBe(200);
});

test("runImport: a capped ur id stops a p. link to the same profile after the resolve call", async () => {
  const m = memoryStore({ daily: 100, perUser: 1 }), f = fakeImdb();
  expect((await runImport(m.store, f.deps, "ur00000001")).status).toBe(200);
  m.rows.clear();
  const r = await runImport(m.store, f.deps, P);
  expect(r).toMatchObject({ status: 429, body: { error: "capped", scope: "user" }, calls: 1 });
});

test("runImport: bot check, private ratings, unknown profile and a bad id map to their own error codes", async () => {
  const m = memoryStore();
  expect(await runImport(m.store, fakeImdb({ challenge: true }).deps, "ur00000001")).toMatchObject({ status: 502, body: { error: "challenged" }, calls: 1 });
  expect(await runImport(m.store, fakeImdb({ noRatings: true }).deps, "ur00000001")).toMatchObject({ status: 422, body: { error: "private" } });
  expect(await runImport(m.store, fakeImdb({ unknownProfile: true }).deps, P)).toMatchObject({ status: 422, body: { error: "not_found" } });
  expect(await runImport(m.store, fakeImdb().deps, "https://letterboxd.com/dave/")).toMatchObject({ status: 400, body: { error: "bad_request" }, calls: 0 });
  expect(m.rows.size).toBe(0);
});
