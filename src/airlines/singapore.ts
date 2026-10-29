import type { AirlineAdapter, CatalogueFilm } from "./types.ts";
import { assertCurrentMonth, BROWSER_UA, cachedJson, monthDir, splitList, uniq } from "./http.ts";
import { splitNames } from "../text.ts";

/**
 * Singapore Airlines KrisWorld: one AEM servlet GET returns the whole current catalogue. Each film is indexed under
 * three keys (two of them aliases mapping to the id string); dedupe on movie_airline_content_id. No month selector.
 */
const SITE = "https://krisworld.singaporeair.com";
const URL = `${SITE}/bin/krisworld/catalog-lookup?type=movies`;

export interface KrisRecord {
  movie_airline_content_id: string; title: string; year_of_release?: number | null; rt_min?: number | null;
  director?: string | null; cast?: string | null; genre?: string | null; rating?: string | null;
  synopsis_long?: string | null; synopsis_short?: string | null; poster_image_filename?: string | null; categories?: string[] | null;
  lang_1?: string; lang_2?: string; lang_3?: string; lang_4?: string;
  dynamic_subtitle_1?: string; dynamic_subtitle_2?: string; dynamic_subtitle_3?: string; embedded_subs?: string;
  type?: string; from?: string; to?: string;
}
export type KrisRaw = Record<string, KrisRecord | string>;

// KrisWorld's own track codes; subtitle codes end in S ("EnS"), audio description is EnAD
const LANG: Record<string, string> = {
  ben: "Bengali", csp: "Castilian Spanish", can: "Cantonese", enad: "English", eng: "English", en: "English", fre: "French",
  ger: "German", hin: "Hindi", ita: "Italian", jpn: "Japanese", kan: "Kannada", kor: "Korean", mal: "Malayalam",
  man: "Mandarin", mar: "Marathi", msa: "Malay", pun: "Punjabi", tam: "Tamil", thai: "Thai", ecc: "English",
  chs: "Chinese (Simplified)", sch: "Chinese (Simplified)", cht: "Chinese (Traditional)",
};
export function krisLanguage(code: string): string {
  const c = code.trim().toLowerCase();
  return LANG[c] ?? (c.length > 2 && c.endsWith("s") ? LANG[c.slice(0, -1)] : undefined) ?? code.trim();
}

export function parseSingapore(raw: KrisRaw): CatalogueFilm[] {
  const films = new Map<string, CatalogueFilm>();
  for (const r of Object.values(raw)) {
    if (typeof r !== "object" || !r?.movie_airline_content_id || films.has(r.movie_airline_content_id)) continue;
    const subs = [r.dynamic_subtitle_1, r.dynamic_subtitle_2, r.dynamic_subtitle_3, r.embedded_subs].flatMap((s) => splitList(s, "/"));
    films.set(r.movie_airline_content_id, {
      sourceId: r.movie_airline_content_id, title: r.title.trim(), year: r.year_of_release || undefined, runtime: r.rt_min || undefined,
      directors: splitNames(r.director), cast: splitNames(r.cast), genres: splitList(r.genre, "/"), rating: r.rating?.trim() || undefined,
      languages: uniq([r.lang_1, r.lang_2, r.lang_3, r.lang_4].filter((l): l is string => !!l?.trim()).map(krisLanguage)),
      subtitles: uniq(subs.map(krisLanguage)), synopsis: (r.synopsis_long || r.synopsis_short)?.trim() || undefined,
      poster: r.poster_image_filename ? `${SITE}${r.poster_image_filename}` : undefined,
      categories: uniq([...(r.categories ?? []), r.type === "NEW" ? "New" : undefined]),
    });
  }
  return [...films.values()];
}

export const singapore: AirlineAdapter = {
  id: "singapore",
  name: "Singapore Airlines",
  async fetchMonth(month, { cacheDir, refresh }) {
    const path = `${monthDir(cacheDir, "singapore", month)}/catalog.json`;
    if (refresh || !(await Bun.file(path).exists())) assertCurrentMonth("singapore", month);
    return cachedJson<KrisRaw>({ url: URL, path, refresh, init: { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } } });
  },
  parse: (raw) => parseSingapore(raw as KrisRaw),
};
