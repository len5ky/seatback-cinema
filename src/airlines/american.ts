// American Airlines: entertainment.aa.com (Next.js on Vercel). The movie gallery is paged (?page=N, 28 per page) and
// each page's React Server Component payload carries the full title records, IMDb ids included. Vercel's checkpoint
// blocks curl on TLS fingerprint, so the pages are fetched from inside a headless Chromium session.
// Two record shapes: through Oct 2026 each record nested its shelves and languages in `summaries` and carried
// `imdb_id`; from Nov 2026 the gallery serves flat per-cycle rows (`cycle_start`, `categories`, ISO `audio` codes,
// `image_url`) with no IMDb id and no subtitles. A title page (/en/title/<slug>) does not carry its own film's id,
// but it embeds ~20 recommended films as full nested records (imdb_id and subtitles included), so walking the title
// pages of the films still missing an id harvests ids for the rest of the catalogue (fetchDetails).
import type { AirlineAdapter, CatalogueFilm } from "./types.ts";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { BROWSER_UA, monthDir, splitList, uniq } from "./http.ts";
import { splitNames } from "../text.ts";
import { languageName } from "./lang.ts";

const SITE = "https://entertainment.aa.com";
const REQUEST_TIMEOUT_MS = 20_000; // per in-page request (gallery page or title page)
const MAX_PAGES = 40; // 683 films / 28 per page = 25 pages in Oct 2026; the loop stops at the first empty page

interface AaProgramming { audio?: string | null; subtitles?: string | null; content_type?: string | null }
interface AaSummary {
  picks?: string[] | null; channels?: string[] | null; featured_channel?: string[] | null;
  cycles?: { cycle_start?: string | null; is_current_cycle?: boolean | null } | null;
  programming?: AaProgramming[] | null;
}
export interface AaRecord {
  id: string; name: string; imdb_id?: string | null; content_type?: string | null; release_date?: string | null; slug?: string | null;
  duration?: number | null; director?: string | null; cast_list?: string | null; genres?: string[] | null;
  mpaa_rating?: string | null; synopsis?: string | null; poster?: string | null; summaries?: AaSummary[] | null;
  // flat shape (Nov 2026 on)
  cycle_start?: string | null; is_current_cycle?: boolean | null; categories?: string[] | null; audio?: string[] | null;
  image_url?: string | null; subtitles?: string | null;
}
/** What a title page's embedded records tell about a film: IMDb id (null = the site has none) and subtitles. */
export interface AaDetail { id: string; slug?: string | null; imdb_id: string | null; subtitles?: string | null }
export interface AmericanRaw { pages: AaRecord[][]; details?: Record<string, AaDetail> }

/** Parse a `text/x-component` RSC payload: every JSON row, walked for title objects (`name` plus `imdb_id` or `cycle_start`). */
export function extractRscRecords(text: string): AaRecord[] {
  const found = new Map<string, AaRecord>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.name === "string" && ("imdb_id" in o || "cycle_start" in o) && typeof o.id === "string") { found.set(o.id, o as unknown as AaRecord); return; }
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
  if (!r.summaries) {
    // flat shape: the record is its own (single-cycle) summary
    return [{ cycles: { cycle_start: r.cycle_start ?? null, is_current_cycle: r.is_current_cycle ?? null }, picks: r.categories ?? [],
      programming: r.audio?.length || r.subtitles ? [{ audio: uniq((r.audio ?? []).map(languageName)).join(", "), subtitles: r.subtitles ?? null }] : [] }];
  }
  const all = r.summaries;
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

/** Embedded records of a title page's RSC payload (the recommended films; never the page's own film). */
export function extractDetails(text: string): AaDetail[] {
  return extractRscRecords(text).filter((r) => "imdb_id" in r).map((r) => {
    const subtitles = uniq((r.summaries ?? []).flatMap((s) => (s.programming ?? []).flatMap((p) => splitList(p.subtitles))));
    return { id: r.id, slug: r.slug ?? null, imdb_id: r.imdb_id?.startsWith("tt") ? r.imdb_id : null, ...(subtitles.length ? { subtitles: subtitles.join(", ") } : {}) };
  });
}

/** A harvested detail applies to a gallery record only when both id and slug agree (a reused id never crosses films). */
const detailFor = (r: AaRecord, details: Record<string, AaDetail>): AaDetail | undefined => {
  const d = details[r.id];
  return d && d.slug && r.slug && d.slug === r.slug ? d : undefined;
};

/** Fill imdb_id (and, on flat records, subtitles) from title-page details, only where the gallery record has none. */
export function mergeDetails(records: AaRecord[], details: Record<string, AaDetail> = {}): AaRecord[] {
  return records.map((r) => {
    const d = detailFor(r, details);
    if (!d) return r;
    const out = { ...r };
    if (!r.imdb_id && d.imdb_id) out.imdb_id = d.imdb_id;
    if (!r.summaries && !r.subtitles && d.subtitles) out.subtitles = d.subtitles;
    return out;
  });
}

