# plane_movie

Which films are on the plane this month, and which of them are worth watching. v1 covers Emirates ice:
it pulls the monthly movie catalogue, matches each film to IMDb using the public bulk datasets, and ranks
the result against your `taste.json`.

## Setup

Needs [Bun](https://bun.sh). Then `bun install` (dev types only; storage is the built-in `bun:sqlite`).

```bash
bun run cli fetch emirates [--month 2026-11] [--refresh]   # monthly catalogue -> data/plane_movie.sqlite
bun run cli imdb sync [--force]    # download IMDb datasets (refreshed when >7 days old) and load them
bun run cli match                  # match catalogue films to IMDb titles
bun run cli stats                  # film count, match rate by confidence (all / English / non-English)
bun run cli picks [--top 30] [--genre Thriller] [--min-rating 7] [--language English]
bun run cli search "toy story"
```

`bun test` runs the unit tests (fixtures in `tests/fixtures/` are trimmed from a real response);
`bunx tsc --noEmit` typechecks.

## How it works

- **Catalogue**: `GET https://www.emirates.com/service/exp/ice?date=YYYY-MM-DD&group=movies` returns the whole
  month (~9,000 rows, one per film and category). Rows are deduped on `trackList` (~2,150 films), placeholder
  channels are dropped, and `(1985)` year suffixes and `Telugu - ` style language prefixes are split off the title.
  The same URL without `group` gives category names.
- **IMDb**: `title.basics` (movie, tvMovie, tvSpecial, video), `title.akas` (English-market and UAE titles only),
  `title.ratings`, `title.crew` and `name.basics` (directors only) are streamed into SQLite. About 920k titles.
- **Matching**: candidates share a normalised title (lowercase, no accents, punctuation or leading article,
  roman numerals as digits), with fallbacks that drop a possessive prefix ("Marvel's") or use one side of a colon.
  Each candidate is scored on runtime (within 3 min), director surname (typo-tolerant) and year when the title has one.
  Confidence: `high` (two confirming signals, no conflict), `medium` (one net signal), `low` (plausible but
  unconfirmed or conflicting, never ranked), `none` (no candidate).
- **Ranking**: Bayesian-weighted IMDb rating (pulled toward 6.5 by `min_votes`), +0.4 per liked genre (max 2),
  −1 per disliked genre, +0.5 when the director made one of your `favourites`; `seen` titles are skipped.

## Data source caveats

The Emirates endpoint is undocumented and sits behind Akamai bot management. This is a personal tool: one fetch
per month per day at most, raw responses are cached in `data/raw/`, and nothing is redistributed. The response has
no release year or IMDb id, so matching is heuristic and regional-language films match less often. IMDb data is
used under its non-commercial dataset licence.

A Claude Code skill (`.claude/skills/plane-movies/`) wraps the CLI for "what should I watch on my flight?".
