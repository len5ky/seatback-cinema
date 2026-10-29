import { Database } from "bun:sqlite";
import { normalizeTitle, splitNames } from "./text.ts";
import { directorsMatch } from "./match.ts";

export interface Taste {
  liked_genres: string[]; disliked_genres: string[]; min_rating: number; min_votes: number;
  seen: string[]; favourites: string[];
}
export interface PickRow {
  source_id: string; title: string; directors: string | null; genres: string | null; runtime: number | null;
  year: number | null; primary_language: string | null; synopsis: string | null; tconst: string; confidence: string;
  imdb_title: string; start_year: number | null; imdb_genres: string | null; rating: number; votes: number; imdb_directors: string | null;
}
export interface Pick { row: PickRow; score: number; reasons: string[]; sources: string[] }

const PRIOR_MEAN = 6.5;

/** Ratings stored by `ratings sync`, native scales (letterboxd 0.5-5, rt_audience 0-100, mc_critics 0-100). */
export type FilmRatings = Partial<Record<"letterboxd" | "rt_audience" | "mc_critics", { value: number; votes: number | null }>>;

/** Blend weights before re-normalisation; IMDb and Letterboxd are further scaled by how many votes back them. */
export const BLEND_WEIGHTS = { imdb: 0.4, letterboxd: 0.3, rt_audience: 0.15, mc_critics: 0.15 } as const;
/** 0.2 at 1 vote, 1.0 from 100k votes: a rating backed by few votes counts less in the blend. */
export const voteWeight = (votes: number | null) => Math.min(1, Math.max(0.2, Math.log10((votes ?? 0) + 1) / 5));

export interface BlendPart { source: string; value: number; weight: number }
/** Weighted mean of 10-point values; missing sources simply drop out and the rest re-normalise. */
export function blend(parts: BlendPart[]): number {
  const w = parts.reduce((s, p) => s + p.weight, 0);
  return w ? parts.reduce((s, p) => s + p.value * p.weight, 0) / w : PRIOR_MEAN;
}

/** Blend parts for one film: IMDb (Bayesian-shrunk toward 6.5 by min_votes) plus whichever other sources have a score. */
export function blendParts(r: { rating: number; votes: number }, ratings: FilmRatings, minVotes: number): BlendPart[] {
  const m = Math.max(minVotes, 1);
  const imdb = (r.votes / (r.votes + m)) * r.rating + (m / (r.votes + m)) * PRIOR_MEAN;
  const parts: BlendPart[] = [{ source: "imdb", value: imdb, weight: BLEND_WEIGHTS.imdb * voteWeight(r.votes) }];
  const lb = ratings.letterboxd, rt = ratings.rt_audience, mc = ratings.mc_critics;
  if (lb) parts.push({ source: "letterboxd", value: lb.value * 2, weight: BLEND_WEIGHTS.letterboxd * voteWeight(lb.votes) });
  if (rt) parts.push({ source: "rt_audience", value: rt.value / 10, weight: BLEND_WEIGHTS.rt_audience });
  if (mc) parts.push({ source: "mc_critics", value: mc.value / 10, weight: BLEND_WEIGHTS.mc_critics });
  return parts;
}

export interface Affinity { value: number; n: number }
export interface TasteModel {
  mean: number; rated: number;
  genres: Map<string, Affinity>; directors: Map<string, Affinity>;
  watched: Set<string>; watchlist: Set<string>;
}
export interface RatedFilm { rating: number; genres: string[]; directors: string[] }
/** Pseudo-count pulling affinities toward 0: one 9/10 film says little, ten say a lot. */
export const SHRINK = 3;
export const WATCHLIST_BOOST = 1.5;

/** Affinity of a genre or director = sum of (your rating - your mean) over the films that have it, divided by (count + SHRINK). */
export function learnAffinities(films: RatedFilm[]): Omit<TasteModel, "watched" | "watchlist"> {
  const mean = films.length ? films.reduce((s, f) => s + f.rating, 0) / films.length : 0;
  const acc = (key: (f: RatedFilm) => string[]) => {
    const sums = new Map<string, { d: number; n: number }>();
    for (const f of films) for (const k of new Set(key(f))) {
      const e = sums.get(k) ?? { d: 0, n: 0 };
      e.d += f.rating - mean; e.n++;
      sums.set(k, e);
    }
    return new Map([...sums].map(([k, e]) => [k, { value: e.d / (e.n + SHRINK), n: e.n }]));
  };
  return { mean, rated: films.length, genres: acc((f) => f.genres.map((g) => g.toLowerCase())), directors: acc((f) => f.directors) };
}

