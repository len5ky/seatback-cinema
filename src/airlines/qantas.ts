// Qantas "What's on this month": one POST per route returns every shelf (movies and TV) for the current month.
import type { AirlineAdapter, CatalogueFilm } from "./types.ts";
import { rmSync } from "node:fs";
import { BROWSER_UA, cachedJson, monthDir } from "./http.ts";
import { cleanList, nameList } from "./platforms/batch.ts";

const API = "https://www.qantas.com/api/entertainment/metadata";

interface QantasMedia {
  content_type: string; title: string; mid: string; genre: string | null; rating: string | null; duration: string | null;
  year: string | null; description: string | null; director: string[] | null; cast: string[] | null;
  audio_data: string[] | null; subtitle_data: string[] | null; image_poster: string | null;
}
export interface QantasRaw { route_name: string; month: string; shelves: { title: string; media: QantasMedia[] }[] }

/** "01:42:00" -> 102 */
function minutes(duration: string | null): number | undefined {
  const m = duration?.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (!m) return undefined;
  const total = Number(m[1]) * 60 + Number(m[2]) + (Number(m[3] ?? 0) >= 30 ? 1 : 0);
  return total || undefined;
}

export function parseQantas(raw: unknown): CatalogueFilm[] {
  const films = new Map<string, CatalogueFilm>();
  for (const shelf of (raw as QantasRaw).shelves) {
    for (const m of shelf.media) {
      if (m.content_type !== "Movie" || !m.mid) continue;
      const existing = films.get(m.mid);
      if (existing) {
        if (!existing.categories.includes(shelf.title)) existing.categories.push(shelf.title);
        continue;
      }
      const year = Number(m.year) || undefined;
      const runtime = minutes(m.duration);
      films.set(m.mid, {
        sourceId: m.mid,
        title: m.title.trim(),
        ...(year ? { year } : {}),
        ...(runtime ? { runtime } : {}),
        directors: nameList(m.director),
        cast: nameList(m.cast),
        genres: cleanList([m.genre]),
        ...(m.rating ? { rating: m.rating } : {}),
        languages: cleanList(m.audio_data),
        subtitles: cleanList(m.subtitle_data),
        ...(m.description ? { synopsis: m.description } : {}),
        ...(m.image_poster ? { poster: m.image_poster } : {}),
        categories: [shelf.title],
      });
    }
  }
  return foldAudioDescriptive([...films.values()]);
}

const AD_SUFFIX = /\s*\(Audio Descriptive\)$/i;
const AD_CATEGORY = "Audio Descriptive";

/**
 * Qantas lists audio-described versions as their own titles ("Toy Story 5 (Audio Descriptive)", own mid). Fold each
 * into the base film with the same title and year, which gains the "Audio Descriptive" category; one with no base
 * keeps its own entry, title stripped, category kept.
 */
export function foldAudioDescriptive(films: CatalogueFilm[]): CatalogueFilm[] {
  const key = (f: CatalogueFilm) => `${f.title.toLowerCase()}|${f.year ?? ""}`;
  const base = new Map(films.filter((f) => !AD_SUFFIX.test(f.title)).map((f) => [key(f), f]));
  const out: CatalogueFilm[] = [];
  for (const f of films) {
    if (!AD_SUFFIX.test(f.title)) { out.push(f); continue; }
    const stripped = { ...f, title: f.title.replace(AD_SUFFIX, ""), categories: f.categories.includes(AD_CATEGORY) ? f.categories : [...f.categories, AD_CATEGORY] };
    const target = base.get(key(stripped));
    if (!target) { out.push(stripped); continue; }
    for (const c of stripped.categories) if (!target.categories.includes(c)) target.categories.push(c);
  }
  return out;
}

/** "1026" -> "2026-10" */
export function servedMonth(raw: QantasRaw): string {
  return `20${raw.month.slice(2)}-${raw.month.slice(0, 2)}`;
}

/** The API only serves the current month; its `month` field is MMYY ("1026"). */
export function qantasAdapter(route = "large_international_seatback"): AirlineAdapter {
  return {
    id: "qantas",
    name: "Qantas",
    async fetchMonth(month, { cacheDir, refresh }) {
      const path = `${monthDir(cacheDir, "qantas", month)}/${route}.json`;
      const raw = await cachedJson<QantasRaw>({
        url: `${API}?route=${encodeURIComponent(route)}`, path, refresh,
        init: { method: "POST", headers: { "User-Agent": BROWSER_UA, "Content-Type": "application/json", Accept: "application/json" }, body: "{}" },
      });
      const served = servedMonth(raw);
      if (served !== month) {
        rmSync(path, { force: true });
        throw new Error(`qantas serves ${served} only, not ${month}`);
      }
      return raw;
    },
    parse: parseQantas,
  };
}

export const qantas = qantasAdapter();
