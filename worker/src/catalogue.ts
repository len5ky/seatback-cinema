// Catalogue queries over the bundle: filters, compact listing, and ranked picks (src/rank-core.ts scoring).
import type { Bundle, BundleAirline, BundleFilm } from "../../src/bundle.ts";
import { genreSet, inYears, learnAffinities, scorePick, type PickRow, type RatedFilm, type Taste, type TasteModel } from "../../src/rank-core.ts";
import { normalizeTitle } from "../../src/text.ts";
import type { Profile } from "./profile.ts";

export interface Filters {
  genre?: string[]; exclude_genre?: string[]; min_year?: number; max_year?: number; min_runtime?: number; max_runtime?: number;
  family?: boolean; language?: string; query?: string; matched_only?: boolean;
}

const MIN_VOTES = 1000; // films with fewer IMDb votes are not ranked (same default as the CLI)
const ADULT_CERT = /^(R|NC-?17|18|R18|16|15|MA ?15\+?|TV-MA|PG ?15|X)$/i;
const FAMILY_CERT = /^(G|PG|PG-?13|U|0|6|7|12A?|TV-Y7?|TV-G|TV-PG)$/i;
const FAMILY_GENRE = /famil|kid|child|anim|cartoon/i;

/** Certificates G/PG/PG-13/U and the like; unrated films only when their genres say family, kids or animation. */
export function isFamily(f: BundleFilm): boolean {
  const c = f.cert?.trim() ?? "";
  if (ADULT_CERT.test(c)) return false;
  if (FAMILY_CERT.test(c)) return true;
  return [...f.genres, ...f.imdbGenres].some((g) => FAMILY_GENRE.test(g));
}

/** The film in the shape scorePick expects. */
export function toPickRow(f: BundleFilm, names: Record<string, string>): PickRow {
  const directors = f.directors.length ? f.directors : f.directorIds.map((n) => names[n] ?? n);
  return {
    source_id: f.sourceId, title: f.title, directors: directors.join(", ") || null, genres: f.genres.join(", ") || null,
    runtime: f.runtime, year: f.year, primary_language: f.languages[0] ?? null, synopsis: f.synopsis,
    tconst: f.imdbId ?? "", confidence: f.confidence ?? "none", imdb_title: f.imdbTitle ?? f.title, start_year: f.imdbYear,
    imdb_genres: f.imdbGenres.join(",") || null, rating: f.imdb ?? 0, votes: f.votes ?? 0, imdb_directors: f.directorIds.join(",") || null,
  };
}

export function matchesFilters(f: BundleFilm, row: PickRow, x: Filters): boolean {
  if ((x.matched_only ?? true) && !f.imdbId) return false;
  const genres = [...genreSet(row)];
  const has = (g: string) => genres.some((h) => h.includes(g.trim().toLowerCase()));
  if (x.genre?.length && !x.genre.some(has)) return false;
  if (x.exclude_genre?.some(has)) return false;
  if ((x.min_year !== undefined || x.max_year !== undefined) && !inYears(row, x.min_year, x.max_year)) return false;
  if (x.min_runtime !== undefined && (f.runtime === null || f.runtime < x.min_runtime)) return false;
  if (x.max_runtime !== undefined && (f.runtime === null || f.runtime > x.max_runtime)) return false;
  if (x.family && !isFamily(f)) return false;
  if (x.language && (f.languages[0] ?? "").toLowerCase() !== x.language.trim().toLowerCase()) return false;
  if (x.query) {
    const q = normalizeTitle(x.query);
    if (!normalizeTitle(f.title).includes(q) && !normalizeTitle(f.imdbTitle ?? "").includes(q)) return false;
  }
  return true;
}

/** A profile resolved against the catalogue: tconst keys as-is, "lb:<slug>" via the Letterboxd crosswalk, "Title (Year)" by title and year. */
export interface AppliedProfile { model: TasteModel; taste: Taste; favDirs: string[]; source: string }

export class Catalogue {
  private byId = new Map<string, BundleFilm>();
  private byTitle = new Map<string, Set<string>>(); // normalised title -> tconsts
  private byTmdb = new Map<number, string>();
  private rows = new WeakMap<BundleFilm, PickRow>();

  constructor(readonly bundle: Bundle) {
    for (const a of bundle.airlines) for (const f of a.films) {
      if (!f.imdbId) continue;
      this.byId.set(f.imdbId, f);
      if (f.tmdbId !== null) this.byTmdb.set(f.tmdbId, f.imdbId);
      for (const t of [f.title, f.imdbTitle]) if (t) {
        const k = normalizeTitle(t);
        this.byTitle.set(k, (this.byTitle.get(k) ?? new Set()).add(f.imdbId));
      }
    }
  }

  airline(id: string): BundleAirline | undefined {
    const k = id.trim().toLowerCase();
    return this.bundle.airlines.find((a) => a.id === k || a.name.toLowerCase() === k);
  }

