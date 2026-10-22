---
name: plane-movies
description: Recommend what to watch on a flight from the airline's in-flight catalogue, ranked by IMDb rating and the user's taste. Use when the user asks what to watch on their flight or plane, what movies are on Emirates / ice this month, for plane movie picks, or whether a specific film is available on Emirates.
---

# Plane movies

Local catalogue of Emirates ice movies (monthly), matched to IMDb and ranked with `taste.json`.
Run everything from the project root `/home/lensky/Dev/plane_movie` with bun (`~/.bun/bin` on PATH).

## Answering "what should I watch on my flight?"

1. Find out the flight month if it matters (catalogue changes monthly; current and next month are available).
2. Make sure data is fresh, then rank:
   ```bash
   bun run cli stats                      # is there a snapshot for this month? match rate?
   bun run cli fetch emirates [--month YYYY-MM]   # only if the month is missing (cached per month; one real fetch)
   bun run cli match                      # after any fetch or imdb sync
   bun run cli picks --top 15 [--genre Thriller] [--min-rating 7] [--language English]
   ```
3. Present 5-10 picks with one line each: why it fits (genre, rating), runtime (fits the flight?), IMDb link.
4. For "is X on the plane?": `bun run cli search "<title>"`.

`bun run cli imdb sync` reloads IMDb (downloads ~1.2 GB if files are older than 7 days, ~3 min load). Only run it when `stats` shows 0 IMDb titles or the user asks for fresher ratings.

## Taste

Edit `taste.json`: `liked_genres`, `disliked_genres` (IMDb names such as Sci-Fi, Thriller, Horror), `min_rating`, `min_votes`, `seen` (titles or tt ids, excluded from picks), `favourites` (titles; their directors get a small boost). When the user says they have seen a film, add it to `seen`.

## Caveats to tell the user when relevant

- The Emirates endpoint is undocumented: personal, low-volume use. Never fetch the same month more than once a day (raw JSON is cached under `data/raw/`; `--refresh` forces a refetch).
- The catalogue has no year or IMDb id. Matches are graded high/medium/low/none from title, runtime, director and (when present) year. Picks use only high and medium; low-confidence and unmatched films (mostly regional-language films and concert specials) are excluded, so say so if the user wants something niche.
- Catalogue may differ slightly by country (only the global English catalogue is fetched).
