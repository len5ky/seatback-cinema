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

Look in the working directory first, without asking: an IMDb export (`data/imdb-ratings/*.csv`, or any CSV with a
`Const` column) or an unzipped Letterboxd export (`ratings.csv`, `watched.csv`, `watchlist.csv`) beats anything
else. Pass the file or folder to the script with `--taste data/imdb-ratings` (or the export folder).

Otherwise ask for the first of these they can give, in this order: an IMDb profile link, a Letterboxd username, a
taste code from last time. With none of them, do the seen check below. Mention exports only if they ask or
everything else failed.

**IMDb link.** Pass it to the script. It reads the profile from this machine through IMDb's API (the calls
imdb.com makes in a browser; a 941-rating profile with scores and watchlist is 7 requests), falls back to the
profile pages, and caches it for 24 hours. The ratings must be public: if the script or the connector says they're
private, tell them in one line to set ratings to public under Settings, Privacy on imdb.com and send the link
again. IMDb refuses scripted requests from some networks (an empty HTTP 202 or a 429). Then, if the Seatback Cinema
connector is in this session (tools `list_airlines`, `picks`, `profile_from_imdb_url` and so on), call
`profile_from_imdb_url` with the link once; it reads the profile from its own server and usually gets through. Pass
`profile: { imdb_user }` from its answer to `picks`.

**Letterboxd username.** `--letterboxd-url https://letterboxd.com/<username>/` reads their films pages, 72 a page,
then the watchlist, up to 50 pages. If Letterboxd answers 403, the connector's `profile_from_letterboxd` reads their
diary feed instead, which covers only the latest 50 entries; say so, and follow with the seen check.

```bash
bun $S emirates --imdb-url https://www.imdb.com/user/p.xxxxxxxx/ratings/
bun $S ba --letterboxd-url https://letterboxd.com/<username>/
bun $S emirates --profile-token <code>
```

**Taste code.** "My Seatback Cinema taste code is ..." (or the older "my profile token is ...") goes in as
`--profile-token <code>`, in place of the other options. To carry a profile into the Claude app, add
`--save-profile` to an `--imdb-url`, `--letterboxd-url` or `--taste` run: it stores the profile on the Seatback
server and ends with the sentence to paste there.

With any of these the script hides every film they've rated or logged, adds a `you` column that says `watchlist`
for films on their watchlist, and prints their 9-10/10 films and their 1-4/10 films above the table. IMDb rows
match on the IMDb id, exactly. Letterboxd rows have no IMDb id, so they match through the dataset's Letterboxd
links where it has them, else on title (lowercased, accents, punctuation and a leading "The" dropped) with the year
within one. Letterboxd half-stars are doubled to the 10-point scale.

**The seen check.** Most of what a long rating history buys is knowing what they've already watched. With nothing
else, shortlist the 20 strongest films for the flight from the table, show the first ten as title and year, and
ask which they've seen; then ask once more about the next ten. Two rounds at most. Drop every film they name, and
note any they say they loved or hated, plus anything to avoid (horror, subtitles, sad endings).

When everything else has failed, the export is the fallback: imdb.com, Your ratings, the three-dot menu, Export,
or Letterboxd's Settings, Data, Export your data; then `--taste`.

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