/** The user's IMDb and Letterboxd films (one row per tconst, ratings averaged across sources) as a taste model; null when nothing was imported. */
export function loadTasteModel(db: Database): TasteModel | null {
  const rows = db.query<{ tconst: string; rating: number | null; watched: number; watchlist: number; genres: string | null; directors: string | null }, []>(`
    SELECT u.tconst, AVG(u.rating) AS rating, MAX(u.watched) AS watched, MAX(u.watchlist) AS watchlist, t.genres, t.directors
    FROM user_films u LEFT JOIN imdb_titles t USING (tconst) WHERE u.tconst IS NOT NULL GROUP BY u.tconst`).all();
  if (!rows.length) return null;
  const rated = rows.filter((r): r is typeof r & { rating: number } => r.rating !== null)
    .map((r) => ({ rating: r.rating, genres: r.genres?.split(",") ?? [], directors: r.directors?.split(",") ?? [] }));
  return {
    ...learnAffinities(rated),
    watched: new Set(rows.filter((r) => r.watched || r.rating !== null).map((r) => r.tconst)),
    watchlist: new Set(rows.filter((r) => r.watchlist).map((r) => r.tconst)),
  };
}

/** Taste adjustment: mean genre affinity over the film's genres plus mean director affinity; reasons for the (up to 3) strongest. */
export function tasteAdjustment(model: TasteModel, genres: string[], directors: string[], nameOf: (nconst: string) => string = (n) => n): { delta: number; reasons: string[] } {
  const notable: { v: number; text: string }[] = [];
  const term = (keys: string[], map: Map<string, Affinity>, label: (k: string) => string) => {
    if (!keys.length) return 0;
    let sum = 0;
    for (const k of keys) {
      const a = map.get(k);
      if (!a) continue;
      sum += a.value;
      if (Math.abs(a.value) >= 0.3) notable.push({ v: a.value, text: `you rate ${label(k)} ${a.value > 0 ? "+" : ""}${a.value.toFixed(1)} (${a.n} film${a.n === 1 ? "" : "s"})` });
    }
    return sum / keys.length;
  };
  const g = term(genres.map((x) => x.toLowerCase()), model.genres, (k) => k);
  const d = term(directors, model.directors, nameOf);
  const reasons = notable.sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 3).map((n) => n.text);
  return { delta: g + d, reasons };
}

export async function loadTaste(path = "taste.json"): Promise<Taste> {
  const file = Bun.file(path);
  const t = (await file.exists() ? await file.json() : {}) as Partial<Taste>;
  return {
    liked_genres: t.liked_genres ?? [], disliked_genres: t.disliked_genres ?? [], min_rating: t.min_rating ?? 0,
    min_votes: t.min_votes ?? 1000, seen: t.seen ?? [], favourites: t.favourites ?? [],
  };
}

const genreSet = (r: PickRow) =>
  new Set([...(r.imdb_genres?.split(",") ?? []), ...(r.genres?.split(/[,/]/) ?? [])].map((g) => g.trim().toLowerCase()).filter(Boolean));

export interface ScoreExtras { ratings?: FilmRatings; model?: TasteModel | null; nameOf?: (nconst: string) => string }

/**
 * Blend of IMDb (Bayesian-shrunk), Letterboxd, RT audience and Metacritic, then taste: affinities learned from your
 * Letterboxd ratings, a watchlist boost, and taste.json genre/favourite overrides. With IMDb alone this is the v1 score.
 */
export function scorePick(r: PickRow, taste: Taste, favouriteDirectors: string[] = [], x: ScoreExtras = {}): Pick {
  const ratings = x.ratings ?? {};
  const parts = blendParts(r, ratings, taste.min_votes);
  let score = blend(parts);
  const reasons = [`IMDb ${r.rating.toFixed(1)} (${r.votes.toLocaleString("en-US")} votes)`];
  if (ratings.letterboxd) reasons.push(`Letterboxd ${ratings.letterboxd.value.toFixed(1)}/5`);
  if (ratings.rt_audience) reasons.push(`RT audience ${ratings.rt_audience.value}%`);
  if (ratings.mc_critics) reasons.push(`Metacritic ${ratings.mc_critics.value}`);
  if (x.model) {
    if (x.model.watchlist.has(r.tconst)) { score += WATCHLIST_BOOST; reasons.push("on your watchlist"); }
    const t = tasteAdjustment(x.model, r.imdb_genres?.split(",") ?? [], r.imdb_directors?.split(",") ?? [], x.nameOf);
    score += t.delta;
    reasons.push(...t.reasons);
  }
  const genres = genreSet(r);
  const liked = taste.liked_genres.filter((g) => genres.has(g.toLowerCase()));
  const disliked = taste.disliked_genres.filter((g) => genres.has(g.toLowerCase()));
  if (liked.length) { score += Math.min(liked.length, 2) * 0.4; reasons.push(`+${liked.join("/")}`); }
  if (disliked.length) { score -= disliked.length * 1.0; reasons.push(`-${disliked.join("/")}`); }
  if (favouriteDirectors.length && directorsMatch(splitNames(r.directors), favouriteDirectors)) {
    score += 0.5; reasons.push(`director of a favourite (${r.directors})`);
  }
  return { row: r, score: Math.round(score * 100) / 100, reasons, sources: parts.map((p) => p.source) };
}

