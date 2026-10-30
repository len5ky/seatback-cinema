import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  API_PAGES_PER_REQUEST, blockedHelp, fetchImdbProfile, MAX_PAGES, fetchLetterboxdProfile, imdbUserId, isChallenge, letterboxdUser, parseImdbOwnerRatings,
  parseImdbPage, parseLetterboxdPage, ProfileBlocked,
} from "../skill/inflight-movie-picker/scripts/profile.ts";

// Fixtures are real pages captured through a browser on 2026-10-30, reduced (see the comment at the top of each).
// Nothing here touches the network: fetches go to an in-process mock or a loopback server.
const FIX = `${import.meta.dir}/../skill/inflight-movie-picker/test/fixtures`;
const fx = (name: string) => readFileSync(`${FIX}/${name}`, "utf8");
const SCRIPT = `${import.meta.dir}/../skill/inflight-movie-picker/scripts/catalogue.ts`;
const IMDB_URL = "https://www.imdb.com/user/p.examplepublicid00000000/ratings/";

const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": "text/html", ...headers } });

/** idArray in, the owner's ratings for those ids out, from both captured GraphQL answers. */
function graphqlReply(init?: RequestInit): Response {
  const ids = new Set<string>((JSON.parse(String(init?.body)) as { variables: { idArray: string[] } }).variables.idArray);
  const all = [fx("imdb-other-user-rating-page1.json"), fx("imdb-other-user-rating-page2.json")]
    .flatMap((t) => (JSON.parse(t) as { data: { titles: { id: string }[] } }).data.titles);
  return new Response(JSON.stringify({ data: { titles: all.filter((t) => ids.has(t.id)) } }), { headers: { "content-type": "application/json" } });
}

/** Raw GraphQL queries (the API route) are refused here, so these mocks exercise the HTML page fallback. */
const isRawQuery = (init?: RequestInit) => "query" in (JSON.parse(String(init?.body ?? "{}")) as object);

function imdbMock(opts: { block?: boolean; graphqlStatus?: number } = {}) {
  const calls: string[] = [];
  const f = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);
    if (url.includes("graphql") && isRawQuery(init)) return new Response("", { status: 429 });
    if (url.includes("graphql")) return opts.graphqlStatus ? new Response("no", { status: opts.graphqlStatus }) : graphqlReply(init);
    if (opts.block) return html("", 202, { "x-amzn-waf-action": "challenge" });
    if (url.includes("/watchlist/")) return html(fx("imdb-watchlist-page1.html"));
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    return html(fx(page === 1 ? "imdb-ratings-page1.html" : "imdb-ratings-page2.html")); // page 3+ repeats page 2: no new ids, stop
  };
  return { f, calls };
}

test("profile URLs: IMDb p.* and ur ids, Letterboxd usernames", () => {
  expect(imdbUserId(IMDB_URL)).toBe("p.examplepublicid00000000");
  expect(imdbUserId("https://www.imdb.com/user/ur00000001/watchlist")).toBe("ur00000001");
  expect(imdbUserId("p.abc123")).toBe("p.abc123");
  expect(() => imdbUserId("https://www.imdb.com/title/tt0111161/")).toThrow("not an IMDb profile URL");
  expect(letterboxdUser("https://letterboxd.com/dave/films/ratings/")).toBe("dave");
  expect(letterboxdUser("letterboxd.com/some_user")).toBe("some_user");
  expect(letterboxdUser("dave")).toBe("dave");
  expect(() => letterboxdUser("https://letterboxd.com/film/wildwood-2026/")).toThrow("not a Letterboxd profile URL");
  expect(() => imdbUserId("https://evil.example/user/ur00000001/ratings/")).toThrow("not an IMDb profile URL");
  expect(() => letterboxdUser("https://notletterboxd.com/dave/films/")).toThrow("not a Letterboxd profile URL");
  expect(() => letterboxdUser("https://evil.com/letterboxd.com/dave")).toThrow("not a Letterboxd profile URL");
});

