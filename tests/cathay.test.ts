import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { cathay } from "../src/airlines/cathay.ts";
import tree from "./fixtures/cathay-tree.json";

const tmpRoot = () => { const d = `${import.meta.dir}/../tmp`; mkdirSync(d, { recursive: true }); return d; };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const root = tree.items[0]!;

test("parses the section tree: deduped on id, sections as categories, release_date -> year", () => {
  const films = cathay.parse(tree);
  expect(films.length).toBe(7);
  const dd = films.find((f) => f.title === "Disclosure Day")!;
  expect(dd).toMatchObject({
    sourceId: "24103205", year: 2026, runtime: 145, rating: "PG13", genres: ["Sci-Fi/Fantasy"],
    directors: ["Steven Spielberg"], categories: ["Featured Movie", "Latest Releases"],
  });
  expect(dd.languages).toContain("English");
  expect(films.find((f) => f.sourceId === "24103203")).toMatchObject({ title: "Moana", year: 2026 });
  expect(films.find((f) => f.title === "Hard Target")).toMatchObject({ year: 1993, categories: ["John Woo"] });
});

test("fetchMonth: one guest session, section list, one call per section, all cached", async () => {
  const cacheDir = mkdtempSync(`${tmpRoot()}/cathay-`);
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url.replace(/\?.*/, "") + (url.includes("max_child_depth=0") ? "#0" : ""));
    const headers = new Headers(init?.headers);
    expect(headers.get("host-id")).toBe("460e26f4-d499-11e9-b038-6306ca4fd90b");
    if (url.endsWith("/account/session")) return new Response(JSON.stringify({ auth_token: "tok" }));
    expect(headers.get("auth-token")).toBe("tok");
    expect(url).toContain("flight_date=2026-11-05");
    const id = url.match(/items\/(\d+)\?/)![1];
    if (id === root.id) return new Response(JSON.stringify({ items: [{ ...root, child_items: [] }] }));
    const section = root.child_items.find((s) => s.id === id);
    return section ? new Response(JSON.stringify({ items: [section] })) : new Response("missing", { status: 404 });
  }) as typeof fetch;
  try {
    const raw = await cathay.fetchMonth("2026-11", { cacheDir });
    expect(calls).toEqual([
      "https://afg.anuvu.cloud/api/v1/account/session",
      "https://afg.anuvu.cloud/api/v1/content/items/21004340#0",
      ...root.child_id_list.map((id) => `https://afg.anuvu.cloud/api/v1/content/items/${id}`),
    ]);
    expect(cathay.parse(raw)).toEqual(cathay.parse(tree));
    expect(await Bun.file(`${cacheDir}/cathay/2026-11/sections/24104650.json`).exists()).toBe(true);
    await cathay.fetchMonth("2026-11", { cacheDir });
    expect(calls.length).toBe(5); // cached run makes no requests, not even the session
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
