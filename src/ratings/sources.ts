/** Pure parsers for the rating sources. Every parser returns nulls instead of throwing on a page it does not understand. */

export interface Score { value: number | null; votes: number | null; extra?: Record<string, unknown> }

const num = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x.replace(/,/g, "")) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Every JSON-LD block on a page (Letterboxd wraps its block in CDATA comments). */
export function jsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    const body = m[1]!.replace(/\/\*\s*<!\[CDATA\[\s*\*\//, "").replace(/\/\*\s*\]\]>\s*\*\//, "").trim();
    try { out.push(JSON.parse(body) as Record<string, unknown>); } catch { /* not JSON: skip */ }
  }
  return out;
}

const aggregate = (blocks: Record<string, unknown>[]) =>
  blocks.map((b) => b.aggregateRating).find((a): a is Record<string, unknown> => !!a && typeof a === "object");

export interface LetterboxdPage { rating: Score; slug: string | null; tmdbId: number | null }

/** letterboxd.com/film/{slug}/: JSON-LD aggregateRating (0.5-5), canonical url, data-tmdb-id. New films have no rating yet. */
export function parseLetterboxd(html: string, finalUrl?: string): LetterboxdPage {
  const blocks = jsonLd(html);
  const agg = aggregate(blocks);
  const url = (blocks.find((b) => typeof b.url === "string")?.url as string | undefined) ?? finalUrl ?? "";
  const tmdb = num(html.match(/data-tmdb-id="(\d+)"/)?.[1]);
  return {
    rating: { value: num(agg?.ratingValue), votes: num(agg?.ratingCount), extra: agg ? { reviews: num(agg.reviewCount) } : undefined },
    slug: url.match(/letterboxd\.com\/film\/([^/]+)\//)?.[1] ?? null,
    tmdbId: tmdb && tmdb > 0 ? tmdb : null,
  };
}

export interface RtPage { critics: Score; audience: Score }

/** rottentomatoes.com/m/{slug}: the media-scorecard JSON (tomatometer and Popcornmeter, 0-100). */
export function parseRt(html: string): RtPage {
  const none = { critics: { value: null, votes: null }, audience: { value: null, votes: null } };
  const m = html.match(/<script[^>]*id="media-scorecard-json"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return none;
  let card: { criticsScore?: Record<string, unknown>; audienceScore?: Record<string, unknown> };
  try { card = JSON.parse(m[1]!) as typeof card; } catch { return none; }
  const c = card.criticsScore ?? {}, a = card.audienceScore ?? {};
  return {
    critics: { value: num(c.score), votes: num(c.reviewCount ?? c.ratingCount), extra: { certified: c.certified === true, average: num(c.averageRating) } },
    audience: { value: num(a.score), votes: num(a.reviewCount), extra: { banded: a.bandedRatingCount ?? null, average: num(a.averageRating) } },
  };
}

export interface McPage { critics: Score; user: Score }

/** metacritic.com/movie/{slug}/: Metascore from JSON-LD (0-100), user score from the score badge (0-10, "tbd" -> null). */
export function parseMc(html: string): McPage {
  const agg = aggregate(jsonLd(html));
  const metascore = num(agg?.ratingValue) ?? num(html.match(/aria-label="Metascore (\d+) out of 100"/)?.[1]);
  const user = num(html.match(/aria-label="User score ([\d.]+) out of 10" data-testid="global-score-value-wrapper"/)?.[1]);
  return {
    critics: { value: metascore, votes: num(agg?.reviewCount) ?? num(html.match(/Based on ([\d,]+) Critic Reviews/)?.[1]) },
    user: { value: user, votes: user === null ? null : num(html.match(/Based on ([\d,]+) User Ratings/)?.[1]) },
  };
}

export interface TmdbFind { tmdbId: number | null; rating: Score }

/** api.themoviedb.org/3/find/{tconst}?external_source=imdb_id: first movie result (vote_average 0-10). */
export function parseTmdbFind(json: unknown): TmdbFind {
  const r = (json as { movie_results?: Record<string, unknown>[] } | null)?.movie_results?.[0];
  if (!r) return { tmdbId: null, rating: { value: null, votes: null } };
  const votes = num(r.vote_count);
  // TMDB reports 0.0 for films nobody has voted on
  return { tmdbId: num(r.id), rating: { value: votes ? num(r.vote_average) : null, votes } };
}
