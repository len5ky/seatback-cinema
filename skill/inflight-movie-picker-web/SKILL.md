---
name: inflight-movie-picker-web
description: Recommend what to watch on a flight from the airline's actual in-flight film catalogue for that month, ranked against the person's taste, using the Seatback Cinema connector. Use when someone asks what to watch on their flight or plane, what movies are on Emirates (ice), United, KLM, British Airways, Singapore Airlines, Lufthansa, JAL, Cathay Pacific, Qantas, ANA or American Airlines this month, wants plane movie picks for themselves or their kids, shares an IMDb or Letterboxd profile for flight picks, or asks whether a specific film is on a given airline. Also triggers on "inflight movie picker", "seatback cinema", "what's on the plane" and "in-flight entertainment" questions.
---

# Inflight movie picker (Claude app)

The `seatback` connector holds every film in eleven airlines' seatback catalogues for the current month, with
IMDb ids, ratings and a short synopsis. You recommend from what its tools return and from nothing else. If a film
isn't in a tool result, it isn't on the plane as far as you know, however well it would fit.

The tools: `list_airlines`, `catalogue`, `picks`, `profile_from_text`, `save_profile`, `get_profile`. If none of
them is available, the connector isn't added. Say so and give the fix in one line: Settings, Connectors, Add custom
connector, URL `https://seatback.len5ky.com/mcp`. Don't fall back to recommending from memory.

## 1. The flight

You need the airline, the flight length and whether children are watching. Take what the person already said and
ask for the rest in one short message. If they just want picks, assume (long-haul, adults) and say what you
assumed.

Call `list_airlines` once to get the airline ids and the month each catalogue covers. Covered: Emirates, United,
KLM, British Airways, Singapore, Lufthansa, JAL, Cathay Pacific, Qantas, ANA, American. Delta, Turkish, Air France
and Qatar aren't covered because they don't publish a usable catalogue. Say that plainly; don't guess their
line-up. If the flight is next month and the airline hasn't published it yet, use the current month and say the
line-up may change around the 1st.

Flight length becomes `flight_minutes` (7 hours is 420). `picks` drops anything longer than the flight minus 30
minutes, which covers taxi, climb and descent. Children watching means `filters: { family: true }`, and you still
check each pick's `cert` against the child's age yourself.

## 2. Their taste

Four routes, best first. Ask which one they want only if it isn't obvious from the message.

### A saved profile token

If they give a 20-character token from an earlier chat, pass `profile: { token: "..." }` straight to `picks`. Call
`get_profile` only when you need to show them what's in it. An expired or unknown token comes back as an error:
tell them, and move on to one of the other routes.

### An IMDb profile URL

It looks like `https://www.imdb.com/user/p.xxxxxxxx/ratings/` (older ones use `ur1234567` in place of `p.xxx`).
The ratings and the watchlist must be public: IMDb, Settings, Privacy.

1. Fetch `https://www.imdb.com/user/<id>/ratings/` with your web fetch tool. Each page holds up to 250 titles, and
   the top of the page gives the total ("941 titles"). Fetch `?page=2`, `?page=3` and so on until you have them all
   or a page adds nothing new. Stop at 10 pages and say you used the most recent 2,500.
2. Pass each page's content, unchanged, to `profile_from_text` with `kind: "imdb_page"`. From page 2 onward, pass
   the profile you have so far as `add_to`.
3. Do the same for `https://www.imdb.com/user/<id>/watchlist/` (one page covers 250 films) with
   `list: "watchlist"`, so those films count as wanted, not seen.

IMDb loads the person's own scores with a script after the page arrives, so a fetched page often gives you the
films without the numbers. That still works: every title on the ratings page is a film they've seen, and `picks`
hides it. Don't invent scores to fill the gap.

IMDb often blocks automated fetches. An empty page, HTTP 202 or 403, or a page with no titles on it means it said
no. Tell them it was blocked and offer two ways round it:

- the CSV export: sign in on a computer, open https://www.imdb.com/list/ratings/export (for the watchlist, the
  three-dot menu on the Watchlist page, then Export), download the file from Your exports and attach it here;
- a profile token, if they saved one before.

### A Letterboxd profile URL