test("IMDb ratings page: 250-per-page __NEXT_DATA__, owner id, total and next-page flag", () => {
  const p = parseImdbPage(fx("imdb-ratings-page1.html"));
  expect(p.kind).toBe("ratings");
  expect(p.userId).toBe("ur00000001");
  expect(p.total).toBe(900);
  expect(p.page).toBe(1);
  expect(p.hasNext).toBe(true);
  expect(p.items).toHaveLength(40); // the fixture keeps 40 of the page's 250 edges
  expect(p.items[0]).toEqual({ tconst: "tt90000001", title: "Example Film 001", year: 2026, genres: ["Horror"], directors: ["Example Director 01"] });
  const p2 = parseImdbPage(fx("imdb-ratings-page2.html"));
  expect(p2.page).toBe(2);
  expect(p2.items[0]!.title).toBe("Example Film 041");
  expect(new Set([...p.items, ...p2.items].map((i) => i.tconst)).size).toBe(80);
});

test("IMDb watchlist page and the owner-rating GraphQL answer", () => {
  const w = parseImdbPage(fx("imdb-watchlist-page1.html"));
  expect(w.kind).toBe("watchlist");
  expect(w.total).toBe(100);
  expect(w.hasNext).toBe(false);
  expect(w.items[0]!.tconst).toBe("tt91000001");
  expect(w.items[0]!.title).toBe("Example Watchlist Film 001");
  const r = parseImdbOwnerRatings(fx("imdb-other-user-rating-page1.json"));
  expect(r.size).toBe(40);
  expect(r.get("tt90000001")).toBe(7);
  expect(r.get("tt90000002")).toBe(7);
  expect(parseImdbOwnerRatings("<html>").size).toBe(0);
});

test("IMDb challenge and private pages are reported as blocked", () => {
  expect(isChallenge(202, new Headers({ "x-amzn-waf-action": "challenge" }), "")).toBe(true);
  expect(isChallenge(200, new Headers(), "<title>Just a moment...</title>")).toBe(true);
  expect(isChallenge(200, new Headers(), fx("imdb-ratings-page1.html"))).toBe(false);
  expect(() => parseImdbPage("")).toThrow(ProfileBlocked);
  const priv = fx("imdb-watchlist-page1.html").replace('"showPrivateListMessaging":false', '"showPrivateListMessaging":true');
  expect(() => parseImdbPage(priv)).toThrow("private");
});

test("Letterboxd films page: 72 per page, title and year split, half-star ratings on a 10-point scale", () => {
  const p = parseLetterboxdPage(fx("letterboxd-films-page1.html"));
  expect(p.items).toHaveLength(72);
  expect(p.items[0]).toEqual({ slug: "wildwood-2026", title: "Wildwood", year: 2026, rating: 9 });
  expect(p.items[1]).toEqual({ slug: "whalefall", title: "Whalefall", year: 2026, rating: 7 });
  expect(p.hasNext).toBe(true);
  expect(p.lastPage).toBe(37);
  const p2 = parseLetterboxdPage(fx("letterboxd-films-page2.html"));
  expect(p2.items[0]).toMatchObject({ slug: "the-thursday-murder-club", title: "The Thursday Murder Club", year: 2025, rating: 6 });
  expect(p2.items.find((i) => i.slug.startsWith("lilo"))?.title).toBe("Lilo & Stitch");
  const w = parseLetterboxdPage(fx("letterboxd-watchlist-page1.html"));
  expect(w.items[0]).toEqual({ slug: "big-world-2024", title: "Big World", year: 2024, rating: null });
  expect(w.lastPage).toBe(23);
});

