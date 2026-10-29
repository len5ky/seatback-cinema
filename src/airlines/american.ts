// American Airlines: entertainment.aa.com (Next.js on Vercel). The movie gallery is paged (?page=N, 28 per page) and
// each page's React Server Component payload carries the full title records, IMDb ids included. Vercel's checkpoint
// blocks curl on TLS fingerprint, so the pages are fetched from inside a headless Chromium session.
import type { AirlineAdapter, CatalogueFilm } from "./types.ts";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { BROWSER_UA, monthDir, splitList, uniq } from "./http.ts";
import { splitNames } from "../text.ts";

const SITE = "https://entertainment.aa.com";
const MAX_PAGES = 40; // 683 films / 28 per page = 25 pages in Oct 2026; the loop stops at the first empty page

interface AaProgramming { audio?: string | null; subtitles?: string | null; content_type?: string | null }
interface AaSummary {
  picks?: string[] | null; channels?: string[] | null; featured_channel?: string[] | null;
  cycles?: { cycle_start?: string | null; is_current_cycle?: boolean | null } | null;
  programming?: AaProgramming[] | null;
}
export interface AaRecord {
  id: string; name: string; imdb_id: string | null; content_type?: string | null; release_date?: string | null; slug?: string | null;
  duration?: number | null; director?: string | null; cast_list?: string | null; genres?: string[] | null;
  mpaa_rating?: string | null; synopsis?: string | null; poster?: string | null; summaries?: AaSummary[] | null;
}
export interface AmericanRaw { pages: AaRecord[][] }

/** Parse a `text/x-component` RSC payload: every JSON row, walked for objects carrying `name` and an `imdb_id` key. */
export function extractRscRecords(text: string): AaRecord[] {
  const found = new Map<string, AaRecord>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.name === "string" && "imdb_id" in o && typeof o.id === "string") { found.set(o.id, o as unknown as AaRecord); return; }
    for (const x of Object.values(o)) walk(x);
  };
  for (const line of text.split("\n")) {
    const body = line.match(/^[0-9a-f]*:([[{].*)$/s)?.[1];
    if (!body) continue;
    try { walk(JSON.parse(body)); } catch { /* text chunks and partial rows are not JSON */ }
  }
  return [...found.values()];
}

// Picks that are layout slots ("Tile - Movies", "Website Hero - Movie Hero", "Thales Island Mode"), not shelves
const LAYOUT_PICK = /^(Category Image|Tile|Website Hero|Thales)\b|Hero\b/;

const currentSummaries = (r: AaRecord): AaSummary[] => {
  const all = r.summaries ?? [];
  const current = all.filter((s) => s.cycles?.is_current_cycle);
  return current.length ? current : all;
};

/** Month the payload was served for: the current cycle's start (YYYY-MM), most common across records. */
export function servedMonth(raw: AmericanRaw): string | undefined {
  const counts = new Map<string, number>();
  for (const r of raw.pages.flat()) for (const s of currentSummaries(r)) {
    const m = s.cycles?.cycle_start?.slice(0, 7);
    if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function parseAmerican(raw: unknown): CatalogueFilm[] {
  const films = new Map<string, CatalogueFilm>();
  for (const r of (raw as AmericanRaw).pages.flat()) {
    if (!r?.id || films.has(r.id) || (r.content_type && r.content_type !== "Film")) continue;
    const summaries = currentSummaries(r);
    const programming = summaries.flatMap((s) => s.programming ?? []);
    const year = Number(r.release_date?.slice(0, 4)) || Number(r.slug?.match(/-(\d{4})$/)?.[1]) || undefined;
    films.set(r.id, {
      sourceId: r.id,
      title: r.name.trim(),
      ...(year ? { year } : {}),
      ...(r.duration ? { runtime: r.duration } : {}),
      directors: splitNames(r.director),
      cast: splitList(r.cast_list),
      genres: uniq(r.genres ?? []),
      ...(r.mpaa_rating?.trim() ? { rating: r.mpaa_rating.trim() } : {}),
      languages: uniq(programming.flatMap((p) => splitList(p.audio))),
      subtitles: uniq(programming.flatMap((p) => splitList(p.subtitles))),
      ...(r.synopsis?.trim() ? { synopsis: r.synopsis.trim() } : {}),
      ...(r.imdb_id?.startsWith("tt") ? { imdbId: r.imdb_id } : {}),
      ...(r.poster ? { poster: r.poster } : {}),
      categories: uniq(summaries.flatMap((s) => [
        ...(s.channels ?? []), ...(s.featured_channel ?? []), ...(s.picks ?? []).filter((p) => !LAYOUT_PICK.test(p)),
      ])),
    });
  }
  return [...films.values()];
}

/** Fetch one gallery page's RSC payload from inside the browser page (same origin, browser TLS). */
export type PageFetcher = (n: number) => Promise<string>;

/**
 * Playwright's pinned Chromium, or else (a Playwright upgrade without `playwright install`) the newest headless shell
 * or Chromium already under ~/.cache/ms-playwright. PLAYWRIGHT_CHROMIUM_PATH overrides both.
 */
function chromiumPath(pinned: string): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (existsSync(pinned)) return undefined;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? `${homedir()}/.cache/ms-playwright`;
  if (!existsSync(root)) return undefined;
  const rev = (d: string) => Number(d.split("-").pop());
  const dirs = readdirSync(root).filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d)).sort((a, b) => rev(b) - rev(a) || b.localeCompare(a));
  for (const d of dirs) {
    const exe = d.startsWith("chromium_headless_shell")
      ? `${root}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`
      : `${root}/${d}/chrome-linux64/chrome`;
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

/** Open headless Chromium on /en/movies and return an in-page fetcher. Playwright is imported lazily so the CLI runs without it. */
async function openBrowser(): Promise<{ fetchPage: PageFetcher; close: () => Promise<void> }> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("american needs Playwright: bun add -d playwright (Chromium from ~/.cache/ms-playwright is reused)");
  }
  const browser = await chromium.launch({ headless: true, executablePath: chromiumPath(chromium.executablePath()) });
  try {
    const page = await (await browser.newContext({ userAgent: BROWSER_UA })).newPage();
    await page.goto(`${SITE}/en/movies`, { waitUntil: "load", timeout: 60_000 });
    const fetchPage: PageFetcher = async (n) => {
      const r = await page.evaluate(async (url) => {
        const res = await fetch(url, { headers: { RSC: "1" } });
        return { status: res.status, body: await res.text() };
      }, `/en/movies?page=${n}`);
      if (r.status !== 200) throw new Error(`american page ${n} -> ${r.status}: ${r.body.slice(0, 200)}`);
      return r.body;
    };
    return { fetchPage, close: () => browser.close() };
  } catch (e) {
    await browser.close();
    throw e;
  }
}

