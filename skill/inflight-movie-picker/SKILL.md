---
name: inflight-movie-picker
description: Recommend what to watch on a flight from the airline's actual in-flight film catalogue for that month. Use when someone asks what to watch on their flight or plane, what movies are on Emirates, United, KLM, British Airways, Singapore Airlines, Lufthansa, JAL, Cathay Pacific, Qantas, ANA or American Airlines this month, wants plane movie picks for themselves or their kids, or asks whether a specific film is on a given airline. Also triggers on "inflight movie picker", "seatback cinema", "what's on the plane" and "in-flight entertainment" questions.
---

# Inflight movie picker

An open dataset lists every film in each airline's seatback catalogue, month by month, with an IMDb id for
~93% of them. `scripts/catalogue.ts` (next to this file) downloads one catalogue, caches it and prints a
compact table. Your job is to pick from that table. Never recommend a film that is not in it.

## 1. Get the catalogue

Run from this skill's directory. Use whichever runtime is installed:

```bash
bun scripts/catalogue.ts --list                                   # airline ids and available months
bun scripts/catalogue.ts united                                   # latest month
bun scripts/catalogue.ts united 2026-11 --genre thriller --max-runtime 120
bun scripts/catalogue.ts emirates --search "toy story"           # "is X on the plane?"
node --experimental-strip-types scripts/catalogue.ts klm         # Node 22.6+ (flag optional from 23.6)
deno run -A scripts/catalogue.ts ba                               # Deno
```

Options: `--search <text>`, `--genre <name>`, `--max-runtime <min>`, `--matched` (only films with an IMDb id),
`--tmdb` (adds TMDB score and vote count; needs `TMDB_API_KEY`), `--json`, `--refresh`.
Output is `title | year | min | genres | imdb`. Large catalogues (Emirates ~2,000, Cathay ~1,500) are long:
filter by genre or runtime, or read the whole list once and shortlist from it.

Airline ids: `emirates`, `united`, `klm`, `ba`, `singapore`, `lufthansa`, `jal`, `cathay`, `qantas`, `ana`, `american`.
Delta, Turkish and Air France do not publish their catalogues, so say you can't see theirs. Don't guess.

Month: catalogues change monthly, usually on the 1st (some mid-month). Use the month of the flight. If that
month isn't published yet, use the latest one and say the line-up may change.

## 2. Find out what they like (30 seconds, skip what you already know)

If the person has shared a Letterboxd export, ratings or a watch history, use that. Don't ask again. Otherwise
ask at most three short questions in one message, then recommend straight away:

1. Two or three films they loved recently (better than asking for genres).
2. Anything they never want: horror, subtitles, sad endings, musicals, superhero fatigue.
3. The flight: route or length, and who is watching (alone, partner, kids and ages).

If they just want picks and skip the questions, recommend a balanced list and invite a correction.
Note the films they say they have seen and don't recommend those.

## 3. Choose

Fit the picks to the flight:
- **Long-haul (6h+)**: build a two-to-four film running order. Lead with the one they most want before the
  meal service and sleep. Put long epics (150+ min) early and lighter or familiar films late, when they're tired.
  Total runtime should leave room for sleep on overnight flights.
- **Short-haul (under 3h)**: one film that fits the gate-to-gate time, minus about 40 minutes for taxi, climb
  and descent. Use `--max-runtime`. Offer a shorter backup.
- **Kids mode** (anyone under 13 watching): use the airline's own classification and genres (Animation, Family),
  check the content against your own knowledge before suggesting anything rated above PG, and say why each pick
  suits the age. Prefer films under ~100 minutes for young children.

Quality: the dataset has no review scores. Rank by what you know of each film's reception, and back it with
`--tmdb` scores when a key is set. Don't invent numbers. Prefer new releases (current and previous year)
when they're good, because those are the films people can't easily watch at home.

## 4. Answer

Give 5-8 picks (fewer for short-haul), each on one line: title (year), runtime, why it fits *this person*, and
the IMDb link built from the id: `https://www.imdb.com/title/<imdbId>/`. Every pick must come from the table.
Cite the IMDb id so the person can check it. If a film has no IMDb id (`-`), say it's unverified.

Mention once, briefly, when relevant: catalogues vary by route, aircraft and cabin (Qantas data is the large
international seatback set), and the airline may swap titles mid-month.

## Setup and troubleshooting

- `DATASET_BASE_URL` overrides where the data comes from (default in the script). Downloads are cached under
  `~/.cache/inflight-movie-picker/` (`$XDG_CACHE_HOME` respected). The index is refreshed every 12h, finished months never.
- `HTTP 404` on the index usually means the base URL is wrong. A missing month means it isn't published yet.
- `TMDB_API_KEY` is optional (free at themoviedb.org > Settings > API; v3 key or v4 read token). The first
  `--tmdb` run on a big catalogue makes one request per film; later runs come from the cache.
