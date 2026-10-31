import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Profile } from "../skill/inflight-movie-picker/scripts/profile.ts";
import { fitProfile, getProfile, mcpCall, PROFILE_MAX_BYTES, pasteSentence, saveProfile } from "../skill/inflight-movie-picker/scripts/seatback.ts";

const SCRIPT = `${import.meta.dir}/../skill/inflight-movie-picker/scripts/catalogue.ts`;
const TOKEN = "abcdefghijklmnopqrst";

interface Call { url: string; body: { method: string; params: { name: string; arguments: Record<string, unknown> } } }
/** A fetch stand-in that records each call and answers like the Worker's tools/call. */
function mockFetch(answer: (name: string, args: Record<string, unknown>) => unknown, calls: Call[] = []) {
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as Call["body"];
    calls.push({ url, body });
    const r = answer(body.params.name, body.params.arguments);
    if (r instanceof Response) return r;
    const result = typeof r === "string"
      ? { content: [{ type: "text", text: r }], isError: true }
      : { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r, isError: false };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };
  return { f, calls };
}

test("seatback: save_profile posts a JSON-RPC tools/call to <base>/mcp with only the profile fields", async () => {
  const { f, calls } = mockFetch(() => ({ token: TOKEN }));
  const p = { seen: ["tt1", "tt1", "Film (2020)"], ratings: { tt1: 9 }, liked_genres: ["Drama"], source: "imdb:p.x", titles: { tt1: {} } } as Profile;
  const r = await saveProfile("https://seatback.example/", p, f);
  expect(r).toEqual({ token: TOKEN, dropped: null });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://seatback.example/mcp");
  expect(calls[0]!.body.method).toBe("tools/call");
  expect(calls[0]!.body.params).toEqual({ name: "save_profile", arguments: { profile: { seen: ["tt1", "Film (2020)"], ratings: { tt1: 9 }, liked_genres: ["Drama"], source: "imdb:p.x" } } });
  expect(pasteSentence(TOKEN)).toBe(`My Seatback Cinema taste code is ${TOKEN}.`);
});

test("seatback: tool errors, JSON-RPC errors and HTTP errors come back as readable Errors", async () => {
  await expect(mcpCall("https://s.example", "get_profile", { token: TOKEN }, mockFetch(() => "no saved profile for that token").f))
    .rejects.toThrow("get_profile: no saved profile for that token");
  const rpc = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "unknown tool x" } }));
  await expect(mcpCall("https://s.example", "x", {}, rpc)).rejects.toThrow("x: unknown tool x");
  const http = async () => new Response("down", { status: 503 });
  await expect(mcpCall("https://s.example", "x", {}, http)).rejects.toThrow("https://s.example/mcp -> HTTP 503");
  await expect(saveProfile("https://s.example", { seen: [] }, mockFetch(() => ({ token: "short" })).f)).rejects.toThrow("returned no token");
});

test("seatback: get_profile checks the token before any request and lowercases it", async () => {
  const { f, calls } = mockFetch((_, args) => ({ seen: ["tt9"], source: String(args.token) }));
  await expect(getProfile("https://s.example", "not a token", f)).rejects.toThrow("is not a profile token");
  expect(calls).toHaveLength(0);
  expect(await getProfile("https://s.example", ` ${TOKEN.toUpperCase()} `, f)).toEqual({ seen: ["tt9"], source: TOKEN });
});

test("seatback: a profile over 64 KB drops the oldest ratings first", () => {
  const ids = Array.from({ length: 4000 }, (_, i) => `tt${String(i).padStart(8, "0")}`);
  const { profile, dropped } = fitProfile({ seen: ids, ratings: Object.fromEntries(ids.map((id) => [id, 7])) });
  expect(new TextEncoder().encode(JSON.stringify(profile)).length).toBeLessThanOrEqual(PROFILE_MAX_BYTES);
  expect(profile.seen).toHaveLength(4000);
  expect(Object.keys(profile.ratings!)[0]).toBe(ids[0]); // newest kept
  expect(dropped).toMatch(/^\d+ oldest ratings$/);
  expect(fitProfile({ seen: ["tt1"] }).dropped).toBeNull();
});

// End to end: the script against a loopback stand-in for the Worker (dataset JSON + /mcp). No live calls.
async function loopbackError(): Promise<string | null> {
  try {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    try { return (await (await fetch(`http://127.0.0.1:${s.port}/`)).text()) === "ok" ? null : "unexpected reply"; }
    finally { s.stop(true); }
  } catch (e) { return e instanceof Error ? e.message : String(e); }
}
const noLoopback = await loopbackError();
if (noLoopback) console.warn(`skill seatback test skipped: no usable loopback server (${noLoopback})`);

