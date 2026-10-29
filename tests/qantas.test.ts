import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { qantas, qantasAdapter, servedMonth, type QantasRaw } from "../src/airlines/qantas.ts";
import raw from "./fixtures/qantas-raw.json";

const tmpRoot = () => { const d = `${import.meta.dir}/../tmp`; mkdirSync(d, { recursive: true }); return d; };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("movies only, deduped on mid, shelves collected as categories", () => {
  const films = qantas.parse(raw);
  expect(films.map((f) => f.sourceId).sort()).toEqual(["518587", "518590", "518592", "518594", "518596", "518598"]);
  expect(films.find((f) => f.title === "Friends")).toBeUndefined();
  const ts = films.find((f) => f.sourceId === "518587")!;
  expect(ts).toMatchObject({
    title: "Toy Story 5", year: 2026, runtime: 102, rating: "G", genres: ["Animation"],
    directors: ["Andrew Stanton", "McKenna Harris"], categories: ["New Releases", "Family"],
  });
  expect(ts.languages).toContain("Japanese");
  expect(ts.subtitles).toEqual(["English", "Simplified Chinese"]);
});

test("served month comes from MMYY", () => {
  expect(servedMonth(raw as QantasRaw)).toBe("2026-10");
});

test("fetchMonth: POSTs the configured route, caches, refuses a month the API is not serving", async () => {
  const cacheDir = mkdtempSync(`${tmpRoot()}/qantas-`);
  const calls: { url: string; method?: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    return new Response(JSON.stringify(raw), { status: 200 });
  }) as typeof fetch;
  try {
    const adapter = qantasAdapter("small_international_seatback");
    await adapter.fetchMonth("2026-10", { cacheDir });
    await adapter.fetchMonth("2026-10", { cacheDir });
    expect(calls).toEqual([{ url: "https://www.qantas.com/api/entertainment/metadata?route=small_international_seatback", method: "POST" }]);
    expect(await Bun.file(`${cacheDir}/qantas/2026-10/small_international_seatback.json`).exists()).toBe(true);
    await expect(adapter.fetchMonth("2026-11", { cacheDir })).rejects.toThrow("serves 2026-10 only");
    expect(await Bun.file(`${cacheDir}/qantas/2026-11/small_international_seatback.json`).exists()).toBe(false);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
