import type { AirlineAdapter, CatalogueFilm } from "./types.ts";
import { BROWSER_UA, cachedJson, fetchDate, monthDir, splitList } from "./http.ts";
import { splitNames } from "../text.ts";

const BASE = "https://www.emirates.com/service/exp/ice";
const PLACEHOLDER = /^what'?s new on ice$/i;
// Regional channels prefix titles with a language ("Kannada - Kantara"), not always the row's first audio language
const PREFIX_LANGUAGES = new Set(["arabic", "bengali", "bhojpuri", "gujarati", "hindi", "kannada", "malayalam", "marathi",
  "pashto", "punjabi", "sinhala", "tamil", "telugu", "urdu"]);

export interface IceRow {
  id: number; categoryId: number; title: string; starring: string | null; director: string | null;
  genre: string | null; summary: string | null; languages: string | null; subtitles: string | null;
  rating: string | null; duration: number | null; trailer: string | null; image: string | null;
  posterImage: string | null; trackList: string;
}
export interface IceTaxonomy { results: { id: string; categories?: { id: string; name: string }[] | null }[] }
export interface EmiratesRaw { taxonomy: IceTaxonomy; movies: { results: IceRow[] } }

/** Strip a "(1985)" year suffix and a "Telugu - " language prefix (a known regional language or the film's own). */
export function cleanTitle(title: string, primaryLanguage: string | null): { cleanTitle: string; year: number | null } {
  let t = title.trim();
  let year: number | null = null;
  const y = t.match(/\s*\((\d{4})\)$/);
  if (y?.[1]) { year = Number(y[1]); t = t.slice(0, y.index).trim(); }
  const p = t.match(/^([A-Za-z]+) - (.+)$/);
  const lang = p?.[1]?.toLowerCase();
  if (lang && p?.[2] && (PREFIX_LANGUAGES.has(lang) || lang === primaryLanguage?.toLowerCase())) t = p[2].trim();
  return { cleanTitle: t, year };
}

export function parseCategories(taxonomy: IceTaxonomy): Map<number, string> {
  const movies = taxonomy.results.find((g) => g.id === "movies");
  return new Map((movies?.categories ?? []).map((c) => [Number(c.id), c.name]));
}

/** Rows are (category, film) placements: dedupe on trackList, drop the placeholder channels ("What's new on ice", "iceologies"). */
export function parseEmirates(raw: EmiratesRaw): CatalogueFilm[] {
  const names = parseCategories(raw.taxonomy);
  const films = new Map<string, CatalogueFilm>();
  for (const r of raw.movies.results) {
    if (!r.trackList || PLACEHOLDER.test(r.title.trim()) || r.director === "The ice team") continue;
    const category = names.get(r.categoryId) ?? String(r.categoryId);
    const existing = films.get(r.trackList);
    if (existing) {
      if (!existing.categories.includes(category)) existing.categories.push(category);
      continue;
    }
    const languages = splitList(r.languages);
    const { cleanTitle: title, year } = cleanTitle(r.title, languages[0] ?? null);
    films.set(r.trackList, {
      sourceId: r.trackList, title, year: year ?? undefined, runtime: r.duration ?? undefined,
      directors: splitNames(r.director), cast: splitNames(r.starring), genres: splitList(r.genre, "/"),
      rating: r.rating ?? undefined, languages, subtitles: splitList(r.subtitles), synopsis: r.summary ?? undefined,
      poster: r.posterImage ?? r.image ?? undefined, categories: [category],
    });
  }
  return [...films.values()];
}

export const emirates: AirlineAdapter = {
  id: "emirates",
  name: "Emirates",
  async fetchMonth(month, { cacheDir, refresh }) {
    const dir = monthDir(cacheDir, "emirates", month);
    const date = fetchDate(month);
    const init = { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } };
    const taxonomy = await cachedJson<IceTaxonomy>({ url: `${BASE}?date=${date}`, path: `${dir}/taxonomy.json`, init, refresh });
    const movies = await cachedJson<EmiratesRaw["movies"]>({ url: `${BASE}?date=${date}&group=movies`, path: `${dir}/movies.json`, init, refresh });
    return { taxonomy, movies } satisfies EmiratesRaw;
  },
  parse: (raw) => parseEmirates(raw as EmiratesRaw),
};

