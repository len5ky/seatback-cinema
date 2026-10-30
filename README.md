# Seatback Cinema: inflight movie picker

Seatback Cinema is a GitHub dataset of the in-flight entertainment (IFE) catalogs of 11 airlines, Emirates ice,
United and British Airways among them, with every film matched to IMDb, plus an agent skill that ranks what's on
your flight by IMDb and Letterboxd ratings and your own taste. Ask Claude (in the app, or Claude Code), Codex or
Cursor "what should I watch on my Emirates flight?" and it answers from the films Emirates is actually showing that
month.

Also searched as: seatback-cinema, flightflix, skyflix, planeflix, inflight movie finder, airline movie ranker,
mile-high movies, cabin cinema, airline movie list ranked by IMDb.

## Airlines

October 2026, from `public/data/index.json`. "Films" counts each film once, even where the airline lists it once
per audio track. "IMDb id" is the share matched with high or medium confidence.

| airline | id | films | IMDb id |
|---|---|---:|---:|
| Emirates (ice) | `emirates` | 2,055 | 93.1% |
| Cathay Pacific | `cathay` | 1,551 | 91.6% |
| American Airlines | `american` | 682 | 95.3% |
| British Airways | `ba` | 658 | 95.1% |
| United Airlines | `united` | 508 | 96.3% |
| KLM | `klm` | 474 | 96.6% |
| Lufthansa | `lufthansa` | 405 | 97.0% |
| Singapore Airlines | `singapore` | 384 | 94.0% |
| Qantas | `qantas` | 257 | 87.2% |
| ANA | `ana` | 233 | 93.1% |
| Japan Airlines | `jal` | 124 | 88.7% |

7,331 films in all, 6,862 of them with an IMDb id.

## Use it in the Claude app (web and mobile)

This needs a Claude plan that allows custom connectors and skills. Set it up once on claude.ai in a browser:

1. **Add the connector.** Settings, Connectors, Add custom connector. Name it Seatback Cinema and paste
   `https://seatback.len5ky.com/mcp`. It asks for no login.
2. **Add the skill.** In a checkout of this repo, `scripts/package-web-skill.sh` builds
   `tmp/inflight-movie-picker-web.zip`. Upload it at Settings, Capabilities, Skills, as it is: the skill folder
   has to sit at the root of the zip.

After that, start a chat, on the web or in the mobile app, and say where you're flying:

> I'm on Emirates from Dubai to Sydney next Tuesday, about 14 hours. My IMDb is
> https://www.imdb.com/user/p.xxxxxxxx/ratings/ - what should I watch?

Claude reads your ratings, drops what you've seen, and answers with three films and a backup, each with its ratings,
a one-line synopsis, why it suits you and an IMDb link. It offers to save your taste as a token, so next time you
paste the token in place of the URL.

**Make your IMDb lists public first.** On IMDb go to Settings, Privacy and set your ratings and watchlist to
public. Your profile URL looks like `https://www.imdb.com/user/p.xxxxxxxx/ratings/`: open your ratings while signed
in and copy it from the address bar. The connector reads your ratings and scores from IMDb itself, so you just
paste the same URL next time. If IMDb refuses it, Claude asks for the CSV export from
https://www.imdb.com/list/ratings/export instead; attach the file to the chat. A Letterboxd profile
URL (`https://letterboxd.com/<username>/`) or Letterboxd's export zip works the same way, and with nothing at all
Claude asks for five films you loved and two you hated.

## Quick start: the skill

The skill is one folder, [`skill/inflight-movie-picker`](skill/inflight-movie-picker): a `SKILL.md` for the model
and a dependency-free script that downloads one airline-month and prints it as a table. It runs on Bun, Node 22.6+
or Deno.

```bash
git clone --depth 1 https://github.com/len5ky/seatback-cinema
cp -r seatback-cinema/skill/inflight-movie-picker ~/.claude/skills/              # Claude Code
mkdir -p ~/.codex/skills && cp -r seatback-cinema/skill/inflight-movie-picker ~/.codex/skills/   # Codex CLI
```

