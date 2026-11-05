import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import {
  type AaDetail, type AaRecord, AmericanPageError, american, extractDetails, extractRscRecords, fetchAmerican, fetchDetails, mergeDetails, servedMonth,
} from "../src/airlines/american.ts";
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

// Reduced /en/title/top-gun-maverick-2022 RSC payload (probed 2026-11-05): the page's own film is plain JSX, the
// "You may also like" row embeds full records of other films.
const titleRsc = await Bun.file(`${import.meta.dir}/fixtures/american/title-top-gun-maverick-2022.rsc`).text();

test("extractDetails: a title page's embedded records give IMDb ids and subtitles, never the page's own film", () => {
  const ds = extractDetails(titleRsc);
  expect(ds.map((d) => d.slug)).toEqual(["john-wick-chapter-3-parabellum-2019", "bridesmaids-2011", "iron-man-2008"]);
  expect(ds[0]).toEqual({ id: "44850458-94ec-40f4-9463-d6de6874116b", slug: "john-wick-chapter-3-parabellum-2019", imdb_id: "tt6146586", subtitles: "English" });
  expect(ds[2]!.subtitles).toBe("English, Spanish (Latin), Portuguese (Brazilian), French (Parisian)");
});

test("mergeDetails / parse: fills imdb_id and subtitles only where the gallery record has none", () => {
  const flat = nov as unknown as AaRecord[];
  const [a, b, c] = flat as [AaRecord, AaRecord, AaRecord];
  const details: Record<string, AaDetail> = {
    [a.id]: { id: a.id, slug: a.slug, imdb_id: "tt22084616", subtitles: "English, Spanish (Latin)" },
    [b.id]: { id: b.id, slug: b.slug, imdb_id: "tt9999999", subtitles: "French" },
    [c.id]: { id: c.id, slug: "some-other-film-2019", imdb_id: "tt7777777", subtitles: "German" },
  };
  const merged = mergeDetails([a, { ...b, imdb_id: "tt0000001" }, c], details);
  expect(merged[0]).toMatchObject({ imdb_id: "tt22084616", subtitles: "English, Spanish (Latin)" });
  expect(merged[1]!.imdb_id).toBe("tt0000001");
  expect(merged[2]).toBe(c); // same id, different slug: not applied
  expect(mergeDetails([a], { [a.id]: { id: a.id, imdb_id: "tt1" } })[0]).toBe(a); // no slug on the detail: not applied
  expect(a.imdb_id).toBeUndefined(); // input untouched
  const films = american.parse({ pages: [flat], details });
  expect(films.find((f) => f.sourceId === a.id)).toMatchObject({ imdbId: "tt22084616", subtitles: ["English", "Spanish (Latin)"] });
  const r0 = page1.find((r) => r.imdb_id)!;
  const old = american.parse({ pages: [page1], details: { [r0.id]: { id: r0.id, slug: r0.slug, imdb_id: "tt0000002" } } });
  expect(old.find((f) => f.sourceId === r0.id)!.imdbId).toBe(r0.imdb_id!);
});