test.skipIf(!!noLoopback)("catalogue.ts: --save-profile saves the --taste profile and prints the token; --profile-token hides its seen films", async () => {
  const film = (id: string, title: string, year: number | null, imdbId: string | null) =>
    ({ sourceId: id, title, year, runtime: 100, directors: [], genres: ["Drama"], rating: "PG", languages: [], categories: [], imdbId, imdbConfidence: "high", tmdbId: null });
  const index = { generatedAt: "2026-10-29", airlines: [{ id: "qantas", name: "Qantas", months: [{ month: "2026-10", count: 3, fetchedAt: "2026-10-01T00:00:00Z", path: "qantas/2026-10.json" }] }] };
  const cat = { airline: "qantas", name: "Qantas", month: "2026-10", fetchedAt: "2026-10-01T00:00:00Z", count: 3,
    films: [film("1", "Seen On IMDb", 2020, "tt0000001"), film("2", "Seen Letterboxd", 2021, null), film("3", "Fresh", 2025, "tt0000003")] };
  const store = new Map<string, unknown>();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/data/index.json") return Response.json(index);
    if (path === "/data/qantas/2026-10.json") return Response.json(cat);
    if (path !== "/mcp" || req.method !== "POST") return new Response("nope", { status: 404 });
    const { params } = (await req.json()) as Call["body"];
    let result: unknown;
    if (params.name === "save_profile") { store.set(TOKEN, params.arguments.profile); result = { token: TOKEN }; }
    else result = store.get(String(params.arguments.token)) ?? null;
    const body = result ? { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false }
      : { content: [{ type: "text", text: "no saved profile for that token" }], isError: true };
    return Response.json({ jsonrpc: "2.0", id: 1, result: body });
  } });
  mkdirSync(`${import.meta.dir}/../tmp`, { recursive: true });
  const dir = mkdtempSync(`${import.meta.dir}/../tmp/skill-seatback-`);
  const run = async (...args: string[]) => {
    const env: Record<string, string | undefined> = { ...process.env, SEATBACK_DATASET_URL: `http://127.0.0.1:${server.port}`, XDG_CACHE_HOME: `${dir}/cache` };
    delete env.DATASET_BASE_URL;
    const p = Bun.spawn([process.execPath, SCRIPT, ...args], { env, stdout: "pipe", stderr: "pipe" });
    return { out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text(), code: await p.exited };
  };
  try {
    writeFileSync(`${dir}/ratings.csv`, "Const,Your Rating,Title,Year,Title Type\ntt0000001,9,\"Seen On IMDb\",2020,Movie\n");
    writeFileSync(`${dir}/watched.csv`, "Date,Name,Year,Letterboxd URI\n2024-01-01,Seen Letterboxd,2021,https://boxd.it/a\n");
    const s = await run("qantas", "--taste", dir, "--save-profile");
    expect(s.code).toBe(0);
    expect(s.out).toContain(`taste code: ${TOKEN}`);
    expect(s.out.trimEnd().endsWith(`for the Claude app, paste: My Seatback Cinema taste code is ${TOKEN}.`)).toBe(true);
    expect(store.get(TOKEN)).toEqual({ seen: ["tt0000001", "Seen Letterboxd (2021)"], ratings: { tt0000001: 9 }, source: "ratings.csv, watched.csv" });

    const t = await run("qantas", "--profile-token", TOKEN);
    expect(t.code).toBe(0);
    expect(t.out).toContain("taste (saved profile (ratings.csv, watched.csv)): 2 seen, 0 on the watchlist; hid 2 seen films");
    expect(t.out).toContain("Fresh | 2025");
    expect(t.out).not.toContain("Seen On IMDb |");
    expect(t.out).not.toContain("Seen Letterboxd |");

    const bad = await run("qantas", "--profile-token", "zzzzzzzzzzzzzzzzzzzz");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("no saved profile for that token");
    const none = await run("qantas", "--save-profile");
    expect(none.code).toBe(1);
    expect(none.err).toContain("--save-profile needs a profile to save");
    const json = await run("qantas", "--taste", dir, "--save-profile", "--json");
    expect(JSON.parse(json.out)).toHaveLength(1); // stdout stays JSON, the token goes to stderr
    expect(json.err).toContain(`My Seatback Cinema taste code is ${TOKEN}.`);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
