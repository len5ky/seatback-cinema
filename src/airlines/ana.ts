// ANA on CineSend: one search call per month (month-name tag) plus a detail call per title for
// director, cast, languages, rating and runtime. The API answers 403 without the portal's Origin/Referer.
import type { AirlineAdapter, CatalogueFilm } from "./types.ts";
import { BROWSER_UA, cachedJson, monthDir } from "./http.ts";
import { cleanList, loadDetails, nameList } from "./platforms/batch.ts";

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
    const genres = cleanList((v.genres ?? "").split(","));
    films.set(v._id, {
      sourceId: v._id,
      title: v.title.trim(),
      year,
      ...(runtime ? { runtime } : {}),
      directors: nameList(field("Director")),
      cast: nameList(field("Cast")),
      genres,
      ...(rating ? { rating } : {}),
      languages: languages(field("Language(s)")),
      subtitles: languages(field("Subtitle(s)")),
      ...(v.short_summary ? { synopsis: v.short_summary } : {}),
      ...(poster ? { poster } : {}),
      categories: [...genres], // CineSend has no shelves; genre is the only grouping
    });
  }
  return [...films.values()];
}

async function fetchAna(month: string, opts: { cacheDir: string; refresh?: boolean }): Promise<AnaRaw> {
  const dir = monthDir(opts.cacheDir, "ana", month);
  const { refresh } = opts;
  const init = { headers: { "User-Agent": BROWSER_UA, Accept: "application/json", Origin: PORTAL, Referer: `${PORTAL}/` } };
  const monthName = MONTHS[Number(month.slice(5, 7)) - 1];
  if (!/^\d{4}-\d{2}$/.test(month) || !monthName) throw new Error(`bad month ${month}, expected YYYY-MM`);
  const query = new URLSearchParams({
    organizationID: ORG, term: "", countries: "", durStart: "0", durEnd: "240", custom: "{}",
    tagIDs: `international,${monthName}`, lang: "en_US",
  });
  const search = await cachedJson<AnaRaw["search"]>({ url: `${API}/dashboard/videos/search?${query}`, path: `${dir}/search.json`, refresh, init });
  const raw: AnaRaw = { search, details: {} };
  const dated = videos(raw).filter((v) => Number(v.release_year) > 0);
  if (!dated.length) throw new Error(`ana: no dated videos tagged ${monthName}`);
  await loadDetails("ana", dated, DETAIL_CONCURRENCY, async (v) => {
    raw.details[v._id] = await cachedJson<AnaRaw["details"][string]>({
      url: `${API}/dashboard/videos/${v._id}?lang=en_US`, path: `${dir}/videos/${v._id}.json`, refresh, init,
    });
  });
  return raw;
}

export const ana: AirlineAdapter = { id: "ana", name: "ANA", fetchMonth: fetchAna, parse: parseAna };