test("fetchDetails: polite walk, harvests ids, caches per slug+cycle, caps, survives failures", async () => {
  const cacheDir = mkdtempSync(`${tmpRoot()}/american-`);
  const base = (nov as unknown as AaRecord[])[0]!;
  // three flat records without ids (their ids sit on S1's page) and one whose page answers 503 twice
  const recs = extractDetails(titleRsc).map((d) => ({ ...base, id: d.id, slug: d.slug }));
  const [S0, S1] = recs.map((r) => r.slug!) as [string, string];
  const raw = { pages: [[...recs, { ...base, id: "broken", slug: "broken" }]] };
  const asked: string[] = [];
  const starts: number[] = [];
  let inFlight = 0, maxInFlight = 0, opened = 0;
  const open = async () => {
    opened++;
    return {
      fetchTitle: async (slug: string) => {
        asked.push(slug); starts.push(Date.now());
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await Bun.sleep(slug === S0 ? 80 : 20); // S0 overlaps the next requests
        inFlight--;
        if (slug === "broken") return { status: 503, body: "down" };
        return { status: 200, body: slug === S0 ? "0:[]" : titleRsc };
      },
      close: async () => {},
    };
  };
  const logs: string[] = [];
  const dir = `${cacheDir}/american/detail/${base.cycle_start}`;
  try {
    const details = await fetchDetails(raw, cacheDir, open, { spacingMs: 30, retryMs: 1, log: (m) => logs.push(m) });
    expect(asked).toEqual([S0, S1, "broken", "broken"]); // the third already resolved by S1; 5xx retried once
    expect(maxInFlight).toBe(2);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(28);
    expect(american.parse({ ...raw, details }).filter((f) => f.imdbId)).toHaveLength(3);
    expect(logs.some((m) => m.includes("broken -> 503"))).toBe(true);
    expect(await Bun.file(`${dir}/${S1}.json`).exists()).toBe(true);
    expect(await Bun.file(`${dir}/broken.json`).exists()).toBe(false);
    // second run: cached pages reused, only the failed page asked again
    asked.length = 0;
    const again = await fetchDetails(raw, cacheDir, open, { spacingMs: 1, retryMs: 1, log: () => {} });
    expect(Object.keys(again).sort()).toEqual(Object.keys(details).sort());
    expect(asked).toEqual(["broken", "broken"]);
    // cap: fresh cache, max 1 -> one title page and a log line
    rmSync(`${cacheDir}/american/detail`, { recursive: true, force: true });
    asked.length = 0; logs.length = 0;
    await fetchDetails(raw, cacheDir, open, { max: 1, spacingMs: 1, retryMs: 1, log: (m) => logs.push(m) });
    expect(asked).toEqual([S0]);
    expect(logs.some((m) => m.includes("hit AMERICAN_DETAIL_MAX=1 requests"))).toBe(true);
    // nothing missing: no browser
    opened = 0;
    await fetchDetails({ pages: [page1.filter((r) => r.imdb_id)] }, cacheDir, open, { log: () => {} });
    expect(opened).toBe(0);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

// Round 1 review fixes

const hangOpen = (closed: { n: number }) => async () => ({
  fetchTitle: (_slug: string) => new Promise<{ status: number; body: string }>(() => {}), // never settles
  close: async () => { closed.n++; },
});

test("fetchDetails: a hung request times out, the deadline stops the walk, the browser is closed", async () => {
  const cacheDir = mkdtempSync(`${tmpRoot()}/american-`);
  const base = (nov as unknown as AaRecord[])[0]!;
  const raw = { pages: [[1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ ...base, id: `r${i}`, slug: `film-${i}` }))] };
  const closed = { n: 0 };
  const logs: string[] = [];
  try {
    const t0 = Date.now();
    await fetchDetails(raw, cacheDir, hangOpen(closed), { timeoutMs: 40, deadlineMs: 60, spacingMs: 1, retryMs: 1, log: (m) => logs.push(m) });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(closed.n).toBe(1);
    expect(logs.some((m) => m.includes("no answer in 0.04s"))).toBe(true);
    expect(logs.some((m) => m.includes("min deadline"))).toBe(true);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("fetchDetails: the cache is keyed by the served cycle, not the first record's", async () => {
  const cacheDir = mkdtempSync(`${tmpRoot()}/american-`);
  const base = (nov as unknown as AaRecord[])[0]!;
  const d = extractDetails(titleRsc)[0]!;
  const raw = { pages: [[
    { ...base, id: "old", slug: "old-film", imdb_id: "tt0000009", cycle_start: "2026-10-01", is_current_cycle: false },
    { ...base, id: d.id, slug: d.slug }, { ...base, id: "x2", slug: "x2" },
  ]] };
  const open = async () => ({ fetchTitle: async () => ({ status: 200, body: titleRsc }), close: async () => {} });
  try {
    await fetchDetails(raw, cacheDir, open, { spacingMs: 1, log: () => {} });
    expect(readdirSync(`${cacheDir}/american/detail`)).toEqual(["2026-11-01"]);
    rmSync(`${cacheDir}/american/detail`, { recursive: true, force: true });
    await fetchDetails(raw, cacheDir, open, { month: "2026-11", spacingMs: 1, log: () => {} });
    expect(readdirSync(`${cacheDir}/american/detail`)).toEqual(["2026-11-01"]);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("fetchDetails: a 200 page without records is not cached and is asked again next run", async () => {
  const cacheDir = mkdtempSync(`${tmpRoot()}/american-`);
  const base = (nov as unknown as AaRecord[])[0]!;
  const raw = { pages: [[{ ...base, id: "a", slug: "film-a" }]] };
  const asked: string[] = [];
  const logs: string[] = [];
  const open = async () => ({
    fetchTitle: async (slug: string) => { asked.push(slug); return { status: 200, body: "<!DOCTYPE html><title>Vercel Security Checkpoint</title>" }; },
    close: async () => {},
  });
  try {
    await fetchDetails(raw, cacheDir, open, { spacingMs: 1, log: (m) => logs.push(m) });
    await fetchDetails(raw, cacheDir, open, { spacingMs: 1, log: () => {} });
    expect(asked).toEqual(["film-a", "film-a"]);
    expect(logs.some((m) => m.includes("200 without records") && m.includes("not cached"))).toBe(true);
    expect(logs.some((m) => m.includes("(1 pages failed)"))).toBe(true);
    expect(await Bun.file(`${cacheDir}/american/detail/${base.cycle_start}/film-a.json`).exists()).toBe(false);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("fetchDetails: AMERICAN_DETAIL_MAX caps requests, retries included", async () => {
  const cacheDir = mkdtempSync(`${tmpRoot()}/american-`);
  const base = (nov as unknown as AaRecord[])[0]!;
  const raw = { pages: [[1, 2, 3].map((i) => ({ ...base, id: `r${i}`, slug: `film-${i}` }))] };
  const asked: string[] = [];
  const logs: string[] = [];
  const open = async () => ({
    fetchTitle: async (slug: string) => { asked.push(slug); return slug === "film-1" && asked.length === 1 ? { status: 429, body: "slow down" } : { status: 200, body: titleRsc }; },
    close: async () => {},
  });
  const prev = process.env.AMERICAN_DETAIL_MAX;
  process.env.AMERICAN_DETAIL_MAX = "2";
  try {
    await fetchDetails(raw, cacheDir, open, { concurrency: 1, spacingMs: 1, retryMs: 1, log: (m) => logs.push(m) });
    expect(asked).toEqual(["film-1", "film-1"]); // 429 + its retry use up the cap of 2
    expect(logs.some((m) => m.includes("hit AMERICAN_DETAIL_MAX=2 requests"))).toBe(true);
    expect(logs.some((m) => m.startsWith("american details: 2 requests"))).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.AMERICAN_DETAIL_MAX; else process.env.AMERICAN_DETAIL_MAX = prev;
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
