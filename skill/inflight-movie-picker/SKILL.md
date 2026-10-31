---
name: inflight-movie-picker
description: Recommend what to watch on a flight from the airline's actual in-flight film catalogue for that month, ranked against the person's taste. Use when someone asks what to watch on their flight or plane, what movies are on Emirates (ice), United, KLM, British Airways, Singapore Airlines, Lufthansa, JAL, Cathay Pacific, Qantas, ANA or American Airlines this month, wants plane movie picks for themselves or their kids, or asks whether a specific film is on a given airline. Also triggers on "inflight movie picker", "seatback cinema", "what's on the plane" and "in-flight entertainment" questions.
---

# Inflight movie picker

Seatback Cinema publishes every film in eleven airlines' seatback catalogues, month by month, and matches about
94% of them to an IMDb id. `scripts/catalogue.ts` in this skill's folder downloads one airline-month, caches it
and prints it as a table. You pick from that table and nothing else: if a film isn't in it, it isn't on the plane
as far as you know.

Use it when someone asks what to watch on a flight, whether a film is on an airline, or what an airline is showing
this month. Don't use it for streaming or cinema recommendations.

## 1. Get the facts about the flight

You need four things. Take whatever the person already said and ask for the rest in one short message; if they
just want picks, guess sensibly and say what you assumed.

- **Airline**, and the month if the flight is in a later month than today (catalogues change around the 1st).
- **Flight length.** Long-haul is 6 hours or more, short-haul under 3.
- **Who is watching.** Alone, with a partner, or with children (ages matter).
- **Mood.** Something easy, something to cry at, a film they've been meaning to see.

Airline ids: `emirates`, `united`, `klm`, `ba`, `singapore`, `lufthansa`, `jal`, `cathay`, `qantas`, `ana`,
`american`. Delta, Turkish, Air France and Qatar aren't covered (they don't publish a full catalogue, or hide it
behind bot protection). Say so plainly and offer general picks they can check against the seatback screen.

## 2. Read the catalogue

Run the script by its full path from the person's working directory, so relative paths to their exports work.
Any of Bun, Node 22.6+ or Deno will run it:

```bash
S=<this skill's folder>/scripts/catalogue.ts
bun $S --list                                     # airline ids and published months
bun $S emirates                                   # latest month
bun $S united 2026-11 --max-runtime 110           # a given month, films up to 110 minutes
bun $S united --family --max-runtime 100         # kids: family, kids and animation genres
bun $S ba --search "wicked"                       # "is X on the plane?"
node --experimental-strip-types $S klm            # Node; deno run -A $S klm for Deno
```

The table is `title | year | min | genres | cert | imdb`. `cert` is the airline's own age rating (PG13, 12, M,
TV-G and so on; formats vary by airline). `imdb` is the matched IMDb id; `(medium)` after it means the match rests
on one signal, such as runtime alone, so treat it as probably right. `-` means no confident match: the film is on
the plane, but you can't vouch for which film it is.

Other options: `--matched` (only films with an IMDb id), `--tmdb` (adds TMDB score and vote count; needs
`TMDB_API_KEY`), `--taste <path>`, `--imdb-url <url>` and `--letterboxd-url <url>` (below), `--profile-token <token>`,
`--save-profile`, `--json`, `--refresh`. Emirates lists about 2,000 films and Cathay
about 1,500, so filter by genre or runtime, or read the full list once and shortlist from it.

If the flight month isn't published yet, use the latest month and tell the person the line-up may change.

## 3. Learn their taste

Look in the working directory first. An IMDb export (`data/imdb-ratings/*.csv`, or any CSV with a `Const` column)
or an unzipped Letterboxd export (`ratings.csv`, `watched.csv`, `watchlist.csv`) is better than any interview.
Pass the file or folder to the script:

```bash
bun $S emirates --taste data/imdb-ratings
bun $S united --taste ~/Downloads/letterboxd-export     # unzip the Letterboxd zip first
```

No export, but a public IMDb or Letterboxd profile? Pass the URL to the script. It reads the profile from this
machine and caches it for 24 hours. For IMDb it asks IMDb's API first, the same calls imdb.com makes in a browser:
a 941-rating profile with its scores and watchlist took 7 requests in October 2026. If the API turns it down, it
reads the profile pages instead, 250 titles a page. Letterboxd is pages only, 72 films a page, then the watchlist.
Either way it stops at 50 pages:

```bash
bun $S emirates --imdb-url https://www.imdb.com/user/p.xxxxxxxx/ratings/
bun $S ba --letterboxd-url https://letterboxd.com/<username>/
```

