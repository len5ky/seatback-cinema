import { expect, test } from "bun:test";
import type { Bundle } from "../src/bundle.ts";
import { scorePick } from "../src/rank-core.ts";
import { createApp, type Env } from "../worker/src/app.ts";
import { Catalogue, isFamily } from "../worker/src/catalogue.ts";
import { PROTOCOL_VERSIONS } from "../worker/src/mcp.ts";
import { TOKEN_RE, newToken, profileFromText, validateProfile } from "../worker/src/profile.ts";
import type { ProfileStore } from "../worker/src/tools.ts";

const bundle = (await Bun.file(`${import.meta.dir}/../worker/test/fixtures/catalogue.sample.json`).json()) as Bundle;
const cat = new Catalogue(bundle);
const emirates = cat.airline("emirates")!;

function memoryStore(): ProfileStore & { data: Map<string, { value: string; ttl?: number }> } {
  const data = new Map<string, { value: string; ttl?: number }>();
  return {
    data,
    async get(k) { return data.get(k)?.value ?? null; },
    async put(k, value, o) { data.set(k, { value, ttl: o?.expirationTtl }); },
  };
}
const app = createApp(bundle);
const env: Env = { PROFILES: memoryStore(), ASSETS: { fetch: async () => new Response("asset", { status: 200 }) } };
let nextId = 1;
async function rpc(method: string, params?: unknown, headers: Record<string, string> = {}) {
  const res = await app.fetch(new Request("https://x/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) }),
  }), env);
  return { status: res.status, body: (await res.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } } };
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc("tools/call", { name, arguments: args });
  const r = body.result as { structuredContent?: Record<string, unknown>; isError: boolean; content: { text: string }[] };
  return r;
}
type Card = { imdbId: string; score: number; runtime: number; year: number; why: string[]; onWatchlist: boolean; synopsis: string };

// ---------- ranking and filters ----------

test("picks ranks by the shared scorePick and returns full cards", () => {
  const r = cat.picks(emirates, { filters: {}, profile: null, limit: 20 });
  const scores = r.picks.map((p) => p.score);
  expect(scores).toEqual([...scores].sort((a, b) => b - a));
  const top = r.picks[0]!;
  const film = emirates.films.find((f) => f.imdbId === top.imdbId)!;
  const taste = { liked_genres: [], disliked_genres: [], min_rating: 0, min_votes: 1000, seen: [], favourites: [] };
  expect(top.score).toBe(scorePick(cat.row(film), taste, [], { ratings: film.ratings }).score);
  expect(top.synopsis).toStartWith("Synthetic synopsis");
  expect(r.picks.every((p) => p.imdbId)).toBe(true); // unmatched films never ranked
  expect(r.profile_source).toBe("none");
});

test("profile: seen films hidden and counted, watchlist boosted, ratings learn affinities", () => {
  const [a, b, c] = emirates.films.filter((f) => f.imdbId).map((f) => f.imdbId!);
  const wl = emirates.films.filter((f) => f.imdbId)[5]!.imdbId!;
  const profile = cat.applyProfile({ seen: [a!, b!, c!], watchlist: [wl], ratings: { [a!]: 10, [b!]: 3 } }, "test");
  const r = cat.picks(emirates, { filters: {}, profile, limit: 20 });
  expect(r.hidden_seen).toBe(3);
  expect(r.picks.map((p) => p.imdbId)).not.toContain(a);
  const w = r.picks.find((p) => p.imdbId === wl)!;
  expect(w.onWatchlist).toBe(true);
  expect(w.why).toContain("on your watchlist");
  expect(profile.model.rated).toBe(2);
});

test("flight_minutes drops films longer than the flight minus 30", () => {
  const r = cat.picks(emirates, { filters: {}, flightMinutes: 150, profile: null, limit: 20 });
  expect(r.picks.length).toBeGreaterThan(0);
  expect(r.picks.every((p) => p.runtime === null || p.runtime <= 120)).toBe(true);
});

test("filters: years, runtime, genre, exclude, family, query, matched_only", () => {
  const ids = (x: Parameters<Catalogue["filtered"]>[1]) => cat.filtered(emirates, x).map((f) => f.title);
  expect(ids({ min_year: 2025 }).length).toBe(4);
  expect(ids({ max_year: 1970 })).toEqual(["12 Angry Men", "2001: A Space Odyssey"]);
  expect(ids({ max_runtime: 100 })).toEqual(["12 Angry Men"]);
  expect(ids({ genre: ["sci-fi"] })).toContain("Inception");
  expect(ids({ genre: ["sci-fi"], exclude_genre: ["action"] })).not.toContain("Superman");
  expect(ids({ query: "dark knight" })).toEqual(["The Dark Knight"]);
  expect(ids({}).length).toBe(9);
  expect(ids({ matched_only: false }).length).toBe(10);
  const fam = ids({ family: true });
  expect(fam).toContain("2001: A Space Odyssey");
  expect(fam).not.toContain("Sinners");
  expect(isFamily({ ...emirates.films[0]!, cert: null, genres: ["Animation"], imdbGenres: [] })).toBe(true);
  expect(isFamily({ ...emirates.films[0]!, cert: "MA15+", genres: ["Family"], imdbGenres: [] })).toBe(false);
});