Start a new session and ask about your flight. For Cursor, copy the folder into your project and add a rule that
points at its `SKILL.md`; [`skill/README.md`](skill/README.md) has the rule file and the Codex fallback for
versions that don't load skills.

The skill asks for the airline, flight length, who's watching and the mood, then gives three films and a backup on
a long-haul flight, one or two under 110 minutes on a short one, and family titles only when kids are watching.
Each pick carries its IMDb link. If you have no export to hand it asks for five films you loved and two you hated.

### What a pick looks like

This is the project's own CLI on the October Emirates catalogue, with an IMDb export imported
(`bun run cli picks --airline emirates --min-year 2025 --top 3`):

```
Emirates 2026-10: top 3 picks (excluded: 58 low-confidence, 94 unmatched, 254 already watched)
taste: 938 ratings (mean 7.3/10), 938 watched, 103 on watchlist; taste.json as overrides

 1. Obsession (2025)  Horror, Thriller  109 min  IMDb 7.8 (414k)  LB 4.1  RT 94%  score 9.46
    A hopeless romantic's wish for true love spirals into a nightmare in this breakout horror hit.
    why: on your watchlist; you rate horror -0.5 (49 films); Curry Barker; English; https://www.imdb.com/title/tt37287335/ (high)
 2. Sawt Hind Rajab (2025)  Drama  84 min  IMDb 8.2 (22k)  LB 4.4  RT 100%  score 8.77
    An award-winning true story drama about a young girl's call for help and the race to reach her.
    why: Kaouther Ben Hania; Arabic; https://www.imdb.com/title/tt36943034/ (medium)
 3. I Swear (2025)  Drama, Comedy  120 min  IMDb 8.3 (72k)  LB 4.3  RT 98%  score 8.65
    A BAFTA®-winning biopic of pioneering Tourette syndrome activist John Davidson.
    why: Kirk Jones; English; https://www.imdb.com/title/tt31514146/ (high)
```

The skills present picks in the same card shape. In the Claude app the ratings come from the connector. The
coding-agent skill has no scraped ratings, so its numbers come from the model's knowledge of the film and, when
`TMDB_API_KEY` is set, from TMDB.

### Add your taste

An export beats any interview: films you've rated drop out, your watchlist floats up, and the model sees what you
loved and hated.

- **IMDb:** sign in at imdb.com, open your name menu (top right), then Your ratings. Click the three-dot menu above
  the list and choose Export. IMDb builds the CSV and lists it under Your exports, where you download it. Do the
  same from your Watchlist. Put the files in `data/imdb-ratings/` in the folder you start the agent from.
- **Letterboxd:** letterboxd.com, Settings, the Data tab, Export your data. Unzip the download anywhere and tell
  the agent where it is.
- **No export:** give the agent your public profile URL. The script reads it with `--imdb-url` or
  `--letterboxd-url` from your own machine. IMDb often refuses scripted requests, and the script then points you
  back to the export.

IMDb rows join on the IMDb id, so they never mismatch. Letterboxd exports carry no IMDb id, so those join on title
and year, which can miss a retitled film.

### Limits

- **Not covered:** Delta (its public pages show about 80 of roughly 300 films, title and poster only), Turkish (10
  highlights behind PerimeterX), Air France (no public catalogue) and Qatar (the catalogue sits behind Akamai and
  only loads in a real browser).
- **Twice a month.** The data refreshes on the 1st and 15th. BA, Singapore, Qantas and American only publish the
  current cycle, so next month's line-up for them appears once it starts.
- **One catalogue per airline.** Routes, aircraft and cabins differ. Qantas is the large international seatback
  set; a domestic 737 shows less.
- **Medium-confidence matches.** About 7% of IMDb ids rest on a single signal, often runtime alone. The skill
  flags them; check the link before you trust the rating. Regional-language films and concert specials match least
  often, and unmatched films are left out of rankings rather than guessed.

## For developers

### Dataset

