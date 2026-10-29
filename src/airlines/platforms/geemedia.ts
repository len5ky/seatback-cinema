import type { AirlineAdapter, CatalogueFilm } from "../types.ts";
import { cachedJson, fetchDate, monthDir, splitList, uniq } from "../http.ts";
import { languageName } from "../lang.ts";
import { splitNames, splitYearSuffix } from "../../text.ts";

/**
 * Gee Media / Anuvu "Airtime" content API (United, KLM; Cathay runs the same API at afg.anuvu.cloud/api/v1).
 * A guest session (empty credentials, public per-airline host-id) gives an auth token; one GET returns the
 * Movies section tree: section -> carousels -> movie nodes.
 */
export interface AirtimeConfig {
  id: string;
  name: string;
  hostId: string;
  /** Id of the "Movies" section. It may change; `/content/items?max_child_depth=0` lists the top sections. */
  sectionId: string;
  /** API root including version, e.g. https://api.airtime.geemedia.com/api/v3 or https://afg.anuvu.cloud/api/v1 */
  baseUrl?: string;
  maxChildPerItem?: number;
}
export const GEEMEDIA_V3 = "https://api.airtime.geemedia.com/api/v3";

interface Attribute { type?: string; title?: string; name?: string }
export interface AirtimeNode {
  id: string | number; template?: string | null; title?: string; name?: string;
  year?: string | number | null; release_date?: string | null; duration_minute?: string | number | null;
  director_list?: string | null; cast_list?: string | null; long_description?: string | null;
  movie_language?: string[] | string | null; subtitle_language?: string[] | string | null;
  attributes?: Attribute[] | null; poster_image?: unknown; child_items?: AirtimeNode[] | null;
}
export interface AirtimeTree { count?: unknown; items: AirtimeNode[] }

const int = (v: string | number | null | undefined): number | undefined => {
  const n = typeof v === "number" ? v : Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const codes = (v: string[] | string | null | undefined): string[] =>
  uniq((Array.isArray(v) ? v : splitList(v)).map(languageName));

/** First http(s) URL inside a nested image object ({ microportal_tablet: { "600x888": [url] } }). */
function firstUrl(v: unknown): string | undefined {
  if (typeof v === "string") return /^https?:\/\//.test(v) ? v : undefined;
  if (Array.isArray(v)) { for (const x of v) { const u = firstUrl(x); if (u) return u; } return undefined; }
  if (v && typeof v === "object") { for (const x of Object.values(v)) { const u = firstUrl(x); if (u) return u; } }
  return undefined;
}

export function toFilm(n: AirtimeNode, category: string | undefined): CatalogueFilm {
  const attrs = n.attributes ?? [];
  const label = (a: Attribute) => a.title?.trim() || a.name?.trim() || "";
  const t = splitYearSuffix(n.title ?? n.name ?? "");
  return {
    sourceId: String(n.id),
    title: t.title,
    year: int(n.year) ?? int(n.release_date?.slice(0, 4)) ?? t.year,
    runtime: int(n.duration_minute),
    directors: splitNames(n.director_list),
    cast: splitNames(n.cast_list),
    genres: uniq(attrs.filter((a) => a.type === "genre").map(label)),
    rating: attrs.filter((a) => a.type === "classification").map(label).find(Boolean),
    languages: codes(n.movie_language),
    subtitles: codes(n.subtitle_language),
    synopsis: n.long_description?.trim() || undefined,
    poster: firstUrl(n.poster_image),
    categories: category ? [category] : [],
  };
}

/** Walk the section tree; each movie's categories are the titles of the sections that place it. Deduped on node id. */
export function parseAirtime(raw: AirtimeTree): CatalogueFilm[] {
  const films = new Map<string, CatalogueFilm>();
  const walk = (node: AirtimeNode, section: string | undefined) => {
    if (node.template === "movie") {
      const id = String(node.id);
      const existing = films.get(id);
      if (!existing) films.set(id, toFilm(node, section));
      else if (section && !existing.categories.includes(section)) existing.categories.push(section);
      return;
    }
    const here = node.template === "section" ? (node.title?.trim() || node.name?.trim() || section) : section;
    for (const c of node.child_items ?? []) walk(c, here);
  };
  for (const item of raw.items) walk(item, undefined);
  return [...films.values()].filter((f) => f.title);
}

export function airtimeAdapter(cfg: AirtimeConfig): AirlineAdapter {
  const base = cfg.baseUrl ?? GEEMEDIA_V3;
  return {
    id: cfg.id,
    name: cfg.name,
    async fetchMonth(month, { cacheDir, refresh }) {
      const path = `${monthDir(cacheDir, cfg.id, month)}/movies-${cfg.sectionId}.json`;
      if (!refresh && (await Bun.file(path).exists())) return Bun.file(path).json();
      // guest session: a fresh token per fetch; tokens are not cached
      const session = await cachedJson<{ auth_token?: string }>({
        url: `${base}/account/session`, path: `${monthDir(cacheDir, cfg.id, month)}/session.json`, refresh: true, minBytes: 10,
        init: { method: "POST", headers: { "host-id": cfg.hostId, "Content-Type": "application/json" }, body: JSON.stringify({ email: "", password: "" }) },
      });
      if (!session.auth_token) throw new Error(`${cfg.id}: guest session returned no auth_token`);
      const q = new URLSearchParams({
        max_child_depth: "2", max_child_per_item: String(cfg.maxChildPerItem ?? 1000), staging: "false", child_items: "true",
        flight_date: fetchDate(month), language: "en",
      });
      return cachedJson<AirtimeTree>({
        url: `${base}/content/items/${cfg.sectionId}?${q}`, path, refresh: true,
        init: { headers: { "host-id": cfg.hostId, "auth-token": session.auth_token, Accept: "application/json" } },
      });
    },
    parse: (raw) => parseAirtime(raw as AirtimeTree),
  };
}
