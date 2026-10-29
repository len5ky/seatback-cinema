# plane_movie

Which films are on the plane this month, and which of them are worth watching. It pulls each airline's monthly
movie catalogue, matches every film to IMDb using the public bulk datasets, ranks the result against your
`taste.json`, and exports an open monthly dataset to `public/data/`.

Airlines: Emirates, United, KLM, British Airways, Singapore Airlines, Lufthansa, Japan Airlines, Cathay Pacific,
Qantas and ANA (`bun run cli` lists the registered ids).

## Setup

Needs [Bun](https://bun.sh). Then `bun install` (dev types only; storage is the built-in `bun:sqlite`).

```bash
bun run cli fetch <airline|all> [--month 2026-11] [--refresh]  # monthly catalogue -> data/plane_movie.sqlite
bun run cli imdb sync [--force]    # download IMDb datasets (refreshed when >7 days old) and load them
bun run cli match [--airline X]    # match catalogue films to IMDb titles
bun run cli stats [--airline X]    # film count and match rate by confidence, per airline
bun run cli picks [--airline emirates] [--top 30] [--genre Thriller] [--min-rating 7] [--language English]
bun run cli search "toy story" [--airline X]   # which airlines carry it this month
bun run cli export [--month 2026-10]           # public/data/<airline>/<month>.json + public/data/index.json
```

`bun test` runs the unit tests (fixtures in `tests/fixtures/` are trimmed from real responses);
`bunx tsc --noEmit` typechecks.

## Sources

Every adapter implements `AirlineAdapter` (`src/airlines/types.ts`): `fetchMonth` caches each raw response under
`data/raw/<airline>/<month>/` and reuses it unless `--refresh`; `parse` turns the raw payload into deduped
`CatalogueFilm`s. Register new adapters in `src/airlines/index.ts`.

| airline | source | requests per fetch | month selector |
|---|---|---|---|
| Emirates | `emirates.com/service/exp/ice` JSON (taxonomy + movies), browser UA | 2 | `date=` |
| United | Gee Media Airtime API: guest session (public host-id) + Movies section tree | 2 | `flight_date=` |
| KLM | same Airtime client as United, KLM host-id and section | 2 | `flight_date=` |
| British Airways | `entertainment.ba.com/api` proxy: page layout + one call per Movies section, browser UA required | ~20 | none (current cycle only) |
| Singapore | KrisWorld `catalog-lookup?type=movies`, one GET | 1 | none (current cycle only) |
| Lufthansa | Spafax API (key from the portal's `/api/config`): A-Z bucket list + one detail call per film, 4 at a time | ~410 | `flightDate=` |
| JAL | same Spafax client, bucket 15, `flightSystem=NEXT-INT` | ~130 | `flightDate=` |
| Cathay Pacific | Anuvu AirTime (`afg.anuvu.cloud/api/v1`, same parser as United): section list + one call per section | ~38 | `flight_date=` |
| Qantas | `qantas.com/api/entertainment/metadata` POST per route (`large_international_seatback`) | 1 | none (current month only) |
| ANA | CineSend search (Origin/Referer required, month tag) + one detail call per title | ~235 | month tag |

The Airtime client (`src/airlines/platforms/geemedia.ts`) takes a configurable base URL so Anuvu's variant
(Cathay Pacific) can reuse it. Airlines without a month selector refuse to fetch any month but the current one.
For the current month the date sent is today, otherwise the 5th.

## How it works

- **IMDb**: `title.basics` (movie, tvMovie, tvSpecial, video), `title.akas` (English-market and UAE titles only),
  `title.ratings`, `title.crew` and `name.basics` (directors only) are streamed into SQLite. About 1.3M titles.
- **Matching**: an airline-provided IMDb id is trusted directly when IMDb knows it. Otherwise candidates share a
  normalised title (lowercase, no accents, punctuation or leading article, roman numerals as digits), with fallbacks
  that drop a possessive prefix ("Marvel's", "Dr. Seuss'"), use one side of a colon, either side of a trailing
  parenthesis ("Un Bel Giorno (A Good Day)", "(Audio Descriptive)"), or expand a truncated title ("The Desolation Of ...")
  by prefix. Matches found through a variant drop one confidence level. Remake suffixes such as
  "Superman (2025)" are split off the title and used as the year. Each candidate is scored on year (exact or ±1;
  a bigger gap blocks a high match), director surname (typo-tolerant) and runtime (within 3 min).
  Confidence: `high` (two confirming signals, no conflict), `medium` (one net signal), `low` (plausible but
  unconfirmed or conflicting, never ranked), `none` (no candidate). Emirates has no year field, so it leans on
  director and runtime; the other airlines all send a year.
- **Ranking**: Bayesian-weighted IMDb rating (pulled toward 6.5 by `min_votes`), +0.4 per liked genre (max 2),
  −1 per disliked genre, +0.5 when the director made one of your `favourites`; `seen` titles are skipped.
- **Export**: one JSON per airline and month with `sourceId, title, year, runtime, directors, genres, rating,
  languages, categories, imdbId, imdbConfidence, tmdbId` (`imdbId` only for high/medium matches; `tmdbId` is a
  placeholder). No synopsis, poster or cast. `index.json` lists airlines, months, counts and fetch times.

## Data source caveats

All sources are undocumented endpoints behind the airlines' own sites, several with Akamai bot management.
This is a low-volume tool: one fetch per airline and month per day at most, no retries, raw responses cached in
`data/raw/`. IMDb data is used under its non-commercial dataset licence.

A Claude Code skill (`.claude/skills/plane-movies/`) wraps the CLI for "what should I watch on my flight?".