```
public/data/index.json                 airlines, months, film counts, fetch times
public/data/<airline>/<YYYY-MM>.json   one catalogue
public/data/ids.json                   IMDb id -> TMDB, Letterboxd, Rotten Tomatoes, Metacritic ids
public/data/health.json                last fetch attempt per airline: status, film count, error tail
```

Each film has `sourceId, title, year, runtime, directors, genres, rating, languages, categories, imdbId,
imdbConfidence, tmdbId`. `rating` is the airline's age classification. `imdbId` is set only for high and medium
matches. Read it from `https://raw.githubusercontent.com/len5ky/seatback-cinema/main/public/data/index.json`.

Licence: the files in `public/data/` are released under CC0 1.0. They hold catalogue metadata only. No synopses,
posters, cast lists or ratings are redistributed; ratings stay in the local database and the data links out to IMDb
and TMDB instead. Titles and listings come from the airlines' public sites. IMDb ids come from IMDb's
non-commercial datasets, whose terms still apply to anything you build on them. `ids.json` comes from Wikidata,
also CC0.

### Running the pipeline

Needs [Bun](https://bun.sh); `bun install` pulls dev types only, storage is the built-in `bun:sqlite`.

```bash
bun run cli fetch <airline|all> [--month 2026-11] [--refresh]  # monthly catalogue -> data/plane_movie.sqlite
bun run cli imdb sync [--force]    # download IMDb datasets (~1.2 GB, refreshed when >7 days old) and load them
bun run cli match [--airline X]    # match catalogue films to IMDb titles
bun run cli stats [--airline X]    # film count and match rate by confidence
bun run cli picks [--airline emirates] [--top 30] [--genre Thriller] [--min-rating 7] [--language English] [--min-year 2020] [--max-year 2025] [--year 2025] [--month YYYY-MM] [--full]
bun run cli search "toy story" [--airline X]   # which airlines carry it this month
bun run cli export [--month 2026-10] [--airline X]  # public/data/<airline>/<month>.json, ids.json, index.json
bun run cli taste import [file ...]            # IMDb CSVs and/or a Letterboxd zip (default: data/imdb-ratings/, data/letterboxd/)
bun run cli ids sync [--airline X] [--limit N] # Wikidata crosswalk to TMDB / Letterboxd / RT / Metacritic ids
bun run cli ratings sync [--source tmdb|letterboxd|rt|mc|all] [--airline X] [--limit N]
bun run serve                                  # public/ on http://localhost:4173 (SEATBACK_PORT to change)
```

`bun run cli` with no arguments prints this list and the registered airline ids. `bun test` runs the unit tests
(fixtures in `tests/fixtures/` are real responses with synopses, cast and image URLs stripped) and
`bun run typecheck` typechecks.

`bun run serve` also lets you try the skill on a fresh `export` before anything is pushed:
`SEATBACK_DATASET_URL=http://localhost:4173` or `--base public` points the skill's script at it.

`public/index.html` is a static leaderboard (film counts, match rate, fetch health per airline) that reads the same
files; `bun run serve` and open http://localhost:4173.

### Ratings and taste in the CLI

Picks score on a 10-point scale. The public part blends IMDb (0.4), Letterboxd average (0.3, stars x2), RT audience
(0.15) and Metascore (0.15). IMDb is pulled toward 6.5 by `min_votes`, IMDb and Letterboxd weights scale with
log10 of their vote counts, and a missing source drops out with the rest re-normalised.

Taste comes from `bun run cli taste import`. Every film you rated adds its deviation from your mean rating to its
genres and directors; an affinity is that sum divided by (films + 3), so one film moves it a little and ten move it
a lot. Watched films are excluded, watchlist films get +1.5, and the strongest affinities show up as reasons ("you
rate horror -0.5 (49 films)"). `taste.json` stays as manual overrides: liked and disliked genres, `favourites`,
`seen`, `min_rating`, `min_votes`.

Letterboxd, RT and Metacritic are scraped at one request per second per site with a 30-day cache, for personal use
only: Letterboxd's terms forbid automated access, and none of those scores is ever exported. TMDB needs
`TMDB_API_KEY` in `.env` (free from themoviedb.org, Settings, API).

### Publishing

`.github/workflows/monthly.yml` runs at 05:17 UTC on the 1st and 15th, and on manual dispatch with an optional
`month`. It loads IMDb, runs `scripts/fetch-all.sh` (each airline with a 20-minute timeout; one failure doesn't stop
the rest), then `match`, `ids sync` and `export`. `scripts/build-index.ts` rebuilds `index.json` from the files on
disk, so an airline that failed keeps its last good month. The Actions bot commits `public/data` to main with
`[skip ci]` through `scripts/push-dataset.sh`. A run takes 10 to 20 minutes, mostly Lufthansa, JAL and ANA, which
make one request per film.

American answers HTTP 429 to GitHub runner IPs, so CI skips it. `scripts/american-local.sh` runs from a crontab on
the maintainer's machine at 03:00 UTC on the same days: it fetches American, matches, exports that airline and
pushes from its own worktree (`tmp/american-publish`), rebasing over CI's commit if both land at once. `--dry-run`
stops before the push.

### Adding an airline

Every adapter implements `AirlineAdapter` from `src/airlines/types.ts`:

```ts
fetchMonth(month: string, opts: { cacheDir: string; refresh?: boolean }): Promise<unknown>; // cache raw responses under cacheDir/<id>/<month>/
parse(raw: unknown): CatalogueFilm[];                                                         // pure, deduped
```

`fetchMonth` saves every HTTP response and reuses it unless `--refresh`; an airline with no month selector refuses
any month but the current one. `parse` is pure and gets a unit test against a saved response in `tests/fixtures/`
with synopses, cast and image URLs stripped. Fill `year` and `directors` whenever the source has them: the matcher
leans on both. Register the adapter in `src/airlines/index.ts`. Keep it low-volume: one fetch per airline-month per
day, no retry loops. Gee Media Airtime (United, KLM, Cathay Pacific) and Spafax (Lufthansa, JAL) already have shared
clients in `src/airlines/platforms/`, so an airline on either platform is mostly configuration.

| airline | source | requests per fetch |
|---|---|---|
| Emirates | `emirates.com/service/exp/ice` JSON | 2 |
| United, KLM | Gee Media Airtime API | 2 |
| British Airways | `entertainment.ba.com/api` proxy (Akamai, browser UA) | ~20 |
| Singapore | KrisWorld `catalog-lookup` | 1 |
| Lufthansa, JAL | Spafax API, one detail call per film | ~410, ~130 |
| Cathay Pacific | Anuvu AirTime (Airtime client, other base URL) | ~38 |
| Qantas | `qantas.com/api/entertainment/metadata` | 1 |
| ANA | CineSend search plus one detail call per title | ~235 |
| American | `entertainment.aa.com` pages in headless Chromium (plain HTTP is blocked on TLS fingerprint) | 25 pages |

### The matcher

IMDb's `title.basics`, `title.akas`, `title.ratings`, `title.crew` and `name.basics` go into SQLite, about 1.3
million titles. An airline that sends an IMDb id (American does) is trusted when IMDb knows the id. Everything else
is matched on a normalised title (lowercase, no accents or punctuation, no leading article, roman numerals as
digits), with fallbacks for "Marvel's" prefixes, either side of a colon or a trailing parenthesis, and titles cut
off with "...". Each candidate is scored on year (exact or one off), director surname (typo-tolerant) and runtime
(within 3 minutes). Two agreeing signals and no conflict make a `high` match, one makes `medium`, and anything
weaker is `low` or `none` and never ranked. Emirates sends no year on 72% of its rows, so it leans on director and
runtime.

## Skills in this repo

- `skill/inflight-movie-picker/` is the public skill described above. It reads the published dataset, so nobody
  needs the pipeline.
- `skill/inflight-movie-picker-web/` is the Claude app version: no script, it calls the connector at
  `https://seatback.len5ky.com/mcp`. `scripts/package-web-skill.sh` zips it for upload.
- `.claude/skills/inflight-movie-picker/` is the maintainer's skill for a checkout: it drives the CLI and the local
  SQLite database, scraped ratings included.
