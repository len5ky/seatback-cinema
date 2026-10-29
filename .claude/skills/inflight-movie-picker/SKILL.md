---
name: inflight-movie-picker
description: Recommend what to watch on a flight from the airline's in-flight catalogue, ranked by IMDb rating and the user's taste. Use when the user asks what to watch on their flight or plane, what movies are on Emirates / ice, United, KLM, British Airways, Singapore Airlines, Lufthansa, JAL, Cathay Pacific, Qantas, ANA or American Airlines this month, for plane movie picks, or whether a specific film is available on a given airline. Also triggers on "inflight movie picker", "seatback cinema", "what's on the plane" and "in-flight entertainment" questions.
---

# Inflight movie picker

Local monthly catalogues for Emirates, United, KLM, British Airways (`ba`), Singapore Airlines (`singapore`),
Lufthansa, Japan Airlines (`jal`), Cathay Pacific (`cathay`), Qantas, ANA and American (`american`),
matched to IMDb and ranked by a blend of IMDb, Letterboxd, RT and Metacritic plus the user's Letterboxd taste and `taste.json`. Run everything from the project root `/home/lensky/Dev/plane_movie`
with bun (`~/.bun/bin` on PATH). `bun run cli` with no arguments lists the registered airline ids.

## Answering "what should I watch on my flight?"

1. Find out the airline and, if it matters, the flight month (catalogues change monthly).
2. Make sure data is fresh, then rank:
   ```bash
   bun run cli stats --airline united                  # snapshot for this month? match rate?
   bun run cli fetch united [--month YYYY-MM]          # only if the month is missing (cached per month)
   bun run cli match --airline united                  # after any fetch or imdb sync
   bun run cli picks --airline united --top 15 [--genre Thriller] [--min-rating 7] [--language English]
   ```
   `picks` defaults to Emirates when `--airline` is omitted.
3. Present 5-10 picks with one line each: why it fits (genre, rating), runtime (fits the flight?), IMDb link.
4. For "is X on the plane?": `bun run cli search "<title>"` searches every fetched airline (or `--airline X`).

`bun run cli imdb sync` reloads IMDb (downloads ~1.2 GB if files are older than 7 days, ~3 min load). Only run it
when `stats` shows 0 IMDb titles or the user asks for fresher ratings.

## Taste and ratings

The best taste signal is the user's Letterboxd export. If `picks` prints "taste: taste.json only", offer this:

1. Letterboxd > Settings > Data > Export your data; drop the zip into `data/letterboxd/`.
2. `bun run cli taste import` (re-run after each new export; it replaces the previous import and lists unmatched
   films). Watched and rated films are then excluded, watchlist films are boosted, and genre/director affinities
   learned from the ratings show up as "you rate X +0.7 (3 films)" reasons.

Extra rating sources (optional, slow the first time): `bun run cli ids sync`, then
`bun run cli ratings sync [--source letterboxd|rt|mc|tmdb] [--airline X]`. Scraped sites go at 1 request/s with a
30-day cache, so a first full run is about an hour per source; scope it with `--airline` or `--limit N`. TMDB needs
`TMDB_API_KEY` in `.env` (free key from themoviedb.org > Settings > API) and is skipped otherwise. Picks then blend
IMDb, Letterboxd, RT audience and Metacritic; each pick lists its `sources:`.

`taste.json` stays as manual overrides: `liked_genres`, `disliked_genres` (IMDb names such as Sci-Fi, Thriller,
Horror), `min_rating`, `min_votes`, `seen` (titles or tt ids, excluded from picks), `favourites` (titles; their
directors get a small boost). When the user says they have seen a film, add it to `seen`.

## Caveats to tell the user when relevant

- All sources are undocumented airline endpoints: personal, low-volume use. Never fetch the same airline-month more
  than once a day (raw responses are cached under `data/raw/`; `--refresh` forces a refetch). Never loop retries,
  especially against BA (Akamai).
- BA, Singapore and Qantas only publish the current cycle, so next month cannot be fetched for them until it starts.
  The others accept a future `--month`. Lufthansa, JAL and ANA make one detail call per film (~130-410 requests,
  cached), so do not refetch them casually.
- Qantas is the large international seatback catalogue; domestic and smaller aircraft differ.
- Matches are graded high/medium/low/none from title, year, director and runtime. Picks use only high and medium.
  Emirates has no year field, so its regional-language films and concert specials match least often.
- A catalogue can differ by route, aircraft or country; only the airline's public web catalogue is fetched.