test("profile keys resolve by tconst, Letterboxd slug, and title + year", () => {
  expect(cat.resolve("tt0111161")).toBe("tt0111161");
  expect(cat.resolve("Sinners (2025)")).toBe("tt31193180");
  expect(cat.resolve("Sinners (2024)")).toBe("tt31193180"); // a year off still counts
  expect(cat.resolve("Sinners (1990)")).toBeNull();
  expect(cat.resolve("lb:the-dark-knight")).toBe("tt0468569");
  expect(cat.resolve("Fellowship Of The Ring (2001)")).toBe("tt0120737"); // airline title
});

// ---------- profile parsing ----------

test("profile_from_text: IMDb CSV keeps ratings and learns preferences", async () => {
  const csv = await Bun.file(`${import.meta.dir}/fixtures/ratings/imdb-ratings.csv`).text();
  const p = profileFromText(csv, "imdb_csv", {});
  expect(p.seen.length).toBe(15);
  expect(p.ratings?.tt0111161).toBe(10);
  expect(p.source).toBe("imdb_csv");
  const w = profileFromText(await Bun.file(`${import.meta.dir}/fixtures/ratings/imdb-watchlist.csv`).text(), "imdb_csv", {});
  expect(w.seen).toEqual([]);
  expect(w.watchlist?.length).toBe(5);
});

test("profile_from_text: Letterboxd CSVs become title-year keys", () => {
  const ratings = "Date,Name,Year,Letterboxd URI,Rating\n2025-01-01,Sinners,2025,https://boxd.it/x,4.5\n2025-01-02,\"Crouching Tiger, Hidden Dragon\",2000,https://boxd.it/y,3\n";
  const p = profileFromText(ratings, "letterboxd_csv", {});
  expect(p.ratings).toEqual({ "Sinners (2025)": 9, "Crouching Tiger, Hidden Dragon (2000)": 6 });
  const wl = profileFromText("Date,Name,Year,Letterboxd URI\n2025-01-01,Superman,2025,https://boxd.it/z\n", "letterboxd_csv", {}, "watchlist");
  expect(wl.watchlist).toEqual(["Superman (2025)"]);
  expect(() => profileFromText("a,b\n1,2\n", "letterboxd_csv", {})).toThrow(/Letterboxd/);
});

test("profile_from_text: IMDb page falls back to title links and never invents scores", () => {
  const links = '<a href="/title/tt0111161/">Shawshank</a> IMDb 9.3 <span aria-label="Your rating: 8">8</span> <a href="/title/tt0468569/?ref=x">TDK</a>';
  const q = profileFromText(links, "imdb_page", {});
  expect(q.seen).toEqual(["tt0111161", "tt0468569"]);
  expect(q.ratings).toBeUndefined();
  expect(q.note).toContain("seen only");
  expect(profileFromText(links, "imdb_page", {}, "watchlist")).toMatchObject({ seen: [], watchlist: ["tt0111161", "tt0468569"] });
  expect(() => profileFromText("<html>blocked</html>", "imdb_page", {})).toThrow(/CSV/);
});

test("profile_from_text: Letterboxd page maps slugs to tconsts, else title and year", () => {
  const html = `<li class="poster-container"><div class="film-poster" data-film-slug="the-dark-knight"><img alt="The Dark Knight"></div><span class="rating rated-9">★★★★½</span></li>
<li class="poster-container"><div class="react-component" data-item-name="Some Indie Film (2024)" data-item-slug="some-indie-film"></div><span class="rating rated-6">★★★</span></li>
<li><div data-film-slug="nameless-thing"></div></li>`;
  const p = profileFromText(html, "letterboxd_page", bundle.letterboxd);
  expect(p.seen).toEqual(["tt0468569", "Some Indie Film (2024)", "lb:nameless-thing"]);
  expect(p.ratings).toEqual({ tt0468569: 9, "Some Indie Film (2024)": 6 });
});

test("validateProfile keeps known fields only and rejects bad ratings", () => {
  expect(validateProfile({ seen: [" tt1 ", "tt1"], email: "x@y", ratings: { tt2: 7.3 } })).toEqual({ seen: ["tt1"], ratings: { tt2: 7.5 } });
  expect(() => validateProfile({ seen: [], ratings: { tt2: 11 } })).toThrow(/1 to 10/);
  expect(() => validateProfile([])).toThrow(/object/);
  expect(newToken()).toMatch(TOKEN_RE);
});

// ---------- MCP envelope ----------

