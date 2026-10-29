---
name: plane-movies
description: Recommend what to watch on a flight from the airline's in-flight catalogue, ranked by IMDb rating and the user's taste. Use when the user asks what to watch on their flight or plane, what movies are on Emirates / ice, United, KLM, British Airways or Singapore Airlines this month, for plane movie picks, or whether a specific film is available on a given airline.
---

# Plane movies

Local monthly catalogues for Emirates, United, KLM, British Airways (`ba`) and Singapore Airlines (`singapore`),
matched to IMDb and ranked with `taste.json`. Run everything from the project root `/home/lensky/Dev/plane_movie`
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

## Taste

Edit `taste.json`: `liked_genres`, `disliked_genres` (IMDb names such as Sci-Fi, Thriller, Horror), `min_rating`,
`min_votes`, `seen` (titles or tt ids, excluded from picks), `favourites` (titles; their directors get a small
boost). When the user says they have seen a film, add it to `seen`.

## Caveats to tell the user when relevant

- All sources are undocumented airline endpoints: personal, low-volume use. Never fetch the same airline-month more
  than once a day (raw responses are cached under `data/raw/`; `--refresh` forces a refetch). Never loop retries,
  especially against BA (Akamai).
- BA and Singapore only publish the current cycle, so next month cannot be fetched for them until it starts.
  Emirates, United and KLM accept a future `--month`.
- Matches are graded high/medium/low/none from title, year, director and runtime. Picks use only high and medium.
  Emirates has no year field, so its regional-language films and concert specials match least often.
- A catalogue can differ by route, aircraft or country; only the airline's public web catalogue is fetched.