export function parseAmerican(raw: unknown): CatalogueFilm[] {
  const films = new Map<string, CatalogueFilm>();
  const { pages, details } = raw as AmericanRaw;
  for (const r of mergeDetails(pages.flat().filter(Boolean), details)) {
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
      ...(r.poster || r.image_url ? { poster: (r.poster || r.image_url)! } : {}),
      categories: uniq(summaries.flatMap((s) => [
        ...(s.channels ?? []), ...(s.featured_channel ?? []), ...(s.picks ?? []).filter((p) => !LAYOUT_PICK.test(p)),
      ])),
    });
  }
  return [...films.values()];
}

/** Fetch one gallery page's RSC payload from inside the browser page (same origin, browser TLS). */
export type PageFetcher = (n: number) => Promise<string>;
/** Fetch one title page's RSC payload (/en/title/<slug>, same context and headers as the gallery). */
export type TitleFetcher = (slug: string) => Promise<{ status: number; body: string }>;

/** A non-200 gallery page; 429 is the site's rate limit / bot checkpoint. */
export class AmericanPageError extends Error {
  constructor(readonly page: number, readonly status: number, body: string) {
    super(`american page ${page} -> ${status}: ${body.slice(0, 200)}`);
  }
}

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
async function openBrowser(): Promise<{ fetchPage: PageFetcher; fetchTitle: TitleFetcher; close: () => Promise<void> }> {
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
    // Each in-page request aborts after REQUEST_TIMEOUT_MS so a hung fetch cannot stall a worker or the run.
    const rsc = (url: string) => page.evaluate(async ([u, ms]) => {
      const res = await fetch(u, { headers: { RSC: "1" }, signal: AbortSignal.timeout(ms) });
      return { status: res.status, body: await res.text() };
    }, [url, REQUEST_TIMEOUT_MS] as const);
    const fetchPage: PageFetcher = async (n) => {
      const r = await rsc(`/en/movies?page=${n}`);
      if (r.status !== 200) throw new AmericanPageError(n, r.status, r.body);
      return r.body;
    };
    const fetchTitle: TitleFetcher = (slug) => rsc(`/en/title/${encodeURIComponent(slug)}`);
    return { fetchPage, fetchTitle, close: () => browser.close() };
  } catch (e) {
    await browser.close();
    throw e;
  }
}

/** One back-off retry on 429; a second 429 means this IP is blocked (CI runners are), so say where to run it instead. */
async function fetchPatiently(fetchPage: PageFetcher, n: number, retryMs: number): Promise<string> {
  try {
    return await fetchPage(n);
  } catch (e) {
    if (!(e instanceof AmericanPageError) || e.status !== 429) throw e;
    console.warn(`american: page ${n} rate-limited (429); retrying once in ${retryMs / 1000}s`);
    await Bun.sleep(retryMs);
    try {
      return await fetchPage(n);
    } catch (e2) {
      if (e2 instanceof AmericanPageError && e2.status === 429)
        throw new Error(`american: page ${n} still 429 after a ${retryMs / 1000}s back-off; the site blocks this IP (run scripts/american-local.sh from a residential connection)`);
      throw e2;
    }
  }
}

/**
 * Walk the gallery pages until one has no new records. Each page's extracted records are cached as
 * page-N.json; complete.json marks a finished walk so later runs need no browser.
 */