test("fetchImdbProfile (page fallback): paginates until no new ids, reads scores over GraphQL, builds the shared Profile", async () => {
  const { f, calls } = imdbMock();
  const p = await fetchImdbProfile(IMDB_URL, { fetch: f, delayMs: 0 });
  expect(p.seen).toHaveLength(80);
  expect(p.watchlist).toHaveLength(40);
  expect(p.ratings?.tt90000001).toBe(7);
  expect(Object.keys(p.ratings ?? {})).toHaveLength(80);
  expect(p.source).toBe("imdb:p.examplepublicid00000000");
  expect(p.titles.tt91000001?.title).toBe("Example Watchlist Film 001");
  expect(p.notes).toEqual([]);
  expect(Array.isArray(p.liked_genres)).toBe(true);
  // the refused API call, pages 1, 2 and 3 (3 repeats 2, so the loop stops), one watchlist page, one score batch
  expect(calls.filter((u) => u.includes("/ratings/"))).toHaveLength(3);
  expect(calls.filter((u) => u.includes("graphql"))).toHaveLength(2);
});

test("fetchImdbProfile: a failed score lookup keeps the seen list and says so; a WAF 202 throws ProfileBlocked", async () => {
  const noScores = await fetchImdbProfile(IMDB_URL, { fetch: imdbMock({ graphqlStatus: 403 }).f, delayMs: 0 });
  expect(noScores.seen).toHaveLength(80);
  expect(noScores.ratings).toBeUndefined();
  expect(noScores.notes[0]).toContain("HTTP 403");
  const challenged = await fetchImdbProfile(IMDB_URL, { fetch: imdbMock({ graphqlStatus: 202 }).f, delayMs: 0 });
  expect(challenged.ratings).toBeUndefined();
  expect(challenged.notes.some((n) => n.includes("could not read the scores") && n.includes("HTTP 202"))).toBe(true);
  const err = await fetchImdbProfile(IMDB_URL, { fetch: imdbMock({ block: true }).f, delayMs: 0 }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProfileBlocked);
  expect((err as ProfileBlocked).message).toContain("HTTP 202, challenge");
  const help = blockedHelp("imdb", (err as ProfileBlocked).message);
  expect(help.split("\n")).toHaveLength(2);
  expect(help).toContain("https://www.imdb.com/list/ratings/export");
  expect(help).toContain("--taste");
});

// ---- the GraphQL route (synthetic fixtures: ur10000001, tt9000001..8 rated, tt9100001..2 on the watchlist) -------

const gqlFx = (name: string) => new Response(fx(name), { headers: { "content-type": "application/json" } });
const SYN_URL = "https://www.imdb.com/user/p.syntheticprofile01/ratings/";

/** A fake api.graphql.imdb.com: answers by what the query asks for; `fail` picks a request to break. */
function apiMock(opts: { fail?: "resolve" | "first" | "rest" | "scores"; failWith?: number } = {}) {
  const bodies: { query?: string; operationName?: string; variables?: { idArray?: string[] } }[] = [];
  const pages: string[] = [];
  const f = async (url: string, init?: RequestInit): Promise<Response> => {
    if (!url.includes("graphql")) { pages.push(url); return html(fx(url.includes("/watchlist/") ? "imdb-watchlist-page1.html" : "imdb-ratings-page1.html")); }
    const b = JSON.parse(String(init?.body)) as (typeof bodies)[number];
    bodies.push(b);
    const kind = b.operationName === "PersonalizedUserData" ? "scores" : b.query?.includes("userProfile") ? "resolve" : b.query?.includes("p0:") ? "first" : "rest";
    if (opts.fail === kind) return opts.failWith ? new Response("", { status: opts.failWith }) : new Response(JSON.stringify({ errors: [{ message: "Cannot query field" }], data: null }), { status: 400 });
    if (kind === "scores") return gqlFx("imdb-gql-scores.json");
    return gqlFx(kind === "resolve" ? "imdb-gql-user-profile.json" : kind === "first" ? "imdb-gql-first.json" : "imdb-gql-rest.json");
  };
  return { f, bodies, pages };
}