export function isSeen(r: PickRow, taste: Taste): boolean {
  const keys = new Set(taste.seen.map((s) => (/^tt\d+$/.test(s) ? s : normalizeTitle(s))));
  return keys.has(r.tconst) || keys.has(normalizeTitle(r.title)) || keys.has(normalizeTitle(r.imdb_title));
}

export interface PickOptions { airline: string; month: string; top: number; genre?: string; minRating?: number; language?: string }

export function picks(db: Database, taste: Taste, o: PickOptions): { picks: Pick[]; excludedLow: number; unmatched: number; watched: number; model: TasteModel | null } {
  const rows = db.query<PickRow, [string, string]>(`
    SELECT m.source_id, m.title, m.directors, m.genres, m.runtime, m.year, m.primary_language, m.synopsis,
           x.tconst, x.confidence, t.primary_title AS imdb_title, t.start_year, t.genres AS imdb_genres,
           t.rating, t.votes, t.directors AS imdb_directors
    FROM movies m JOIN matches x ON x.airline = m.airline AND x.source_id = m.source_id
    JOIN imdb_titles t ON t.tconst = x.tconst
    WHERE m.airline = ? AND m.month = ? AND x.confidence IN ('high','medium') AND t.rating IS NOT NULL`).all(o.airline, o.month);
  const counts = db.query<{ low: number; none: number }, [string, string]>(`
    SELECT SUM(x.confidence = 'low') AS low, SUM(x.confidence = 'none' OR x.confidence IS NULL) AS none
    FROM movies m LEFT JOIN matches x ON x.airline = m.airline AND x.source_id = m.source_id WHERE m.airline = ? AND m.month = ?`).get(o.airline, o.month);
  const favDirs = favouriteDirectors(db, taste.favourites);
  const model = loadTasteModel(db);
  const ratings = filmRatings(db, o.airline, o.month);
  const nameQ = db.query<{ name: string }, [string]>("SELECT name FROM imdb_names WHERE nconst = ?");
  const nameOf = (n: string) => nameQ.get(n)?.name ?? n;
  const watched = rows.filter((r) => model?.watched.has(r.tconst)).length;
  const minRating = o.minRating ?? taste.min_rating;
  const seenTconst = new Set<string>();
  const out = rows
    .filter((r) => r.rating >= minRating && r.votes >= taste.min_votes && !isSeen(r, taste) && !model?.watched.has(r.tconst))
    .filter((r) => !o.genre || genreSet(r).has(o.genre.toLowerCase()))
    .filter((r) => !o.language || (r.primary_language ?? "").toLowerCase() === o.language.toLowerCase())
    .map((r) => scorePick(r, taste, favDirs, { ratings: ratings.get(r.tconst), model, nameOf }))
    .sort((a, b) => b.score - a.score)
    .filter((p) => !seenTconst.has(p.row.tconst) && !!seenTconst.add(p.row.tconst)) // two source ids, one film
    .slice(0, o.top);
  return { picks: out, excludedLow: counts?.low ?? 0, unmatched: counts?.none ?? 0, watched, model };
}

/** Stored scores for every matched film of an airline-month. */
function filmRatings(db: Database, airline: string, month: string): Map<string, FilmRatings> {
  const rows = db.query<{ tconst: string; source: keyof FilmRatings; value: number; votes: number | null }, [string, string]>(`
    SELECT DISTINCT r.tconst, r.source, r.value, r.votes FROM movies m
    JOIN matches x ON x.airline = m.airline AND x.source_id = m.source_id
    JOIN ratings r ON r.tconst = x.tconst
    WHERE m.airline = ? AND m.month = ? AND r.value IS NOT NULL AND r.source IN ('letterboxd','rt_audience','mc_critics')`).all(airline, month);
  const out = new Map<string, FilmRatings>();
  for (const r of rows) {
    const f = out.get(r.tconst) ?? {};
    f[r.source] = { value: r.value, votes: r.votes };
    out.set(r.tconst, f);
  }
  return out;
}

/** Directors of favourite titles, resolved to the most-voted IMDb title with that name. */
function favouriteDirectors(db: Database, favourites: string[]): string[] {
  const top = db.query<{ directors: string | null }, [string]>(
    "SELECT t.directors FROM imdb_keys k JOIN imdb_titles t USING (tconst) WHERE k.norm = ? ORDER BY t.votes DESC LIMIT 1");
  const name = db.query<{ name: string }, [string]>("SELECT name FROM imdb_names WHERE nconst = ?");
  return favourites.flatMap((f) => (top.get(normalizeTitle(f))?.directors?.split(",") ?? []).flatMap((n) => name.get(n)?.name ?? []));
}
