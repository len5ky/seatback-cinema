import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { ana } from "../src/airlines/ana.ts";
import raw from "./fixtures/ana-raw.json";

const tmpRoot = () => { const d = `${import.meta.dir}/../tmp`; mkdirSync(d, { recursive: true }); return d; };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("drops yearless partner tiles and promos, merges detail custom fields", () => {
  const films = ana.parse(raw);
  expect(films.map((f) => f.title)).toEqual(["500 Miles", "A Complete Unknown", "Comic Escape"]);
  const acu = films.find((f) => f.title === "A Complete Unknown")!;
  expect(acu).toMatchObject({
    sourceId: "6abc7182e09936158e0c97f4", year: 2024, runtime: 141, rating: "R", directors: ["James Mangold"],
    cast: ["Actor 1", "Actor 2", "Actor 3"], genres: ["Biography", "Drama", "Musical"],
    languages: ["English", "French", "German", "Spanish", "Italian"], subtitles: ["Japanese", "Vietnamese"],
    categories: ["Biography", "Drama", "Musical"], // no shelves on CineSend: genres stand in
  });
  expect(films.find((f) => f.title === "500 Miles")).toMatchObject({ runtime: 101, directors: ["Morgan Matthews"] });
  // no detail response: list fields only
  expect(films.find((f) => f.title === "Comic Escape")).toMatchObject({ year: 2022, directors: [], genres: [] });
});

test("fetchMonth: month-name tag, Origin/Referer, details for dated titles only, cached", async () => {
  const cacheDir = mkdtempSync(`${tmpRoot()}/ana-`);
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    expect(new Headers(init?.headers).get("Origin")).toBe("https://www.entertainment.ana.co.jp");
    if (url.includes("/videos/search?")) return new Response(JSON.stringify(raw.search));
    const id = url.match(/videos\/([0-9a-f]+)\?/)![1]!;
    const detail = raw.details[id as keyof typeof raw.details];
    return detail ? new Response(JSON.stringify(detail)) : new Response("nope", { status: 404 });
  }) as typeof fetch;
  try {
    const first = await ana.fetchMonth("2026-11", { cacheDir });
    expect(urls[0]).toContain("tagIDs=international%2Cnovember");
    expect(urls.length).toBe(1 + 3); // search + the three titles with a release year
    expect(await Bun.file(`${cacheDir}/ana/2026-11/videos/6abc717ce09936158e0c96fa.json`).exists()).toBe(true);
    expect(ana.parse(first).find((f) => f.title === "500 Miles")?.directors).toEqual(["Morgan Matthews"]);
    await ana.fetchMonth("2026-11", { cacheDir });
    expect(urls.length).toBe(4 + 1); // only the failed detail is retried
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
