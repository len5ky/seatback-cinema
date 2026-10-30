import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { exportSnapshot, PUBLIC_DIR } from "./export.ts";
import { blend, blendParts, truncateAtWord, type FilmRatings } from "./rank-core.ts";
import type { Bundle, BundleAirline, BundleFilm } from "./bundle.ts";

export const WORKER_BUNDLE = "worker/generated/catalogue.json";
const SYNOPSIS_MAX = 240;
const MIN_VOTES = 1000; // same Bayesian prior strength as `picks` (taste.json default)

interface Imdb { primary_title: string; start_year: number | null; genres: string | null; rating: number | null; votes: number | null; directors: string | null }

/** Latest month of every airline as the Worker bundle (see src/bundle.ts). Synopses and cast stay private: never written under public/. */
export function buildWorkerBundle(db: Database, healthPath = `${PUBLIC_DIR}/health.json`): Bundle {
  const health = existsSync(healthPath)
    ? (JSON.parse(readFileSync(healthPath, "utf8")) as { airlines?: Record<string, { status?: string }> }).airlines ?? {}
    : {};
  const latest = db.query<{ airline: string; month: string }, []>("SELECT airline, MAX(month) AS month FROM snapshots GROUP BY airline ORDER BY airline").all();
  const extra = db.query<{ synopsis: string | null; cast: string | null }, [string, string, string]>(
    'SELECT synopsis, "cast" FROM movies WHERE airline = ? AND month = ? AND source_id = ?');
  const imdbQ = db.query<Imdb, [string]>("SELECT primary_title, start_year, genres, rating, votes, directors FROM imdb_titles WHERE tconst = ?");
  const ratingsQ = db.query<{ source: keyof FilmRatings; value: number; votes: number | null }, [string]>(
    "SELECT source, value, votes FROM ratings WHERE tconst = ? AND value IS NOT NULL AND source IN ('letterboxd','rt_audience','mc_critics')");
  const nameQ = db.query<{ name: string }, [string]>("SELECT name FROM imdb_names WHERE nconst = ?");
  const slugQ = db.query<{ letterboxd_slug: string | null }, [string]>("SELECT letterboxd_slug FROM external_ids WHERE tconst = ?");
  const names: Record<string, string> = {};
  const letterboxd: Record<string, string> = {};

  const airlines = latest.map(({ airline, month }): BundleAirline => {
    const snap = exportSnapshot(db, airline, month);
    const films = snap.films.map((f): BundleFilm => {
      const x = extra.get(airline, month, f.sourceId);
      const t = f.imdbId ? imdbQ.get(f.imdbId) : null;
      const ratings: FilmRatings = {};
      if (f.imdbId) for (const r of ratingsQ.all(f.imdbId)) ratings[r.source] = { value: r.value, votes: r.votes };
      const directorIds = t?.directors?.split(",").filter(Boolean) ?? [];
      for (const n of directorIds) names[n] ??= nameQ.get(n)?.name ?? n;
      const slug = f.imdbId ? slugQ.get(f.imdbId)?.letterboxd_slug : null;
      if (slug && f.imdbId) letterboxd[slug] = f.imdbId;
      const imdb = t?.rating ?? null, votes = t?.votes ?? null;
      const blended = imdb === null ? null : Math.round(blend(blendParts({ rating: imdb, votes: votes ?? 0 }, ratings, MIN_VOTES)) * 100) / 100;
      return {
        sourceId: f.sourceId, title: f.title, year: f.year, runtime: f.runtime, genres: f.genres, cert: f.rating,
        languages: f.languages, categories: f.categories, directors: f.directors, versions: f.versions,
        imdbId: f.imdbId, confidence: f.imdbConfidence, tmdbId: f.tmdbId,
        imdbTitle: t?.primary_title ?? null, imdbYear: t?.start_year ?? null, imdbGenres: t?.genres?.split(",").filter(Boolean) ?? [], directorIds,
        imdb, votes, ratings, blended,
        synopsis: x?.synopsis ? truncateAtWord(x.synopsis, SYNOPSIS_MAX) : null,
        cast: x?.cast ? x.cast.split(", ").slice(0, 3) : [],
      };
    });
    return { id: airline, name: snap.name, month, fetchedAt: snap.fetchedAt, health: health[airline]?.status ?? "unknown", films };
  });
  return { generatedAt: new Date().toISOString(), airlines, names, letterboxd };
}

export function writeWorkerBundle(db: Database, path = WORKER_BUNDLE): { path: string; airlines: number; films: number; bytes: number } {
  const bundle = buildWorkerBundle(db);
  const json = JSON.stringify(bundle);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json);
  return { path, airlines: bundle.airlines.length, films: bundle.airlines.reduce((s, a) => s + a.films.length, 0), bytes: json.length };
}
