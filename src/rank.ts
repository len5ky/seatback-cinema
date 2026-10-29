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
export interface Pick { row: PickRow; score: number; reasons: string[] }

const PRIOR_MEAN = 6.5;

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

/** Bayesian-weighted rating (shrinks low-vote films toward 6.5) plus genre and favourite-director adjustments. */
export function scorePick(r: PickRow, taste: Taste, favouriteDirectors: string[] = []): Pick {
  const m = Math.max(taste.min_votes, 1);
  let score = (r.votes / (r.votes + m)) * r.rating + (m / (r.votes + m)) * PRIOR_MEAN;
  const reasons = [`IMDb ${r.rating.toFixed(1)} (${r.votes.toLocaleString("en-US")} votes)`];
  const genres = genreSet(r);
  const liked = taste.liked_genres.filter((g) => genres.has(g.toLowerCase()));
  const disliked = taste.disliked_genres.filter((g) => genres.has(g.toLowerCase()));
  if (liked.length) { score += Math.min(liked.length, 2) * 0.4; reasons.push(`+${liked.join("/")}`); }
  if (disliked.length) { score -= disliked.length * 1.0; reasons.push(`-${disliked.join("/")}`); }
  if (favouriteDirectors.length && directorsMatch(splitNames(r.directors), favouriteDirectors)) {
    score += 0.5; reasons.push(`director of a favourite (${r.directors})`);
  }
  return { row: r, score: Math.round(score * 100) / 100, reasons };
}

export function isSeen(r: PickRow, taste: Taste): boolean {
  const keys = new Set(taste.seen.map((s) => (/^tt\d+$/.test(s) ? s : normalizeTitle(s))));
  return keys.has(r.tconst) || keys.has(normalizeTitle(r.title)) || keys.has(normalizeTitle(r.imdb_title));
}

export interface PickOptions { airline: string; month: string; top: number; genre?: string; minRating?: number; language?: string }

export function picks(db: Database, taste: Taste, o: PickOptions): { picks: Pick[]; excludedLow: number; unmatched: number } {
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
  const minRating = o.minRating ?? taste.min_rating;
  const seenTconst = new Set<string>();
  const out = rows
    .filter((r) => r.rating >= minRating && r.votes >= taste.min_votes && !isSeen(r, taste))
    .filter((r) => !o.genre || genreSet(r).has(o.genre.toLowerCase()))
    .filter((r) => !o.language || (r.primary_language ?? "").toLowerCase() === o.language.toLowerCase())
    .map((r) => scorePick(r, taste, favDirs))
    .sort((a, b) => b.score - a.score)
    .filter((p) => !seenTconst.has(p.row.tconst) && !!seenTconst.add(p.row.tconst)) // two source ids, one film
    .slice(0, o.top);
  return { picks: out, excludedLow: counts?.low ?? 0, unmatched: counts?.none ?? 0 };
}

/** Directors of favourite titles, resolved to the most-voted IMDb title with that name. */
function favouriteDirectors(db: Database, favourites: string[]): string[] {
  const top = db.query<{ directors: string | null }, [string]>(
    "SELECT t.directors FROM imdb_keys k JOIN imdb_titles t USING (tconst) WHERE k.norm = ? ORDER BY t.votes DESC LIMIT 1");
  const name = db.query<{ name: string }, [string]>("SELECT name FROM imdb_names WHERE nconst = ?");
  return favourites.flatMap((f) => (top.get(normalizeTitle(f))?.directors?.split(",") ?? []).flatMap((n) => name.get(n)?.name ?? []));
}
