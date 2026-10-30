// profile_from_text on the captured IMDb pages, and profile_from_imdb_url against a fake IMDb GraphQL built from the same captures.
import { expect, test } from "bun:test";
import type { Bundle } from "../src/bundle.ts";
import { Catalogue } from "../worker/src/catalogue.ts";
import { GAP_MS, SCORES_QUERY_HASH, parseImdbUserUrl, type ImdbDeps } from "../worker/src/imdb.ts";
import { profileFromText } from "../worker/src/profile.ts";
import { callTool, ToolError, type ProfileStore, type ToolContext } from "../worker/src/tools.ts";

const FX = `${import.meta.dir}/../skill/inflight-movie-picker/test/fixtures`;
const text = (f: string) => Bun.file(`${FX}/${f}`).text();
type Obj = Record<string, unknown>;
const nextData = (html: string) => JSON.parse(html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)![1]!) as { props: { pageProps: { mainColumnData: Obj } } };

const [ratings1, ratings2, watchlist1] = await Promise.all(["imdb-ratings-page1.html", "imdb-ratings-page2.html", "imdb-watchlist-page1.html"].map(text));
const scores1 = JSON.parse(await text("imdb-other-user-rating-page1.json")) as { data: { titles: { id: string; otherUserRating: { value: number } }[] } };
const scores2 = JSON.parse(await text("imdb-other-user-rating-page2.json")) as typeof scores1;
const ratingEdges = (html: string) => (nextData(html).props.pageProps.mainColumnData.advancedTitleSearch as { edges: { node: { title: { id: string } } }[] }).edges;
const watchEdges = (nextData(watchlist1!).props.pageProps.mainColumnData.predefinedList as { titleListItemSearch: { edges: { listItem: { id: string } }[] } }).titleListItemSearch.edges;

// ---------- profile_from_text on real pages ----------

test("imdb_page: a ratings page gives seen ids in order, no scores, a note, and the owner's ur id", () => {
  const p = profileFromText(ratings1!, "imdb_page", {});
  const ids = ratingEdges(ratings1!).map((e) => e.node.title.id);
  expect(p.seen).toEqual(ids);
  expect(p.seen.length).toBe(40);
  expect(p.ratings).toBeUndefined();
  expect(p.watchlist).toBeUndefined();
  expect(p.note).toContain("profile_from_imdb_url");
  expect(p.imdb_user).toBe("ur00000001");
});

test("imdb_page: a watchlist page is detected from predefinedList and honours list: watchlist", () => {
  const ids = watchEdges.map((e) => e.listItem.id);
  for (const list of ["watched", "watchlist"] as const) {
    const p = profileFromText(watchlist1!, "imdb_page", {}, list);
    expect(p.seen).toEqual([]);
    expect(p.watchlist).toEqual(ids);
    expect(p.note).toBeUndefined();
  }
});

// ---------- profile_from_imdb_url ----------

test("parseImdbUserUrl takes profile, ratings, watchlist and locale URLs or bare ids", () => {
  expect(parseImdbUserUrl("https://www.imdb.com/user/p.examplepublicid00000000/ratings/?page=2")).toEqual({ kind: "p", id: "p.examplepublicid00000000" });
  expect(parseImdbUserUrl("imdb.com/de/user/ur00000001/watchlist")).toEqual({ kind: "ur", id: "ur00000001" });
  expect(parseImdbUserUrl("https://m.imdb.com/user/ur00000001")).toEqual({ kind: "ur", id: "ur00000001" });
  expect(parseImdbUserUrl(" UR00000001 ")).toEqual({ kind: "ur", id: "ur00000001" });
  expect(parseImdbUserUrl("https://www.imdb.com/title/tt0111161/")).toBeNull();
  expect(parseImdbUserUrl("https://evil.example/imdb.com/user/ur00000001/")).toBeNull();
});

interface FakeOpts { profileId?: string | null; scores?: "ok" | "gone"; watchlist?: "ok" | "private"; challenge?: boolean; totalRatings?: number }
function fakeImdb(o: FakeOpts = {}) {
  const log: { op: string; body: Obj }[] = [];
  const sleeps: number[] = [];
  const pages = [ratingEdges(ratings1!), ratingEdges(ratings2!)];
  const total = o.totalRatings ?? 80;
  const deps: ImdbDeps = {
    sleep: async (ms) => { sleeps.push(ms); },
    fetch: async (url, init) => {
      expect(url).toBe("https://api.graphql.imdb.com/");
      const body = JSON.parse(String(init.body)) as Obj;
      const q = String(body.query ?? body.operationName);
      const op = q.includes("userProfile") ? "profile" : q.includes("advancedTitleSearch") ? "ratings" : q.includes("predefinedList") ? "watchlist" : String(body.operationName);
      log.push({ op, body });
      if (o.challenge) return new Response("", { status: 202, headers: { "x-amzn-waf-action": "challenge" } });
      const ok = (data: unknown) => Response.json({ data });
      if (op === "profile") return o.profileId === null ? ok({ userProfile: null }) : ok({ userProfile: { userId: o.profileId ?? "ur00000001" } });
      if (op === "ratings") {
        const pos = Number(q.match(/jumpToPosition: (\d+)/)![1]);
        const edges = pos === 1 ? pages[0]! : pos === 251 ? pages[1]! : [];
        return ok({ advancedTitleSearch: { total, pageInfo: { hasNextPage: pos === 1 }, edges } });
      }
      if (op === "watchlist")
        return o.watchlist === "private" ? Response.json({ errors: [{ message: "not authorized" }] }, { status: 400 })
          : ok({ predefinedList: { titleListItemSearch: { total: watchEdges.length, pageInfo: { hasNextPage: false, endCursor: "x" }, edges: watchEdges } } });
      if (op === "PersonalizedUserData") {
        if (o.scores === "gone") return Response.json({ errors: [{ message: "PersistedQueryNotFound" }] });
        const ids = (body.variables as { idArray: string[] }).idArray;
        const all = [...scores1.data.titles, ...scores2.data.titles];
        return ok({ titles: ids.map((id) => all.find((t) => t.id === id) ?? { id, otherUserRating: null }) });
      }
      throw new Error(`unexpected op ${op}`);
    },
  };
  return { deps, log, sleeps };
}

