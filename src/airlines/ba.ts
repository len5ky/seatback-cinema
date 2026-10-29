import type { AirlineAdapter, CatalogueFilm } from "./types.ts";
import { assertCurrentMonth, BROWSER_UA, cachedJson, monthDir, uniq } from "./http.ts";
import { languageName } from "./lang.ts";
import { splitYearSuffix } from "../text.ts";

/**
 * British Airways High Life (entertainment.ba.com, an Anuvu microsite). The direct Anuvu API is 403; the site's
 * same-origin proxy works with a browser User-Agent (a bare UA is tarpitted by Akamai). One layout call lists the
 * Movies sections, then one call per section with pageSize=500. There is no month selector: current cycle only.
 */
const BASE = "https://entertainment.ba.com/api";
const MICROSITE = "british-airways";
const PAGE_SIZE = 500;

interface Named { name?: string | null; code?: string | null }
export interface BaItem {
  id: string; type: string; title: string; providerCmsId?: string; description?: string | null;
  directors?: Named[] | null; cast?: Named[] | null; durationMinutes?: number | null; year?: number | null;
  audioLanguages?: Named[] | null; subtitleLanguages?: Named[] | null; classifications?: Named[] | null; genres?: Named[] | null;
  images?: { poster_image?: { variants?: Record<string, string> } | null } | null;
}
export interface BaSection { id: string; title: string; items: BaItem[]; pagination?: { total: number; page: number; totalPages: number } }
export interface BaLayout { sections: { id: string; title: string }[] }
export interface BaRaw { layout: BaLayout; sections: BaSection[] }

const names = (xs: Named[] | null | undefined) => uniq((xs ?? []).map((x) => x.name));
const langs = (xs: Named[] | null | undefined) => uniq((xs ?? []).map((x) => (x.code ? languageName(x.code) : x.name)));

export function parseBa(raw: BaRaw): CatalogueFilm[] {
  const films = new Map<string, CatalogueFilm>();
  for (const s of raw.sections) {
    for (const it of s.items) {
      if (it.type !== "movie") continue; // editorial cards are mixed into some sections
      const existing = films.get(it.id);
      if (existing) {
        if (!existing.categories.includes(s.title)) existing.categories.push(s.title);
        continue;
      }
      const poster = it.images?.poster_image?.variants;
      const t = splitYearSuffix(it.title);
      films.set(it.id, {
        sourceId: it.id, title: t.title, year: it.year ?? t.year, runtime: it.durationMinutes || undefined,
        directors: names(it.directors), cast: names(it.cast), genres: names(it.genres), rating: names(it.classifications)[0],
        languages: langs(it.audioLanguages), subtitles: langs(it.subtitleLanguages), synopsis: it.description?.trim() || undefined,
        poster: poster?.desktop ?? poster?.mobile ?? Object.values(poster ?? {})[0], categories: [s.title],
      });
    }
  }
  return [...films.values()];
}

export const ba: AirlineAdapter = {
  id: "ba",
  name: "British Airways",
  async fetchMonth(month, { cacheDir, refresh }) {
    const dir = monthDir(cacheDir, "ba", month);
    if (refresh || !(await Bun.file(`${dir}/layout.json`).exists())) assertCurrentMonth("ba", month);
    const init = { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } };
    const layout = await cachedJson<BaLayout>({ url: `${BASE}/page-layout?microsite=${MICROSITE}&page=movies`, path: `${dir}/layout.json`, init, refresh });
    const sections: BaSection[] = [];
    for (const s of layout.sections) {
      const url = `${BASE}/section-content?microsite=${MICROSITE}&section=${s.id}&pageSize=${PAGE_SIZE}`;
      const sec = await cachedJson<BaSection>({ url, path: `${dir}/section-${s.id}.json`, init, refresh, minBytes: 2 });
      if ((sec.pagination?.totalPages ?? 1) > 1) throw new Error(`ba section "${s.title}" has more than ${PAGE_SIZE} items; add paging`);
      sections.push({ ...sec, title: sec.title ?? s.title });
    }
    return { layout, sections } satisfies BaRaw;
  },
  parse: (raw) => parseBa(raw as BaRaw),
};