test("fetchImdbProfile (API): p. id -> ur id, ratings pages batched as aliases, watchlist and scores; no HTML pages", async () => {
  const m = apiMock();
  const p = await fetchImdbProfile(SYN_URL, { fetch: m.f, delayMs: 0 });
  expect(m.pages).toEqual([]);
  expect(m.bodies).toHaveLength(4); // resolve, ratings page 1 + watchlist, ratings pages 2-5, one score batch
  expect(m.bodies[0]!.query).toContain('userProfile(input: { profileId: "p.syntheticprofile01" })');
  expect(m.bodies[1]!.query).toMatch(/p0: advancedTitleSearch\(first: 250, jumpToPosition: 1,.*userId: "ur10000001".*wl: predefinedList\(classType: WATCH_LIST, userId: "ur10000001"\)/s);
  expect(m.bodies[2]!.query).toMatch(/p1: advancedTitleSearch\(first: 250, jumpToPosition: 251,.*p4: advancedTitleSearch\(first: 250, jumpToPosition: 1001,/s);
  expect(m.bodies[3]!.variables?.idArray).toHaveLength(8);
  expect(p.seen).toEqual(["tt9000001", "tt9000002", "tt9000003", "tt9000004", "tt9000005", "tt9000006", "tt9000007", "tt9000008"]);
  expect(p.watchlist).toEqual(["tt9100001", "tt9100002"]);
  expect(p.ratings?.tt9000001).toBe(9);
  expect(p.titles.tt9100002).toEqual({ title: "Synthetic Watchlist Two", year: 2025 });
  expect(p.titles.tt9000005).toEqual({ title: "Synthetic Musical", year: 2022, rating: 3 });
  expect(p.liked_genres?.[0]).toBe("Horror");
  expect(p.disliked_genres).toContain("Musical");
  expect(p.liked_directors).toEqual(["Dir Alpha"]);
  expect(p.notes).toEqual([]);
  expect(p.source).toBe("imdb:p.syntheticprofile01");
});

test("fetchImdbProfile (API): a ur URL skips the resolve call", async () => {
  const m = apiMock();
  const p = await fetchImdbProfile("https://www.imdb.com/user/ur10000001/", { fetch: m.f, delayMs: 0 });
  expect(m.bodies).toHaveLength(3);
  expect(p.seen).toHaveLength(8);
});

test("fetchImdbProfile (API): a refused or broken start falls back to the HTML pages", async () => {
  for (const [fail, failWith] of [["resolve", 429], ["first", 0], ["first", 202]] as const) {
    const m = apiMock({ fail, failWith });
    const p = await fetchImdbProfile(SYN_URL, { fetch: m.f, delayMs: 0 });
    expect(m.pages.some((u) => u.endsWith("/user/p.syntheticprofile01/ratings/"))).toBe(true);
    expect(p.seen[0]).toBe("tt90000001"); // from the captured HTML page, not the API fixtures
  }
});

test("fetchImdbProfile (API): a failure after the first request keeps the first page with a note; failed scores are a note", async () => {
  const rest = await fetchImdbProfile(SYN_URL, { fetch: apiMock({ fail: "rest", failWith: 429 }).f, delayMs: 0 });
  expect(rest.seen).toHaveLength(6);
  expect(rest.watchlist).toHaveLength(2);
  expect(rest.notes).toEqual(["IMDb ratings: stopped at page 2 (IMDb's API refused the ratings list (HTTP 429)); kept the first 6"]);
  const scores = await fetchImdbProfile(SYN_URL, { fetch: apiMock({ fail: "scores", failWith: 403 }).f, delayMs: 0 });
  expect(scores.seen).toHaveLength(8);
  expect(scores.ratings).toBeUndefined();
  expect(scores.notes[0]).toContain("could not read the scores themselves");
});

test(`fetchImdbProfile (API): a profile past ${MAX_PAGES} pages stops at the limit and says so`, async () => {
  let requests = 0;
  const f = async (_url: string, init?: RequestInit): Promise<Response> => {
    requests++;
    const b = JSON.parse(String(init?.body)) as { query?: string; operationName?: string };
    if (b.operationName) return new Response(JSON.stringify({ data: { titles: [] } }));
    const data: Record<string, unknown> = {};
    for (const m of (b.query ?? "").matchAll(/p(\d+): advancedTitleSearch/g)) {
      data[`p${m[1]}`] = { total: 20_000, pageInfo: { hasNextPage: true }, edges: [{ node: { title: { id: `tt8${m[1]!.padStart(6, "0")}`, titleText: { text: `Film ${m[1]}` } } } }] };
    }
    if (b.query?.includes("wl:")) data.wl = { titleListItemSearch: { total: 0, pageInfo: { hasNextPage: false }, edges: [] } };
    return new Response(JSON.stringify({ data }));
  };
  const p = await fetchImdbProfile("ur10000001", { fetch: f, delayMs: 0 });
  expect(p.seen).toHaveLength(MAX_PAGES);
  expect(p.notes).toContain(`IMDb ratings: stopped at the ${MAX_PAGES}-page limit; kept the first ${MAX_PAGES} of 20000`);
  expect(p.notes).toContain("IMDb returned no scores for the rated films; they still count as seen");
  expect(requests).toBe(1 + Math.ceil((MAX_PAGES - 1) / API_PAGES_PER_REQUEST) + 1);
});

test("fetchLetterboxdProfile: slugs map to IMDb ids through ids.json, the rest stay for the title join", async () => {
  const calls: string[] = [];
  const f = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.endsWith("/dave/films/")) return html(fx("letterboxd-films-page1.html"));
    if (url.endsWith("/dave/films/page/2/")) return html(fx("letterboxd-films-page2.html"));
    if (url.endsWith("/dave/watchlist/")) return html(fx("letterboxd-watchlist-page1.html"));
    return html("not found", 404);
  };
  const slugs = new Map([["wildwood-2026", "tt0000001"], ["big-world-2024", "tt0000002"]]);
  const p = await fetchLetterboxdProfile("https://letterboxd.com/dave/films/ratings/", slugs, { fetch: f, delayMs: 0 });
  expect(p.seen).toEqual(["tt0000001"]);
  expect(p.ratings).toEqual({ tt0000001: 9 });
  expect(p.watchlist).toEqual(["tt0000002"]);
  expect(p.unmatched.seen).toHaveLength(72 * 2 - 1);
  expect(p.unmatched.seen[0]).toEqual({ title: "Whalefall", year: 2026, rating: 7 });
  expect(p.unmatched.watchlist).toHaveLength(27);
  expect(p.source).toBe("letterboxd:dave");
  expect(calls).toContain("https://letterboxd.com/dave/films/page/3/"); // a 404 past the fixtures ends the list
});

test("a refusal after page 1 keeps the pages already read and notes it; on page 1 it throws", async () => {
  const cf = () => html("<title>Just a moment...</title>", 403, { "cf-mitigated": "challenge" });
  const f = async (url: string): Promise<Response> => (url.endsWith("/dave/films/") ? html(fx("letterboxd-films-page1.html")) : cf());
  const p = await fetchLetterboxdProfile("dave", new Map(), { fetch: f, delayMs: 0 });
  expect(p.unmatched.seen).toHaveLength(72);
  expect(p.notes).toEqual([
    "Letterboxd films: stopped at page 2 (Letterboxd refused the request (HTTP 403, challenge)); kept the first 72",
    "watchlist skipped (Letterboxd refused the request (HTTP 403, challenge))",
  ]);
  await expect(fetchLetterboxdProfile("dave", new Map(), { fetch: async () => cf(), delayMs: 0 })).rejects.toBeInstanceOf(ProfileBlocked);
});

// ---- the CLI end to end, against a loopback server serving the fixtures --------------------------------------

async function loopbackError(): Promise<string | null> {
  try {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    try { return (await (await fetch(`http://127.0.0.1:${s.port}/`)).text()) === "ok" ? null : "unexpected reply"; }
    finally { s.stop(true); }
  } catch (e) { return e instanceof Error ? e.message : String(e); }
}
const noLoopback = await loopbackError();
if (noLoopback) console.warn(`skill profile CLI test skipped: no usable loopback server (${noLoopback})`);

test.skipIf(!!noLoopback)("catalogue.ts --imdb-url hides rated films, flags the watchlist, caches for 24 h; a 202 prints the CSV route", async () => {
  let block = false;
  let pageHits = 0;
  const { f } = imdbMock();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/user/")) { pageHits++; if (block) return html("", 202, { "x-amzn-waf-action": "challenge" }); }
    return f(url.pathname.startsWith("/graphql") ? "https://api.graphql.imdb.com/" : `https://www.imdb.com${url.pathname}${url.search}`,
      { method: req.method, body: req.method === "POST" ? await req.text() : null });
  } });
  mkdirSync(`${import.meta.dir}/../tmp`, { recursive: true });
  const dir = mkdtempSync(`${import.meta.dir}/../tmp/skill-profile-`);
  const film = (id: string, title: string, imdbId: string) =>
    ({ sourceId: id, title, year: 2020, runtime: 100, directors: [], genres: ["Drama"], rating: "PG", languages: [], categories: [], imdbId, imdbConfidence: "high", tmdbId: null });
  try {
    mkdirSync(`${dir}/public/data/qantas`, { recursive: true });
    writeFileSync(`${dir}/public/data/index.json`, JSON.stringify({ generatedAt: "2026-10-30", airlines: [{ id: "qantas", name: "Qantas", months: [{ month: "2026-10", count: 3, fetchedAt: "2026-10-01T00:00:00Z", path: "qantas/2026-10.json" }] }] }));
    writeFileSync(`${dir}/public/data/qantas/2026-10.json`, JSON.stringify({ airline: "qantas", name: "Qantas", month: "2026-10", fetchedAt: "2026-10-01T00:00:00Z", count: 3, films: [
      film("1", "Example Film 001", "tt90000001"), film("2", "Example Watchlist Film 001", "tt91000001"), film("3", "Unseen", "tt0000009")] }));
    const run = async (...args: string[]) => {
      const env: Record<string, string | undefined> = { ...process.env, SEATBACK_DATASET_URL: `${dir}/public`, XDG_CACHE_HOME: `${dir}/cache`,
        INFLIGHT_IMDB_ORIGIN: `http://127.0.0.1:${server.port}`, INFLIGHT_IMDB_GRAPHQL: `http://127.0.0.1:${server.port}/graphql`, INFLIGHT_PROFILE_DELAY_MS: "0" };
      const p = Bun.spawn(["bun", SCRIPT, ...args], { env, stdout: "pipe", stderr: "pipe" });
      return { out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text(), code: await p.exited };
    };
    const a = await run("qantas", "--imdb-url", IMDB_URL);
    expect(a.code).toBe(0);
    expect(a.out).toContain("taste (imdb:p.examplepublicid00000000): 80 seen, 40 on the watchlist; hid 1 seen films");
    expect(a.out).not.toContain("Example Film 001 |");
    expect(a.out).toContain("Example Watchlist Film 001 | 2020 | 100 | Drama | PG | tt91000001 | watchlist");
    expect(a.out).toContain("Unseen | 2020 | 100 | Drama | PG | tt0000009 | -");
    expect(a.out).toMatch(/loved \(9-10\/10\): .+ 9/);
    const hitsAfterFirst = pageHits;
    const b = await run("qantas", "--imdb-url", IMDB_URL); // cached: no page requests
    expect(b.code).toBe(0);
    expect(pageHits).toBe(hitsAfterFirst);
    block = true;
    const c = await run("qantas", "--imdb-url", IMDB_URL, "--refresh");
    expect(c.code).toBe(1);
    expect(c.err).toContain("IMDb refused the request (HTTP 202, challenge)");
    expect(c.err).toContain("https://www.imdb.com/list/ratings/export");
    const lines = c.err.trim().split("\n");
    expect(lines).toHaveLength(3); // the API-route log line, then the two-line export route
    expect(lines[0]).toContain("IMDb API route failed (IMDb's API refused the profile id (HTTP 429)); trying the profile pages");
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