function memoryStore(): ProfileStore & { data: Map<string, { value: string; ttl?: number }> } {
  const data = new Map<string, { value: string; ttl?: number }>();
  return { data, async get(k) { return data.get(k)?.value ?? null; }, async put(k, value, opt) { data.set(k, { value, ttl: opt?.expirationTtl }); } };
}
const bundle = (await Bun.file(`${import.meta.dir}/../worker/test/fixtures/catalogue.sample.json`).json()) as Bundle;
const catalogue = new Catalogue(bundle);
const ctxWith = (deps: ImdbDeps, profiles = memoryStore()): ToolContext & { profiles: ReturnType<typeof memoryStore> } => ({ catalogue, profiles, imdb: deps });

test("profile_from_imdb_url: resolves p. id, reads every ratings page with scores and the watchlist, caches 24 h by ur id", async () => {
  const f = fakeImdb();
  const ctx = ctxWith(f.deps);
  const r = await callTool(ctx, "profile_from_imdb_url", { url: "https://www.imdb.com/user/p.examplepublicid00000000/ratings/" });
  expect(r).toMatchObject({ imdb_user: "ur00000001", profile: { imdb_user: "ur00000001" }, cached: false, seen: 80, rated: 80, total_ratings: 80, watchlist: 40, truncated: false, notes: [] });
  expect(f.log.map((l) => l.op)).toEqual(["profile", "ratings", "ratings", "PersonalizedUserData", "watchlist"]);
  expect((f.log[3]!.body.extensions as { persistedQuery: { sha256Hash: string } }).persistedQuery.sha256Hash).toBe(SCORES_QUERY_HASH);
  expect((f.log[3]!.body.variables as { otherUserId: string }).otherUserId).toBe("ur00000001");
  expect(f.sleeps).toEqual(Array(4).fill(GAP_MS));
  const stored = ctx.profiles.data.get("imdb:ur00000001")!;
  expect(stored.ttl).toBe(24 * 3600);
  const saved = JSON.parse(stored.value) as { profile: { seen: string[]; ratings: Record<string, number>; watchlist: string[] } };
  expect(saved.profile.ratings.tt90000001).toBe(7);
  expect(saved.profile.watchlist.length).toBe(40);
  // The id lists stay on the server; the model gets counts.
  expect(JSON.stringify(r)).not.toContain("tt90000001");

  const again = await callTool(ctx, "profile_from_imdb_url", { url: "https://www.imdb.com/user/ur00000001/" });
  expect(again.cached).toBe(true);
  expect(f.log.length).toBe(5);

  const picks = await callTool(ctx, "picks", { airline: "emirates", profile: { imdb_user: "ur00000001" } });
  expect(picks.profile_source).toBe("imdb profile");
});

test("profile_from_imdb_url: unresolvable p. id tells Claude to find the ur id itself, else ask for the CSV", async () => {
  const f = fakeImdb({ profileId: null });
  const err = await callTool(ctxWith(f.deps), "profile_from_imdb_url", { url: "https://www.imdb.com/user/p.examplepublicid00000000/" }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ToolError);
  expect((err as Error).message).toContain("look for an id that starts with \"ur\"");
  expect((err as Error).message).toContain("CSV export");
});

test("profile_from_imdb_url: a WAF challenge stops at once with the CSV fallback", async () => {
  const f = fakeImdb({ challenge: true });
  const err = await callTool(ctxWith(f.deps), "profile_from_imdb_url", { url: "ur00000001" }).catch((e: unknown) => e);
  expect((err as Error).message).toMatch(/refused.*HTTP 202.*CSV export/s);
  expect(f.log.length).toBe(1);
});

test("profile_from_imdb_url: a dead score hash keeps seen ids with a note; a private watchlist is a note", async () => {
  const f = fakeImdb({ scores: "gone", watchlist: "private" });
  const r = await callTool(ctxWith(f.deps), "profile_from_imdb_url", { url: "ur00000001" });
  expect(r).toMatchObject({ seen: 80, rated: 0, watchlist: 0 });
  const notes = r.notes as string[];
  expect(notes.some((n) => n.includes("score lookup stopped working") && n.includes("CSV export"))).toBe(true);
  expect(notes.some((n) => n.includes("watchlist could not be read"))).toBe(true);
});

test("profile_from_imdb_url: bad URL, no public ratings, expired import", async () => {
  const ctx = ctxWith(fakeImdb({ totalRatings: 0 }).deps);
  await expect(callTool(ctx, "profile_from_imdb_url", { url: "https://letterboxd.com/dave/" })).rejects.toThrow(/not an IMDb profile URL/);
  const empty = fakeImdb({ totalRatings: 0 });
  empty.deps.fetch = async () => Response.json({ data: { advancedTitleSearch: { total: 0, pageInfo: { hasNextPage: false }, edges: [] } } });
  await expect(callTool(ctxWith(empty.deps), "profile_from_imdb_url", { url: "ur1234567" })).rejects.toThrow(/no public ratings/);
  await expect(callTool(ctx, "picks", { airline: "emirates", profile: { imdb_user: "ur7654321" } })).rejects.toThrow(/expired/);
});