Any URL under `https://letterboxd.com/<username>/` will do; you only need the username. Their films live at
`/films/` (`/films/ratings/` redirects there): every film they've logged, 72 to a page, with a star rating where
they gave one. Walk `/films/`, `/films/page/2/` and on until the last page number shown in the links at the
bottom, or 10 pages (720 films), whichever comes first, and say if you stopped early. Each page goes to
`profile_from_text` as `kind: "letterboxd_page"`, chained with `add_to` the way the IMDb pages are. The watchlist
at `/watchlist/` gets the same treatment with `list: "watchlist"`.

There are no IMDb ids on Letterboxd. The connector matches films through its own Letterboxd links where it has
them and on title and year otherwise, so the odd retitled film slips through. A 403 or a "Just a moment" page
means Letterboxd blocked you: ask for the export (letterboxd.com, Settings, Data, Export your data) and have them
attach `ratings.csv`, `watched.csv` or `watchlist.csv` from the zip.

### An attached file

- IMDb export (`Const` and `Your Rating` columns, or just `Const` for the watchlist): `kind: "imdb_csv"`. The tool
  tells ratings and watchlist apart by the header.
- Letterboxd `ratings.csv` or `watched.csv`: `kind: "letterboxd_csv"`. For `watchlist.csv` add
  `list: "watchlist"`.

Pass the file text unchanged. With several files, chain them with `add_to`.

### Nothing

Ask, in one message, for five films they loved, two they hated and anything to avoid (horror, subtitles, sad
endings, musicals). Build the profile yourself: the films they name go in `seen` as `"Title (Year)"`, the genres
they like or avoid go in `liked_genres` and `disliked_genres`, and a director they mention twice goes in
`liked_directors`. That takes thirty seconds and beats picking blind. If they'd rather skip it, run `picks` with no
profile.

## 3. Save the profile (offer once)

When the profile came from a URL or a file, offer once to save it so next time they can skip this step. If they
say yes, call `save_profile` and give them the token on its own line. Tell them to keep it somewhere they'll find
it: it's the only way back to the profile, it lasts a year, and anyone who has it can load the film list (ids and
ratings, nothing else). Don't offer again in the same chat, and don't save a profile they built from five titles in
chat unless they ask.

## 4. Picks

Call `picks` with the airline, `flight_minutes`, any filters (family, a genre they asked for, a language) and the
profile. The default of 8 results gives you room to choose. If it comes back with fewer than four, loosen one
filter, run it again and say which one you dropped.

Choose from the returned cards only:

- **Long-haul (6 hours or more):** three picks and one backup. Put the one they'll most want first, before the
  meal and sleep, and longer films before lighter ones. On an overnight flight leave room to sleep.
- **Short-haul (under 3 hours):** one or two picks under 110 minutes, plus the backup.
- **Children:** family titles only, and say why each suits the child's age.

`onWatchlist: true` films go near the top unless they clash with the flight. This year's and last year's releases
are worth favouring when they're good, since they're the hardest to watch at home.

## 5. Show them

One card per film, in this shape:

> **1. Obsession** (2025) · Horror, Thriller · 109 min
> IMDb 7.8 (414k) · Letterboxd 4.1 · RT 94%
> A hopeless romantic's wish for true love turns into a nightmare.
> *Why:* on your watchlist; you rate horror above your average; ends before the first meal.
> [IMDb page](https://www.imdb.com/title/tt37287335/)

- Line one: `title`, `year`, `genres`, `runtime` from the card.
- Line two: the ratings the card carries (`imdb` with `votes`, `letterboxd`, `rt`, `metacritic`), and only those.
  Leave out a source the card doesn't have; never fill one from memory.
- Line three: the card's `synopsis` cut to one line, in your own words if it runs long.
- Line four: why it fits this person on this flight. Start from the card's `why` list and add the flight reason.
- Line five: the IMDb link built from `imdbId`.

Label the backup as the backup. When a card's `confidence` is `"medium"`, add "IMDb match is medium confidence,
check the link": the film is on the plane, but the ratings may belong to a different film with the same title.

If `hidden_seen` is above zero, say how many films you skipped because they've seen them. Close with one line when
it applies: catalogues vary by route, aircraft and cabin, and airlines swap some titles mid-month.

## Other questions

- "Is X on Emirates?": `catalogue` with `filters: { query: "X" }`. Answer yes or no from the rows; for a near miss
  in the title, show what is there.
- "What's on United?": `catalogue` sorted best first, then summarise a handful by genre. Offer picks if they give
  you a flight.
- Never present a film, rating or synopsis that didn't come from a tool result in this chat.