export async function fetchAmerican(month: string, cacheDir: string, refresh = false, open: () => Promise<{ fetchPage: PageFetcher; close: () => Promise<void> }> = openBrowser, retryMs = 30_000): Promise<AmericanRaw> {
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
        : extractRscRecords(await fetchPatiently(browser.fetchPage, n, retryMs));
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

export interface DetailOptions {
  month?: string;        // YYYY-MM the gallery was fetched for; picks the cycle the cache is keyed by
  max?: number;          // cap on title-page requests per run, retries included (AMERICAN_DETAIL_MAX, default 800)
  concurrency?: number;  // in flight at once, at most 2
  timeoutMs?: number;    // per request; a request that has not settled by then counts as failed
  deadlineMs?: number;   // whole walk; no new request starts after it (default 30 min)
  spacingMs?: number;    // minimum gap between request starts
  retryMs?: number;      // back-off before the single retry on 429/5xx
  log?: (msg: string) => void;
}

/**
 * Harvest IMDb ids for gallery records that have none, from the title pages of those films (each page embeds ~20
 * other films' full records). Each page's extract is cached as <cacheDir>/american/detail/<cycle_start>/<slug>.json,
 * outside the month dir so a --refresh of the gallery does not refetch it: once per cycle per slug. A failed page is
 * logged and skipped, never failing the run. The browser opens only if some needed page is not cached.
 */
export async function fetchDetails(raw: AmericanRaw, cacheDir: string,
  open: () => Promise<{ fetchTitle?: TitleFetcher; close: () => Promise<void> }>, opts: DetailOptions = {}): Promise<Record<string, AaDetail>> {
  const envMax = Number(process.env.AMERICAN_DETAIL_MAX);
  const {
    max = Number.isFinite(envMax) && process.env.AMERICAN_DETAIL_MAX ? envMax : 800, spacingMs = 300, retryMs = 5_000,
    timeoutMs = REQUEST_TIMEOUT_MS + 5_000, deadlineMs = 30 * 60_000, log = console.log,
  } = opts;
  const concurrency = Math.min(opts.concurrency ?? 2, 2);
  const deadline = Date.now() + deadlineMs;
  const records = [...new Map(raw.pages.flat().filter((r) => r?.id).map((r) => [r.id, r])).values()];
  // the served cycle, not whichever record comes first: an older-cycle row on page 1 must not key the cache
  const month = opts.month ?? servedMonth(raw);
  const cycle = month ? (records.find((r) => r.cycle_start?.startsWith(month))?.cycle_start ?? `${month}-01`) : "unknown";
  const dir = `${cacheDir}/american/detail/${cycle}`;
  const path = (slug: string) => `${dir}/${slug.replace(/[^a-z0-9-]/gi, "_")}.json`;
  const details: Record<string, AaDetail> = {};
  const add = (ds: AaDetail[]) => { for (const d of ds) if (!details[d.id]?.imdb_id) details[d.id] = d; };
  const missing = records.filter((r) => !r.imdb_id && r.slug && (!r.content_type || r.content_type === "Film"));
  const done = new Set<string>();
  for (const r of missing) {
    if (!existsSync(path(r.slug!))) continue;
    add(((await Bun.file(path(r.slug!)).json()) as { records: AaDetail[] }).records);
    done.add(r.slug!);
  }
  const todo = () => missing.filter((r) => !detailFor(r, details) && !done.has(r.slug!));
  if (!todo().length) return details;
  if (max <= 0) { log(`american details: AMERICAN_DETAIL_MAX=${max}; ${todo().length} title pages not fetched`); return details; }
  const browser = await open();
  let fetched = 0, failed = 0, capped = false, timedOut = false, nextStart = 0;
  /** Wait for this request's start slot: request starts are at least spacingMs apart across workers. */
  const slot = async () => {
    const now = Date.now();
    const start = Math.max(now, nextStart);
    nextStart = start + spacingMs;
    if (start > now) await Bun.sleep(start - now);
  };
  /** Reserve one request against the cap and the deadline; false stops the walk. */
  const reserve = (): boolean => {
    if (fetched >= max) { capped = true; return false; }
    if (Date.now() >= deadline) { timedOut = true; return false; }
    fetched++;
    return true;
  };
  const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([p, new Promise<T>((res) => { timer = setTimeout(() => res(fallback), ms); })]).finally(() => clearTimeout(timer));
  };
  const get = async (slug: string): Promise<string | undefined> => {
    for (let attempt = 0; ; attempt++) {
      if (attempt) await slot();
      if (!reserve()) return undefined;
      const r = await withTimeout(browser.fetchTitle!(slug).catch((e: unknown) => ({ status: 0, body: String(e) })), timeoutMs,
        { status: 0, body: `no answer in ${timeoutMs / 1000}s` });
      if (r.status === 200) return r.body;
      if (attempt === 0 && (r.status === 429 || r.status >= 500)) { await Bun.sleep(retryMs * (1 + Math.random())); continue; }
      log(`american details: ${slug} -> ${r.status || r.body.slice(0, 120)}; kept without an id`);
      return undefined;
    }
  };
  const worker = async () => {
    for (;;) {
      await slot(); // pick the next film after the wait, so pages that landed meanwhile can resolve it
      const r = todo()[0];
      if (!r || capped || timedOut) return;
      const slug = r.slug!;
      done.add(slug);
      const body = await get(slug);
      if (body === undefined) { if (!capped && !timedOut) failed++; continue; }
      const ds = extractDetails(body);
      if (!ds.length) {
        // a 200 without records is likely a checkpoint or error page: not cached, so the next run asks again
        failed++;
        log(`american details: ${slug} -> 200 without records (${body.slice(0, 80).replace(/\s+/g, " ")}); not cached`);
        continue;
      }
      add(ds);
      mkdirSync(dir, { recursive: true });
      await Bun.write(path(slug), JSON.stringify({ slug, cycle_start: cycle, fetchedAt: new Date().toISOString(), records: ds }));
    }
  };
  try {
    if (!browser.fetchTitle) return details;
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    await withTimeout(browser.close().catch(() => {}), 30_000, undefined);
  }
  if (capped) log(`american details: hit AMERICAN_DETAIL_MAX=${max} requests; ${todo().length} title pages left for the next run`);
  if (timedOut) log(`american details: stopped at the ${deadlineMs / 60_000} min deadline; ${todo().length} title pages left for the next run`);
  const filled = missing.filter((r) => detailFor(r, details)?.imdb_id).length;
  log(`american details: ${fetched} requests (${failed} pages failed); IMDb ids for ${filled}/${missing.length} records that had none`);
  return details;
}

export const american: AirlineAdapter = {
  id: "american",
  name: "American Airlines",
  fetchMonth: async (month, { cacheDir, refresh }) => {
    const raw = await fetchAmerican(month, cacheDir, refresh);
    return { ...raw, details: await fetchDetails(raw, cacheDir, openBrowser, { month }) };
  },
  parse: parseAmerican,
};
