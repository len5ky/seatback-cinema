import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { jal } from "../src/airlines/jal.ts";
import { lufthansa } from "../src/airlines/lufthansa.ts";
import jalRaw from "./fixtures/jal-raw.json";
import lhRaw from "./fixtures/lufthansa-raw.json";

const tmpRoot = () => { const d = `${import.meta.dir}/../tmp`; mkdirSync(d, { recursive: true }); return d; };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("lufthansa: merges list and detail, drops promos, dedupes on id", () => {
  const films = lufthansa.parse(lhRaw);
  // 8 list rows: one duplicate, "#Highlights" (3 min) and "Onboard Relaxation" (1 min) dropped
  expect(films.map((f) => f.sourceId).sort()).toEqual(["14089", "14407", "14416", "14447", "14456"]);
  const dd = films.find((f) => f.sourceId === "14407")!;
  expect(dd).toMatchObject({
    title: "Disclosure Day", year: 2026, runtime: 146, rating: "12", directors: ["Steven Spielberg"],
    cast: ["Actor 1", "Actor 2", "Actor 3"], genres: ["Science Fiction", "Thriller"],
    categories: ["Latest Releases", "Action & Thriller", "Sci-Fi & Fantasy", "New on Board"],
  });
  expect(dd.languages).toContain("German");
  expect(dd.languages).not.toContain("English Audio Description");
  expect(dd.subtitles).toEqual(["Chinese", "English (Closed Captions)"]);
  expect(dd.poster).toBeUndefined(); // fixture image URLs stripped
});

test("lufthansa: a film without a detail response keeps its list fields", () => {
  const wh = lufthansa.parse(lhRaw).find((f) => f.sourceId === "14089")!;
  expect(wh).toMatchObject({ title: "\"Wuthering Heights\"", year: 2026, runtime: 136, rating: "NR", directors: [], categories: [] });
});

test("jal: splits packed cast, cleans zero-width genres, reads rating from the synopsis tail", () => {
  const films = jal.parse(jalRaw);
  expect(films.map((f) => f.sourceId).sort()).toEqual(["9016", "9025", "9125"]); // 9010 is a 2-minute promo
  const sg = films.find((f) => f.sourceId === "9025")!;
  expect(sg.cast).toEqual(["Actor 1", "Actor 2"]);
  expect(sg.directors).toEqual(["Craig Gillespie"]);
  expect(sg.genres).toEqual(["Action / Adventure", "Hollywood", "New"]);
  expect(sg.rating).toBe("PG13");
  expect(sg.synopsis).not.toContain("|");
});

test("jal: a film with genres but no categories gets its genres as categories", () => {
  const raw = structuredClone(jalRaw);
  raw.details["9025"].data.categories = [];
  const sg = jal.parse(raw).find((f) => f.sourceId === "9025")!;
  expect(sg.categories).toEqual(["Action / Adventure", "Hollywood", "New"]);
  expect(jal.parse(jalRaw).find((f) => f.sourceId === "9016")!.categories).toContain("Featured"); // real categories win
});

test("fetchMonth: key from /api/config, flightSystem, detail calls cached under cacheDir/<id>/<month>/", async () => {
  const cacheDir = mkdtempSync(`${tmpRoot()}/spafax-`);
  const urls: string[] = [];
  const list = { data: jalRaw.list.data, paging: { pageCount: 1 } };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (url.endsWith("/api/config")) body = { apiGateway: { key: "k123" }, filmService: { apiUrl: "https://api.test/film" }, brand: { code: "JL", enableSwitch: false } };
    else {
      expect(headers.get("Ocp-Apim-Subscription-Key")).toBe("k123");
      expect(url).toContain("flightSystem=NEXT-INT");
      expect(url).toContain("flightDate=2099-11-05T00");
      if (url.includes("/buckets/15/films")) body = list;
      else {
        body = jalRaw.details[url.match(/films\/(\d+)/)![1] as keyof typeof jalRaw.details];
        if (!body) return new Response("not found", { status: 404 });
      }
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    const raw = await jal.fetchMonth("2099-11", { cacheDir });
    expect(urls.length).toBe(2 + 3); // config, list, details for all but the 2-minute promo
    expect(await Bun.file(`${cacheDir}/jal/2099-11/films/9016.json`).exists()).toBe(true);
    expect(jal.parse(raw).find((f) => f.sourceId === "9016")?.directors).toEqual(["Steven Spielberg"]);
    await jal.fetchMonth("2099-11", { cacheDir });
    expect(urls.length).toBe(6); // second run: only the failed detail (9125) is retried
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
