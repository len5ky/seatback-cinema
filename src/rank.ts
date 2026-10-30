import { Database } from "bun:sqlite";
import { normalizeTitle } from "./text.ts";
import { genreSet, inYears, isSeen, learnAffinities, scorePick, type FilmRatings, type Pick, type PickRow, type Taste, type TasteModel } from "./rank-core.ts";
export * from "./rank-core.ts";

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

export async function loadTaste(path = "taste.json"): Promise<Taste> {
  const file = Bun.file(path);
  const t = (await file.exists() ? await file.json() : {}) as Partial<Taste>;
  return {
    liked_genres: t.liked_genres ?? [], disliked_genres: t.disliked_genres ?? [], min_rating: t.min_rating ?? 0,
    min_votes: t.min_votes ?? 1000, seen: t.seen ?? [], favourites: t.favourites ?? [],
  };
}

export interface PickOptions { airline: string; month: string; top: number; genre?: string; minRating?: number; language?: string; minYear?: number; maxYear?: number }

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
    .filter((r) => (o.minYear === undefined && o.maxYear === undefined) || inYears(r, o.minYear, o.maxYear))
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
