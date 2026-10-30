// Shape of worker/generated/catalogue.json: the private bundle the Worker imports at build time. Types only.
import type { FilmRatings } from "./rank-core.ts";

/** One film of an airline's latest month: the public export record plus IMDb data, ratings, synopsis and cast. */
export interface BundleFilm {
  sourceId: string; title: string; year: number | null; runtime: number | null; genres: string[]; cert: string | null;
  languages: string[]; categories: string[]; directors: string[]; versions: number;
  /** tconst when the match is high or medium confidence, else null */
  imdbId: string | null; confidence: string | null; tmdbId: number | null;
  imdbTitle: string | null; imdbYear: number | null; imdbGenres: string[]; directorIds: string[];
  imdb: number | null; votes: number | null; ratings: FilmRatings; blended: number | null;
  synopsis: string | null; cast: string[];
}
export interface BundleAirline { id: string; name: string; month: string; fetchedAt: string; health: string; films: BundleFilm[] }
export interface Bundle {
  generatedAt: string; airlines: BundleAirline[];
  /** nconst -> name for every director id above */
  names: Record<string, string>;
  /** Letterboxd film slug -> tconst, for films in the bundle */
  letterboxd: Record<string, string>;
}
