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
bun run cli taste import [export.zip]          # your Letterboxd export (default: newest zip in data/letterboxd/)
bun run cli ids sync [--airline X] [--limit N] # Wikidata: TMDB / Letterboxd / RT / Metacritic ids for matched films
bun run cli ratings sync [--source tmdb|letterboxd|rt|mc|all] [--airline X] [--limit N]
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
- **Ranking**: see [Ratings and taste](#ratings-and-taste).
- **Export**: one JSON per airline and month with `sourceId, title, year, runtime, directors, genres, rating,
  languages, categories, imdbId, imdbConfidence, tmdbId` (`imdbId` only for high/medium matches; `tmdbId` is a
  placeholder). No synopsis, poster or cast. `index.json` lists airlines, months, counts and fetch times.

## Ratings and taste

Picks are scored on a 10-point scale in two steps.

**1. Blend of public ratings.** IMDb 0.4, Letterboxd average 0.3 (stars x2), RT audience score 0.15 (/10) and
Metascore 0.15 (/10). IMDb is first pulled toward 6.5 by `min_votes`, and IMDb and Letterboxd weights scale with
log10 of their vote counts (0.2 at a handful of votes, full weight from 100k). A source with no score drops out
and the remaining weights re-normalise, so a film with IMDb alone scores exactly as before. `picks` prints the
sources behind each score.

**2. Your taste.** With a Letterboxd export imported, every rated film adds its deviation from your average
rating to each of its IMDb genres and directors. An affinity is the sum of those deviations divided by
(films + 3), so one film moves it a little and ten move it a lot. A pick gets the mean affinity of its genres plus
the mean affinity of its directors, and the strongest three show up as reasons ("you rate Denis Villeneuve +0.7
(3 films)"). Films you have watched or rated are left out. Watchlist films get +1.5 ("on your watchlist").
`taste.json` still applies on top as manual overrides: liked/disliked genres, `favourites`, `seen`, `min_rating`,
`min_votes`.

Setup:

1. **Letterboxd export**: letterboxd.com > Settings > Data > Export your data. Drop the zip into
   `data/letterboxd/` (git-ignored) and run `bun run cli taste import`. It reads `ratings.csv`, `watched.csv` and
   `watchlist.csv`, matches name + year to IMDb with the catalogue matcher, and replaces the previous import.
   It prints the films it could not match; those are ignored for taste.
2. **TMDB key** (optional): a free key from themoviedb.org > Settings > API, in `.env` as `TMDB_API_KEY=...`
   (a v3 key or a v4 read token both work). Without it `ratings sync` skips TMDB with a message. TMDB ratings
   and ids are stored but not yet part of the blend.
3. `bun run cli ids sync`, then `bun run cli ratings sync`. Ids come from Wikidata in batches of 200, once per
   film. Letterboxd, RT and Metacritic pages are fetched at 1 request per second per site and cached for 30 days
   in the `ratings` table (a page that 404s is cached as "no score"). RT and Metacritic are only tried where
   Wikidata has a slug. Network errors and 403/429/5xx are not cached; three in a row stop that source for the
   run. A first run over all ten airlines covers about 3,500 films, so about an hour per
   scraped source; later months only fetch new or expired films. Use `--limit N` to try it on a few.

Letterboxd's terms forbid automated access and RT and Metacritic have no public API: this is personal,
low-volume use only, and scraped scores are never exported to `public/data/`.

## Data source caveats

All sources are undocumented endpoints behind the airlines' own sites, several with Akamai bot management.
This is a low-volume tool: one fetch per airline and month per day at most, no retries, raw responses cached in
`data/raw/`. IMDb data is used under its non-commercial dataset licence.

## Publishing pipeline

`.github/workflows/monthly.yml` runs on the 1st and 15th of each month (some airlines switch cycles mid-month) and
on manual dispatch (optional `month` input). Steps: `bun run cli imdb sync` (downloads ~1.2 GB of IMDb `.gz`
files, free inbound traffic on GitHub-hosted runners, cached per month), `scripts/fetch-all.sh` (each airline in
turn with a 20 min timeout; a failure is recorded and the rest continue), `match`, `export`, then
`scripts/build-index.ts` rebuilds `public/data/index.json` from the files on disk so an airline that failed this
run keeps its last published month. Changed `public/data` is committed to main by the Actions bot with `[skip ci]`.
Fetch logs are uploaded as a workflow artifact. Expect 10-20 minutes per run.

`public/data/health.json` records each airline's last attempt: `status` (`ok`, `failed`, `timeout`), film count,
duration, error tail and `lastSuccess`. The Playwright install step only runs once `src/airlines/american.ts` exists.

Locally: `scripts/fetch-all.sh [YYYY-MM]` runs the same fetch loop.

## Leaderboard page

`public/index.html` is a static page (no build step) that reads `data/index.json` and each airline's latest file
in the browser: film count, IMDb match rate, how many of the ten most widely carried films each airline has, last
update and fetch health. The median and mean IMDb rating columns fill in once the export carries a rating field.
Preview with `bunx serve public` or `python3 -m http.server -d public`.

## Skills

- `.claude/skills/plane-movies/` is the local skill for this checkout. It drives the CLI and the SQLite database.
- `skill/plane-movies/` is the installable thin client for everyone else. It downloads one airline-month from
  the published dataset, caches it and prints a table for the model, so nobody needs to clone the pipeline. It
  runs on Bun, Node 22.6+ or Deno and works in Claude Code, Codex and Cursor. Install steps: `skill/README.md`.
  The dataset URL stays a placeholder (`DEFAULT_BASE_URL` in `skill/plane-movies/scripts/catalogue.ts`) until the
  repo is public.
