import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { type AaRecord, AmericanPageError, american, extractRscRecords, fetchAmerican, servedMonth } from "../src/airlines/american.ts";
import records from "./fixtures/american-records.json";
import nov from "./fixtures/american-records-2026-11.json";

const page1 = records as unknown as AaRecord[];
const tmpRoot = () => { const d = `${import.meta.dir}/../tmp`; mkdirSync(d, { recursive: true }); return d; };

test("parse: one film per record with IMDb id, year from release date, shelves as categories", () => {
  const films = american.parse({ pages: [page1] });
  expect(films).toHaveLength(28);
  expect(films.filter((f) => f.imdbId)).toHaveLength(26);
  const sg = films.find((f) => f.title === "Supergirl")!;
  expect(sg).toMatchObject({
    sourceId: "a106cd2c-aa0a-4683-868b-8642a0824023", imdbId: "tt8814476", year: 2026, runtime: 107,
    directors: ["Craig Gillespie"], genres: ["Action", "Adventure", "Drama"],
  });
  expect(sg.cast).toEqual(["Actor 1", "Actor 2", "Actor 3", "Actor 4"]);
  expect(sg.languages).toContain("Japanese");
  expect(sg.subtitles).toContain("Spanish (Latin)");
  expect(sg.categories).toEqual(expect.arrayContaining(["New Releases", "Superpowered Cinema", "Heroes & Villains", "New This Month"]));
  expect(sg.categories.some((c) => /Tile|Hero -|Thales|Category Image/.test(c))).toBe(false);
  expect(films.find((f) => f.title === "Ash")?.imdbId).toBeUndefined();
});

test("parse: flat Nov 2026 records (no summaries, no IMDb id, ISO audio codes)", () => {
  const raw = { pages: [nov as unknown as AaRecord[]] };
  expect(servedMonth(raw)).toBe("2026-11");
  const films = american.parse(raw);
  expect(films).toHaveLength(3);
  const sm = films.find((f) => f.title === "Spider-Man: Brand New Day")!;
  expect(sm).toMatchObject({ year: 2026, runtime: 145, directors: ["Destin Daniel Cretton"], genres: ["Action", "Adventure", "Fantasy"], rating: "PG-13" });
  expect(sm.imdbId).toBeUndefined();
  expect(sm.languages).toEqual(["English", "Spanish", "Portuguese", "French", "German", "Italian"]);
  expect(sm.poster).toMatch(/^https:\/\//);
  expect(sm.categories).toEqual(expect.arrayContaining(["New Releases", "Superpowered Cinema", "Heroes & Villains", "New This Month"]));
  expect(sm.categories.some((c) => /Tile|Hero\b|Thales|Category Image/.test(c))).toBe(false);
  const rsc = `5:${JSON.stringify(["$", "div", null, { data: nov[0] }])}`;
  expect(extractRscRecords(rsc).map((r) => r.name)).toEqual(["Spider-Man: Brand New Day"]);
});

test("parse dedupes a record repeated across pages", () => {
  expect(american.parse({ pages: [page1, page1.slice(0, 3)] })).toHaveLength(28);
});

test("servedMonth reads the current cycle start", () => {
  expect(servedMonth({ pages: [page1] })).toBe("2026-10");
});

test("extractRscRecords walks JSON rows and skips module, text and broken rows", () => {
  const [a, b] = page1 as [AaRecord, AaRecord];
  const text = [
    '1:"$Sreact.fragment"',
    '2:I[8837,["/_next/static/chunk.js"],"default"]',
    `5:["$","$L25",null,{"items":[${JSON.stringify(a)},{"nested":{"x":${JSON.stringify(b)}}}]}]`,
    `6:["$","div",null,{"children":${JSON.stringify(a)}}]`,
    '7:{"name":"Not a film","other":1}',
    "8:T4c,plain text chunk",
    '9:["broken',
  ].join("\n");
  expect(extractRscRecords(text).map((r) => r.name)).toEqual([a.name, b.name]);
});

test("fetchAmerican: walks pages until empty, caches them, then serves from cache without a browser", async () => {
  const cacheDir = mkdtempSync(`${tmpRoot()}/american-`);
  const rsc = (rs: AaRecord[]) => `0:${JSON.stringify(["$", "div", null, { items: rs }])}`;
  const pages = [page1.slice(0, 20), page1.slice(20), []];
  const asked: number[] = [];
  let opened = 0;
  const open = async () => {
    opened++;
    return { fetchPage: async (n: number) => { asked.push(n); return rsc(pages[n - 1] ?? []); }, close: async () => {} };
  };
  try {
    const raw = await fetchAmerican("2026-10", cacheDir, false, open);
    expect(asked).toEqual([1, 2, 3]);
    expect(american.parse(raw)).toHaveLength(28);
    const again = await fetchAmerican("2026-10", cacheDir, false, open);
    expect(opened).toBe(1);
    expect(again.pages.flat()).toHaveLength(28);
    await expect(fetchAmerican("2026-11", cacheDir, false, open)).rejects.toThrow("serves 2026-10 only");
    expect(await Bun.file(`${cacheDir}/american/2026-11/page-1.json`).exists()).toBe(false);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("fetchAmerican: one back-off retry on 429, then a clear error", async () => {
  const cacheDir = mkdtempSync(`${tmpRoot()}/american-`);
  const rsc = (rs: AaRecord[]) => `0:${JSON.stringify(["$", "div", null, { items: rs }])}`;
  let calls = 0;
  const flaky = async () => ({
    fetchPage: async (n: number) => {
      calls++;
      if (calls === 1) throw new AmericanPageError(n, 429, "checkpoint");
      return rsc(n === 1 ? page1 : []);
    },
    close: async () => {},
  });
  const blocked = async () => ({ fetchPage: async (n: number): Promise<string> => { throw new AmericanPageError(n, 429, "checkpoint"); }, close: async () => {} });
  try {
    expect((await fetchAmerican("2026-10", cacheDir, false, flaky, 1)).pages.flat()).toHaveLength(28);
    expect(calls).toBe(3); // 429, retry ok, empty page 2
    await expect(fetchAmerican("2026-10", cacheDir, true, blocked, 1)).rejects.toThrow("still 429 after");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
