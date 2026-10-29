// Qantas "What's on this month": one POST per route returns every shelf (movies and TV) for the current month.
import type { AirlineAdapter, CatalogueFilm } from "./types.ts";
import { UA, cachedJson, cleanList, splitNames } from "./platforms/cached-fetch.ts";

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
        directors: splitNames(m.director),
        cast: splitNames(m.cast),
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
  return [...films.values()];
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
    async fetchMonth(month, opts) {
      const raw = (await cachedJson(`${opts.cacheDir}/qantas/${month}/${route}.json`, opts.refresh, () =>
        fetch(`${API}?route=${encodeURIComponent(route)}`, {
          method: "POST",
          headers: { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json" },
          body: "{}",
        }), (parsed) => {
          const served = servedMonth(parsed as QantasRaw);
          if (served !== month) throw new Error(`qantas serves ${served} only, not ${month}`);
        })) as QantasRaw;
      return raw;
    },
    parse: parseQantas,
  };
}

export const qantas = qantasAdapter();
