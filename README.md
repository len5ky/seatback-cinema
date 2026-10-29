# plane_movie

Which films are on the plane this month, and which of them are worth watching. It pulls each airline's monthly
movie catalogue, matches every film to IMDb using the public bulk datasets, ranks the result against your
`taste.json`, and exports an open monthly dataset to `public/data/`.

Airlines: Emirates, United, KLM, British Airways, Singapore Airlines, Lufthansa, Japan Airlines, Cathay Pacific,
Qantas, ANA and American (`bun run cli` lists the registered ids).

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

`bun test` runs the unit tests (the fixtures in `tests/fixtures/` are real responses with synopses, cast names and
image URLs stripped), and `bunx tsc --noEmit` typechecks.

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
| American | `entertainment.aa.com` Next.js RSC pages fetched inside headless Chromium (plain HTTP is blocked on TLS fingerprint) | 25 pages | none (current cycle only) |

The Airtime client (`src/airlines/platforms/geemedia.ts`) takes a configurable base URL so Anuvu's variant
(Cathay Pacific) can reuse it. Airlines without a month selector refuse to fetch any month but the current one.
For the current month the date sent is today, otherwise the 5th.

## Coverage (October 2026)

Numbers from `bun run cli stats` and `bun run cli export` on 2026-10-29. "Rows" is what the airline lists; "published"
is after folding repeat listings of the same film (Emirates lists a film once per audio track list). "IMDb id" is the
share of rows matched with high or medium confidence, the only ones that get an `imdbId` in the export. The grade
rates the source itself: A is a structured JSON API with year and director, B needs a browser or has gaps.

| airline | rows | published | IMDb id | source | grade |
|---|---:|---:|---:|---|---|
| Emirates | 2,158 | 2,055 | 93.0% | own JSON; year on only 28% of rows | A |
| Cathay Pacific | 1,552 | 1,551 | 92.1% | Anuvu AirTime API | A- |
| American | 682 | 682 | 95.3% | entertainment.aa.com via headless Chromium; airline supplies IMDb ids | B |
| British Airways | 658 | 658 | 95.7% | entertainment.ba.com proxy (Akamai) | A- |
| United | 508 | 508 | 95.9% | Gee Media Airtime API | A |
| KLM | 474 | 474 | 97.0% | Gee Media Airtime API | A- |
| Lufthansa | 405 | 405 | 97.0% | Spafax API | A |
| Singapore | 384 | 384 | 94.5% | KrisWorld JSON | A |
| Qantas | 259 | 257 | 86.5% | Qantas entertainment API | A |
| ANA | 233 | 233 | 92.7% | CineSend API | A- |
| JAL | 124 | 124 | 88.7% | Spafax API | A |

Non-English films match less often (78-93% against 86-100% for English ones); the rest are flagged low or unmatched
and left out of rankings, never guessed.

Not covered: Delta (its public pages show about 80 of roughly 300 films, title and poster only), Turkish (10
highlights behind PerimeterX), Air France (no public catalogue) and Qatar (the catalogue sits behind Akamai and
only loads in a real browser profile; not built yet).

### Data licence

`public/data/` holds catalogue metadata only: title, year, runtime, directors, genres, age rating, audio
languages, the airline's own categories and our IMDb/TMDB ids. No synopses, posters, cast lists or ratings are
published; ratings stay in the local database and links go out to IMDb and TMDB. Our files in `public/data/` are
released under CC0 1.0. The titles and listings come from the airlines' public sites, and IMDb ids come from IMDb's
non-commercial datasets, whose terms still apply to anything you build from them. `ids.json` (IMDb id to TMDB,
Letterboxd, Rotten Tomatoes and Metacritic ids) is copied from Wikidata, which is CC0 too.

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
  languages, categories, imdbId, imdbConfidence, tmdbId` (`imdbId` only for high/medium matches; `tmdbId` comes
  from Wikidata via `ids sync`). No synopsis, poster or cast. `index.json` lists airlines, months, counts and fetch
  times. `ids.json` maps `{tconst: {tmdb, letterboxd, rt, mc}}`; `ids sync` loads it before asking Wikidata, so a
  fresh database (CI) only queries films that are not in it yet.

## Ratings and taste

Picks are scored on a 10-point scale in two steps.

**1. Blend of public ratings.** IMDb 0.4, Letterboxd average 0.3 (stars x2), RT audience score 0.15 (/10) and
Metascore 0.15 (/10). IMDb is first pulled toward 6.5 by `min_votes`, and IMDb and Letterboxd weights scale with
log10 of their vote counts (0.2 at a handful of votes, full weight from 100k). A source with no score drops out
and the remaining weights re-normalise, so a film with only an IMDb rating scores exactly as it did before the blend. `picks` prints the
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
   run. A first run over all eleven airlines covers about 3,500 films, so about an hour per
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
turn with a 20 min timeout; a failure is recorded and the rest continue), `match`, `ids sync`, `export`, then
`scripts/build-index.ts` rebuilds `public/data/index.json` from the files on disk so an airline that failed this
run keeps its last published month. Changed `public/data` is committed to main by the Actions bot with `[skip ci]`.
Fetch logs are uploaded as a workflow artifact. Expect 10-20 minutes per run.

`public/data/health.json` records each airline's last attempt: `status` (`ok`, `failed`, `timeout`), film count,
duration, error tail and `lastSuccess`.

American answers HTTP 429 to GitHub runner IPs, so CI skips it and keeps whatever entry the local job last wrote
(`status: "skipped"`, `reason: "fetched locally"` only if there is none; the leaderboard shows that as a neutral badge,
not a failure).

`scripts/american-local.sh` runs from a user crontab on the dev machine at 03:00 UTC on the 1st and 15th: it fetches
American with `--refresh`, matches, exports that airline only, rebuilds `index.json` and pushes the American file,
`index.json`, `ids.json` and `health.json` to main with `[skip ci]`, rebasing right before the push and regenerating
its files on top of CI's if they conflict. `--dry-run` reuses cached raw files, works on copies under
`tmp/american-dry/` (database snapshot, raw cache, `public/data`) and stops before the commit.

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
  It reads `https://raw.githubusercontent.com/len5ky/seatback/main/public` (override with `DATASET_BASE_URL`).