test("initialize negotiates the protocol version", async () => {
  const a = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  expect(a.body.result?.protocolVersion).toBe("2025-06-18");
  expect(a.body.result?.capabilities).toEqual({ tools: { listChanged: false } });
  const b = await rpc("initialize", { protocolVersion: "1999-01-01" });
  expect(b.body.result?.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
});

test("notifications get 202, unknown methods -32601, bad JSON 400, bad version header 400", async () => {
  const note = await app.fetch(new Request("https://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }), env);
  expect(note.status).toBe(202);
  expect((await rpc("resources/list")).body.error?.code).toBe(-32601);
  expect((await rpc("ping")).body.result).toEqual({});
  const bad = await app.fetch(new Request("https://x/mcp", { method: "POST", body: "{nope" }), env);
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);
  expect((await rpc("ping", undefined, { "MCP-Protocol-Version": "2020-01-01" })).status).toBe(400);
  const batch = await app.fetch(new Request("https://x/mcp", { method: "POST", body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]) }), env);
  expect(((await batch.json()) as unknown[]).length).toBe(1);
});

test("GET /mcp 405, DELETE 200, OPTIONS has CORS, /healthz ok, / falls through to assets", async () => {
  const get = await app.fetch(new Request("https://x/mcp"), env);
  expect(get.status).toBe(405);
  expect((await app.fetch(new Request("https://x/mcp", { method: "DELETE" }), env)).status).toBe(200);
  const opt = await app.fetch(new Request("https://x/mcp", { method: "OPTIONS" }), env);
  expect(opt.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(opt.headers.get("Access-Control-Allow-Headers")).toContain("MCP-Protocol-Version");
  const h = await app.fetch(new Request("https://x/healthz"), env);
  expect(((await h.json()) as { ok: boolean }).ok).toBe(true);
  expect(await (await app.fetch(new Request("https://x/"), env)).text()).toBe("asset");
});

test("tools/list has the five contract tools plus the two profile builders, no em dashes in copy", async () => {
  const { body } = await rpc("tools/list");
  const tools = body.result?.tools as { name: string; description: string }[];
  expect(tools.map((t) => t.name)).toEqual(["list_airlines", "catalogue", "picks", "save_profile", "get_profile", "profile_from_imdb_url", "profile_from_text"]);
  expect(JSON.stringify(tools)).not.toContain("—");
});

test("tools/call: list_airlines, catalogue paging, picks with errors the model can act on", async () => {
  const la = await call("list_airlines");
  expect((la.structuredContent?.airlines as { id: string; films: number; matched: number }[]).find((a) => a.id === "emirates")).toMatchObject({ films: 10, matched: 9 });
  const c = await call("catalogue", { airline: "Emirates", limit: 3, offset: 1, filters: { matched_only: false } });
  expect(c.structuredContent?.total).toBe(10);
  expect((c.structuredContent?.rows as unknown[]).length).toBe(3);
  const p = await call("picks", { airline: "emirates", filters: { min_year: 2025 }, profile: { seen: ["tt31193180"] } });
  const cards = p.structuredContent?.picks as Card[];
  expect(cards.length).toBe(3);
  expect(p.structuredContent?.hidden_seen).toBe(1);
  expect(p.structuredContent?.profile_source).toBe("inline profile");
  const bad = await call("picks", { airline: "aeroflot" });
  expect(bad.isError).toBe(true);
  expect(bad.content[0]!.text).toContain("emirates");
  expect((await call("catalogue", { airline: "emirates", filters: { colour: "red" } })).content[0]!.text).toContain("valid filters");
  expect((await rpc("tools/call", { name: "nope", arguments: {} })).body.error?.code).toBe(-32602);
});

test("save_profile and get_profile round-trip through KV with a one-year TTL", async () => {
  const store = env.PROFILES as ReturnType<typeof memoryStore>;
  const s = await call("save_profile", { profile: { seen: ["tt0111161"], ratings: { tt0111161: 9 }, source: "test" } });
  const token = s.structuredContent?.token as string;
  expect(token).toMatch(TOKEN_RE);
  expect(store.data.get(`profile:${token}`)?.ttl).toBe(365 * 24 * 3600);
  const g = await call("get_profile", { token });
  expect(g.structuredContent).toEqual({ seen: ["tt0111161"], ratings: { tt0111161: 9 }, source: "test" });
  const p = await call("picks", { airline: "emirates", profile: { token } });
  expect(p.structuredContent?.hidden_seen).toBe(1);
  expect(p.structuredContent?.profile_source).toBe("saved profile");
  expect((await call("get_profile", { token: "a".repeat(20) })).content[0]!.text).toContain("expired");
  const big = await call("save_profile", { profile: { seen: Array.from({ length: 8000 }, (_, i) => `tt${String(i).padStart(8, "0")}`) } });
  expect(big.content[0]!.text).toContain("64 KB");
});