  row(f: BundleFilm): PickRow {
    let r = this.rows.get(f);
    if (!r) this.rows.set(f, (r = toPickRow(f, this.bundle.names)));
    return r;
  }

  listAirlines() {
    return this.bundle.airlines.map((a) => ({
      id: a.id, name: a.name, month: a.month, films: a.films.length, matched: a.films.filter((f) => f.imdbId).length, health: a.health,
    }));
  }

  filtered(a: BundleAirline, x: Filters): BundleFilm[] {
    return a.films.filter((f) => matchesFilters(f, this.row(f), x));
  }

  /** The tconst of a catalogue film with this TMDB id. */
  tmdb(id: number): string | null {
    return this.byTmdb.get(id) ?? null;
  }

  resolve(key: string): string | null {
    const k = key.trim();
    if (/^tt\d+$/.test(k)) return k;
    if (k.startsWith("lb:")) return this.bundle.letterboxd[k.slice(3)] ?? null;
    if (this.bundle.letterboxd[k]) return this.bundle.letterboxd[k]!;
    const m = k.match(/^(.*?)\s*\((\d{4})\)$/);
    const ids = [...(this.byTitle.get(normalizeTitle(m ? m[1]! : k)) ?? [])];
    if (!m) return ids.length === 1 ? ids[0]! : null;
    const year = Number(m[2]);
    const hit = ids.filter((id) => {
      const f = this.byId.get(id)!;
      return [f.imdbYear, f.year].some((y) => y !== null && Math.abs(y - year) <= 1);
    });
    return hit.length === 1 ? hit[0]! : null;
  }

  applyProfile(p: Profile, source: string): AppliedProfile {
    const watched = new Set<string>(), watchlist = new Set<string>();
    const rated: RatedFilm[] = [];
    for (const k of p.seen) { const id = this.resolve(k); if (id) watched.add(id); }
    for (const k of p.watchlist ?? []) { const id = this.resolve(k); if (id) watchlist.add(id); }
    for (const [k, rating] of Object.entries(p.ratings ?? {})) {
      const id = this.resolve(k);
      if (!id) continue;
      watched.add(id);
      const f = this.byId.get(id);
      if (f) rated.push({ rating, genres: f.imdbGenres, directors: f.directorIds });
    }
    const taste: Taste = {
      liked_genres: p.liked_genres ?? [], disliked_genres: p.disliked_genres ?? [], min_rating: 0, min_votes: MIN_VOTES, seen: [], favourites: [],
    };
    return { model: { ...learnAffinities(rated), watched, watchlist }, taste, favDirs: p.liked_directors ?? [], source };
  }

  picks(a: BundleAirline, o: { filters: Filters; flightMinutes?: number; profile: AppliedProfile | null; limit: number }) {
    const taste = o.profile?.taste ?? { liked_genres: [], disliked_genres: [], min_rating: 0, min_votes: MIN_VOTES, seen: [], favourites: [] };
    const model = o.profile?.model ?? null;
    const nameOf = (n: string) => this.bundle.names[n] ?? n;
    const maxRuntime = o.flightMinutes !== undefined ? o.flightMinutes - 30 : undefined;
    const pool = this.filtered(a, { ...o.filters, matched_only: true }).filter((f) => f.imdb !== null && (f.votes ?? 0) >= MIN_VOTES);
    const hidden = model ? pool.filter((f) => model.watched.has(f.imdbId!)).length : 0;
    const ranked = pool
      .filter((f) => !model?.watched.has(f.imdbId!))
      .filter((f) => maxRuntime === undefined || f.runtime === null || f.runtime <= maxRuntime)
      .map((f) => ({ f, p: scorePick(this.row(f), taste, o.profile?.favDirs ?? [], { ratings: f.ratings, model, nameOf }) }))
      .sort((x, y) => y.p.score - x.p.score)
      .slice(0, o.limit);
    const cards = ranked.map(({ f, p }) => ({
      imdbId: f.imdbId!, title: f.title, year: f.year ?? f.imdbYear, runtime: f.runtime,
      genres: f.genres.length ? f.genres : f.imdbGenres, cert: f.cert, imdb: f.imdb!, votes: f.votes ?? 0,
      ...(f.ratings.letterboxd ? { letterboxd: f.ratings.letterboxd.value } : {}),
      ...(f.ratings.rt_audience ? { rt: f.ratings.rt_audience.value } : {}),
      ...(f.ratings.mc_critics ? { metacritic: f.ratings.mc_critics.value } : {}),
      blended: f.blended, score: p.score, why: p.reasons, synopsis: f.synopsis,
      directors: f.directors.length ? f.directors : f.directorIds.map(nameOf), cast: f.cast,
      confidence: f.confidence, onWatchlist: !!model?.watchlist.has(f.imdbId!),
    }));
    return { airline: a.id, month: a.month, picks: cards, hidden_seen: hidden, profile_source: o.profile?.source ?? "none" };
  }
}