/**
 * Walk the gallery pages until one has no new records. Each page's extracted records are cached as
 * page-N.json; complete.json marks a finished walk so later runs need no browser.
 */
export async function fetchAmerican(month: string, cacheDir: string, refresh = false, open = openBrowser): Promise<AmericanRaw> {
  const dir = monthDir(cacheDir, "american", month);
  const donePath = `${dir}/complete.json`;
  const pagePath = (n: number) => `${dir}/page-${n}.json`;
  if (!refresh && existsSync(donePath)) {
    const { pages } = (await Bun.file(donePath).json()) as { pages: number };
    return { pages: await Promise.all(Array.from({ length: pages }, (_, i) => Bun.file(pagePath(i + 1)).json() as Promise<AaRecord[]>)) };
  }
  if (refresh) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const browser = await open();
  const pages: AaRecord[][] = [];
  const seen = new Set<string>();
  try {
    for (let n = 1; n <= MAX_PAGES; n++) {
      const records = existsSync(pagePath(n))
        ? ((await Bun.file(pagePath(n)).json()) as AaRecord[])
        : extractRscRecords(await browser.fetchPage(n));
      const fresh = records.filter((r) => !seen.has(r.id));
      if (!fresh.length) break;
      if (n === 1) {
        const served = servedMonth({ pages: [records] });
        if (served && served !== month) throw new Error(`american serves ${served} only, not ${month}`);
      }
      for (const r of fresh) seen.add(r.id);
      await Bun.write(pagePath(n), JSON.stringify(records));
      pages.push(records);
      if (n === MAX_PAGES) throw new Error(`american: still finding records at page ${MAX_PAGES}; raise MAX_PAGES`);
    }
  } finally {
    await browser.close();
  }
  if (!pages.length) throw new Error("american: page 1 returned no records");
  await Bun.write(donePath, JSON.stringify({ pages: pages.length, records: seen.size, fetchedAt: new Date().toISOString() }));
  return { pages };
}

export const american: AirlineAdapter = {
  id: "american",
  name: "American Airlines",
  fetchMonth: (month, { cacheDir, refresh }) => fetchAmerican(month, cacheDir, refresh),
  parse: parseAmerican,
};