The IMDb ratings and watchlist have to be public (IMDb, Settings, Privacy). IMDb blocks scripted requests from a
lot of networks with an empty HTTP 202 or a 429; Letterboxd sometimes answers 403. When that happens the script prints the
export route in two lines and exits 1; if it stops partway (a block after page 1), it keeps the pages it read and
adds a `note:` line saying so. For IMDb, if the Seatback Cinema connector is added in this session (its
tools are `list_airlines`, `picks`, `profile_from_imdb_url` and so on), try `profile_from_imdb_url` with the URL
once, and pass `profile: { imdb_user }` from its answer to `picks`. Don't count on it: IMDb refuses the
connector's cloud server more often than not (HTTP 429). Otherwise pass the export route on: the CSV export from
https://www.imdb.com/list/ratings/export, or Letterboxd's Settings, Data, Export your data, then `--taste`. Letterboxd pages carry no IMDb id, so those films join
through the dataset's Letterboxd links where it has them and on title and year otherwise.

To use the profile in the Claude app, where IMDb blocks the fetch, add `--save-profile`: the script stores the profile on
the Seatback server and ends with a line to paste into the app, "My Seatback Cinema profile token is ...". If they
give you a token ("my profile token is ..."), pass it as `--profile-token <token>` in place of the other taste options.

With any of these the script hides every film they've rated or logged, adds a `you` column that says `watchlist` for films on
their watchlist, and prints their 9-10/10 films and their 1-4/10 films above the table. The join: IMDb rows match on
the IMDb id (`Const`), exactly. Letterboxd rows have no IMDb id, so they match on title (lowercased, accents,
punctuation and a leading "The" dropped) with the year within one; a catalogue row with no year (most of
Emirates) matches on title alone. Letterboxd half-stars are doubled to the 10-point scale.

No export? Ask, in one message:

1. Five films they loved.
2. Two they hated.
3. Anything to avoid (horror, subtitles, sad endings, musicals, superheroes).

That takes thirty seconds. Note every film they mention as seen and don't recommend it. Tell IMDb users about the
export for next time: imdb.com, Your Ratings, the three-dot menu, Export.

## 4. Rank

The dataset carries no review scores. Rank with what you know about each film: its reception, who it suits, how
close it sits to the films they loved and how far from the ones they hated. If `TMDB_API_KEY` is set, run with
`--tmdb` and use the score and vote count as a check on your memory; a 7.8 from 40 votes means little. Never
invent a score.

Watchlist films go near the top unless they clash with the flight (a three-hour epic on a 90-minute hop). Prefer
this year's and last year's releases when they're good: those are the films people can't easily watch at home.
Leave out anything they've seen.

## 5. Present picks

Match the flight:

- **Long-haul (6h+):** three films and one backup. Put the one they most want first, before the meal and sleep;
  long films early, lighter ones late. On an overnight flight leave room to sleep.
- **Short-haul (under 3h):** one or two films under 110 minutes. Allow about 40 minutes for taxi, climb and descent.
- **Kids:** family titles only (`--family` catches each airline's own name for them: Family, Kids, Animation,
  Childrens), checked against the `cert`
  column and your own knowledge of the content. Say why each one suits the child's age.

Give each pick as a card, in the same shape as the project's CLI:

```
1. Obsession (2025)  Horror, Thriller  109 min  IMDb 7.8 (414k)
   A hopeless romantic's wish for true love spirals into a nightmare.
   why: on your watchlist; you rated Get Out 9/10; under two hours, so it ends before the first meal
   https://www.imdb.com/title/tt37287335/
```

Line one is title, year, genres and runtime from the table, then ratings: the IMDb rating as you remember it
(write "IMDb ~7.8" if you're not sure of the figure) and TMDB only when `--tmdb` gave you one. Line two is a
one-line synopsis in your own words. Line three says why it fits this person on this flight. Line four is the IMDb
link built from the id. If the id carries `(medium)`, add "IMDb match is medium confidence, check the link" to the
card. For a film with no id, say you can't confirm which film it is.

Close with one line when it applies: catalogues vary by route, aircraft and cabin (Qantas data is the large
international seatback set), and airlines swap some titles mid-month.

## Setup and troubleshooting

- The data comes from `https://seatback.len5ky.com`, the same files as the repo's `public/`. `--base <url|dir>` or
  `SEATBACK_DATASET_URL` points the script elsewhere: a mirror, `http://localhost:4173` (`bun run serve` in a
  checkout of the repo), a local `public/` folder or a `file://` URL. Local folders are read in place, never cached.
- Downloads are cached in `~/.cache/inflight-movie-picker/` (`$XDG_CACHE_HOME` respected). The index refreshes
  every 12 hours; a finished month is cached for good.
- `HTTP 404` on the index means nothing is published at that address, or the URL is wrong. A missing month means
  it isn't published yet.
- Fetched profiles are cached in `~/.cache/inflight-movie-picker/profiles/` for 24 hours; `--refresh` fetches again.
- `TMDB_API_KEY` is optional (free at themoviedb.org, Settings, API; a v3 key or a v4 read token). The first
  `--tmdb` run on a big catalogue makes one request per film; after that it's cached for 30 days.
