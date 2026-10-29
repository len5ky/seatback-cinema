// ANA on CineSend: one search call per month (month-name tag) plus a detail call per title for
// director, cast, languages, rating and runtime. The API answers 403 without the portal's Origin/Referer.
import type { AirlineAdapter, CatalogueFilm } from "./types.ts";
import { UA, cachedJson, cleanList, mapLimit, monthDate, splitNames } from "./platforms/cached-fetch.ts";

const API = "https://api.cinesend.com/api/ondemand";
const ORG = "6510d9293f9f8bc7a4030aff";
const PORTAL = "https://www.entertainment.ana.co.jp";
const DETAIL_CONCURRENCY = 4;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const LANGUAGE_NAMES: Record<string, string> = { "日本語": "Japanese", "中文": "Chinese", "한국어": "Korean" };

interface AnaVideo {
  _id: string; title: string; release_year: number | string | null; genres: string | null;
  short_summary: string | null; thumbnail_url: string | null; tags: string[] | null;
}
interface AnaDetail extends AnaVideo {
  custom_fields: { label: string; value: string | null }[] | null; subheader: string | null; rating: string | null;
  poster_image_url?: string | null;
}
export interface AnaRaw {
  search: { data: { results: { title: string; list: AnaVideo[] }[] } };
  details: Record<string, { data: { video: AnaDetail } }>;
}

function videos(raw: AnaRaw): AnaVideo[] {
  return raw.search.data.results.find((r) => r.title === "videos")?.list ?? [];
}

function languages(value: string | undefined): string[] {
  return cleanList((value ?? "").split(/\s*[,、]\s*/).map((l) => LANGUAGE_NAMES[l.trim()] ?? l));
}

export function parseAna(raw: unknown): CatalogueFilm[] {
  const r = raw as AnaRaw;
  const films = new Map<string, CatalogueFilm>();
  for (const v of videos(r)) {
    const year = Number(v.release_year) || undefined;
    // Streaming-partner tiles (ABEMA, Disney+), promos and live events carry no release year
    if (!year || films.has(v._id)) continue;
    const d = r.details[v._id]?.data.video;
    const field = (label: string) => d?.custom_fields?.find((f) => f.label === label)?.value?.trim() || undefined;
    const runtime = Number(d?.subheader?.match(/(\d+)\s*mins?\b/)?.[1]) || undefined;
    const rating = field("Rating") ?? d?.rating ?? undefined;
    const poster = d?.poster_image_url ?? v.thumbnail_url;
    films.set(v._id, {
      sourceId: v._id,
      title: v.title.trim(),
      year,
      ...(runtime ? { runtime } : {}),
      directors: splitNames(field("Director")),
      cast: splitNames(field("Cast")),
      genres: cleanList((v.genres ?? "").split(",")),
      ...(rating ? { rating } : {}),
      languages: languages(field("Language(s)")),
      subtitles: languages(field("Subtitle(s)")),
      ...(v.short_summary ? { synopsis: v.short_summary } : {}),
      ...(poster ? { poster } : {}),
      categories: [],
    });
  }
  return [...films.values()];
}

async function fetchAna(month: string, opts: { cacheDir: string; refresh?: boolean }): Promise<AnaRaw> {
  const dir = `${opts.cacheDir}/ana/${month}`;
  const get = (url: string) => () =>
    fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", Origin: PORTAL, Referer: `${PORTAL}/` } });
  const monthName = MONTHS[Number(monthDate(month).slice(5, 7)) - 1]!;
  const params = new URLSearchParams({
    organizationID: ORG, term: "", countries: "", durStart: "0", durEnd: "240", custom: "{}",
    tagIDs: `international,${monthName}`, lang: "en_US",
  });
  const search = (await cachedJson(`${dir}/search.json`, opts.refresh, get(`${API}/dashboard/videos/search?${params}`),
    (parsed) => {
      if (!videos({ search: parsed, details: {} } as AnaRaw).length) throw new Error(`ana: no videos tagged ${monthName}`);
    })) as AnaRaw["search"];
  const raw: AnaRaw = { search, details: {} };
  const wanted = videos(raw).filter((v) => Number(v.release_year) > 0);
  let failed = 0;
  await mapLimit(wanted, DETAIL_CONCURRENCY, async (v) => {
    try {
      raw.details[v._id] = (await cachedJson(`${dir}/videos/${v._id}.json`, opts.refresh,
        get(`${API}/dashboard/videos/${v._id}?lang=en_US`))) as AnaRaw["details"][string];
    } catch (e) {
      failed++;
      console.warn(`ana: detail ${v._id} failed: ${(e as Error).message}`);
    }
  });
  if (failed > Math.max(2, wanted.length / 10)) throw new Error(`ana: ${failed}/${wanted.length} detail calls failed`);
  return raw;
}

export const ana: AirlineAdapter = { id: "ana", name: "ANA", fetchMonth: fetchAna, parse: parseAna };
