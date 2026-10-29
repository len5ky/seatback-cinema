// Spafax "profile" portals (Lufthansa, JAL). The list call gives title/year/runtime; directors, cast,
// genres, shelves and languages are only on the per-film detail call.
import type { AirlineAdapter, CatalogueFilm } from "../types.ts";
import { UA, cachedJson, cleanList, mapLimit, monthDate, splitNames } from "./cached-fetch.ts";

export interface SpafaxSite {
  id: string;
  name: string;
  portal: string;        // origin serving /api/config
  code: string;          // airline code in API paths ("lh", "jl")
  bucket: number;        // the all-movies bucket
  flightSystem?: string; // JAL returns nothing without it
}

interface SpafaxImage { type: string; images: { url: string; size: string }[] }
export interface SpafaxListItem {
  id: number; title: string; type: string; year: number | null; runtime: number | null;
  synopsis: string | null; rating: string | null; images?: SpafaxImage[];
}
export interface SpafaxDetail {
  id: number; title: string; year: number | null; runtime: number | null; rating: string | null;
  categories: string[] | null; cast: string[] | null; directors: string[] | null; genres: string[] | null;
  dubbings: string[] | null; subtitles: string[] | null;
}
export interface SpafaxRaw { list: { data: SpafaxListItem[] }; details: Record<string, { data: SpafaxDetail }> }

const DETAIL_CONCURRENCY = 4;
const MIN_RUNTIME = 10; // promo reels and "onboard relaxation" loops are 1-7 minutes
const RATING = /^(G|PG|PG-?1[25]|PG-?13|M|MA|R|R1[58]|NC-?17|NR|U|UA|A|\d{1,2}\+?)$/i;

/** JAL leaves `rating` null and appends it to the synopsis: "... | © 2026 Studio | PG13". */
function ratingFromSynopsis(synopsis: string | null): string | undefined {
  const last = synopsis?.split(" | ").at(-1)?.trim();
  return last && last.length <= 6 && RATING.test(last) ? last : undefined;
}

export function parseSpafax(raw: unknown): CatalogueFilm[] {
  const { list, details } = raw as SpafaxRaw;
  const films = new Map<string, CatalogueFilm>();
  for (const item of list.data) {
    const sourceId = String(item.id);
    if (films.has(sourceId) || item.type.toLowerCase() !== "movie") continue;
    const d = details[sourceId]?.data;
    const runtime = item.runtime ?? d?.runtime ?? undefined;
    if (runtime !== undefined && runtime < MIN_RUNTIME) continue;
    const year = item.year || d?.year || undefined;
    const rating = item.rating ?? d?.rating ?? ratingFromSynopsis(item.synopsis);
    const poster = item.images?.find((i) => i.type === "Poster")?.images;
    films.set(sourceId, {
      sourceId,
      title: item.title.trim(),
      ...(year ? { year } : {}),
      ...(runtime !== undefined ? { runtime } : {}),
      directors: splitNames(d?.directors),
      cast: splitNames(d?.cast),
      genres: cleanList(d?.genres),
      ...(rating ? { rating } : {}),
      languages: cleanList(d?.dubbings).filter((l) => !/audio description/i.test(l)),
      subtitles: cleanList(d?.subtitles),
      ...(item.synopsis ? { synopsis: item.synopsis.split(" | ")[0]!.trim() } : {}),
      ...(poster?.length ? { poster: (poster.find((p) => p.size === "Large") ?? poster[0])!.url } : {}),
      categories: cleanList(d?.categories),
    });
  }
  return [...films.values()];
}

export async function fetchSpafax(site: SpafaxSite, month: string, opts: { cacheDir: string; refresh?: boolean }): Promise<SpafaxRaw> {
  const dir = `${opts.cacheDir}/${site.id}/${month}`;
  const get = (url: string, headers: Record<string, string> = {}) => () =>
    fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", Referer: `${site.portal}/`, ...headers } });
  const config = (await cachedJson(`${dir}/config.json`, opts.refresh, get(`${site.portal}/api/config`))) as {
    apiGateway?: { key?: string }; filmService?: { apiUrl?: string };
  };
  const key = config.apiGateway?.key;
  if (!key) throw new Error(`${site.id}: no apiGateway.key in ${site.portal}/api/config`);
  const api = config.filmService?.apiUrl ?? "https://prod-api.profile-spafax.com/film";
  const auth = { "Ocp-Apim-Subscription-Key": key };
  const common = new URLSearchParams({ flightDate: `${monthDate(month)}T00:00:00.000Z`, lang: "en" });
  if (site.flightSystem) common.set("flightSystem", site.flightSystem);

  const listParams = new URLSearchParams(common);
  for (const [k, v] of [["page", "1"], ["pageSize", "1000"], ["type", "movie"]]) listParams.set(k!, v!);
  const list = (await cachedJson(`${dir}/list.json`, opts.refresh,
    get(`${api}/v3/${site.code}/buckets/${site.bucket}/films?${listParams}`, auth))) as SpafaxRaw["list"] & {
    paging?: { totalCount?: number; pageCount?: number };
  };
  if ((list.paging?.pageCount ?? 1) > 1) throw new Error(`${site.id}: list has ${list.paging?.pageCount} pages, expected 1`);
  if (!list.data.length) throw new Error(`${site.id}: empty list for ${month} (flightSystem ${site.flightSystem ?? "unset"})`);

  const details: SpafaxRaw["details"] = {};
  let failed = 0;
  await mapLimit(list.data, DETAIL_CONCURRENCY, async (item) => {
    try {
      details[String(item.id)] = (await cachedJson(`${dir}/films/${item.id}.json`, opts.refresh,
        get(`${api}/v3/${site.code}/films/${item.id}?${common}`, auth))) as { data: SpafaxDetail };
    } catch (e) {
      failed++;
      console.warn(`${site.id}: detail ${item.id} failed: ${(e as Error).message}`);
    }
  });
  if (failed > Math.max(2, list.data.length / 10)) throw new Error(`${site.id}: ${failed}/${list.data.length} detail calls failed`);
  return { list, details };
}

export function spafaxAdapter(site: SpafaxSite): AirlineAdapter {
  return { id: site.id, name: site.name, fetchMonth: (month, opts) => fetchSpafax(site, month, opts), parse: parseSpafax };
}
