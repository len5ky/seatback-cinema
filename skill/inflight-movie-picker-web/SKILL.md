---
name: inflight-movie-picker-web
description: Recommend what to watch on a flight from the airline's actual in-flight film catalogue for that month, ranked against the person's taste, using the Seatback Cinema connector. Use when someone asks what to watch on their flight or plane, what movies are on Emirates (ice), United, KLM, British Airways, Singapore Airlines, Lufthansa, JAL, Cathay Pacific, Qantas, ANA or American Airlines this month, wants plane movie picks for themselves or their kids, shares an IMDb or Letterboxd profile for flight picks, or asks whether a specific film is on a given airline. Also triggers on "inflight movie picker", "seatback cinema", "what's on the plane" and "in-flight entertainment" questions.
---

# Inflight movie picker (Claude app)

The `seatback` connector holds every film in eleven airlines' seatback catalogues for the current month, with
IMDb ids, ratings and a short synopsis. You recommend from what its tools return and from nothing else. If a film
isn't in a tool result, it isn't on the plane as far as you know, however well it would fit.

The tools: `list_airlines`, `catalogue`, `picks`, `profile_from_imdb_url`, `profile_from_text`, `save_profile`,
`get_profile`. If none of
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

People see this part, so a word on naming: the saved profile is their **taste code**. Never call it a token in
anything you write to them, even though the tool field is `token`.

If they already gave a taste code, use it (below) and skip the rest of this step. Otherwise, when taste matters
(they want picks, not a yes or no on one title), offer the choices in one short paragraph, in your own words, along
these lines:

> I can rank these by your taste. Send me your public IMDb or Letterboxd profile link and I'll try to read it,
> though IMDb often blocks me. Or attach your IMDb ratings export (a CSV) or your Letterboxd export (a zip) right
> here. If you have a taste code from last time, paste it. Or I'll go by ratings alone.

Add two lines only if they ask how, or if the link route fails. IMDb ratings go public under Settings, Privacy on
imdb.com, and the export is at https://www.imdb.com/list/ratings/export on a computer (the file appears under Your
exports a minute later). Letterboxd's export is under Settings, Data, Export your data. Also mention, once, that
they can make a taste code at https://seatback.len5ky.com/taste from those same files without sending them to the
chat; it suits a big export, or a phone where attaching a file is awkward.

### A taste code

It's 20 lowercase letters and digits, usually pasted as "My Seatback Cinema taste code is abcd...". Older ones say
"profile token" instead; treat them the same. Pass `profile: { token: "..." }` straight to `picks` and skip the
other routes, even if they also pasted a profile link. Call `get_profile` only when you need to show them what's in
it. If the code comes back unknown or expired, say so in plain words and offer the other routes.

### An IMDb profile link

It looks like `https://www.imdb.com/user/p.xxxxxxxx/ratings/` (older ones use `ur1234567` in place of `p.xxx`).
The ratings and the watchlist must be public.

Fetch the ratings page yourself first, with your web fetch tool: `https://www.imdb.com/user/<id>/ratings/`. A page
holds up to 250 titles. Pass it unchanged to `profile_from_text` with `kind: "imdb_page"`, then fetch `?page=2`,
`?page=3` and on until a page adds nothing new, and stop at 10 pages. From page 2 onward, pass the profile so far
as `add_to`. The watchlist at `/watchlist/` gets the same treatment with `list: "watchlist"`. Pages list the films
but not the scores, so every title counts as seen and `picks` hides it; the result's `note` says so. Don't invent
scores to fill the gap. IMDb often blocks automated fetches: an empty page, HTTP 202 or 403, or a page with no
title ids on it means it said no.

The connector's `profile_from_imdb_url` comes second. IMDb turns its cloud server away nearly every time (HTTP
429), so call it only when your own fetch was blocked or found no title ids, and call it once. When it does get
through, it reads ratings with scores plus the watchlist, and answers with counts, the genres and directors it
learned, and an `imdb_user` id. Pass `profile: { imdb_user: "ur..." }` to `picks` and read out anything in `notes`.

If both fail, tell them IMDb blocked the link and point them to the export: attach it here, or turn it into a taste
code at https://seatback.len5ky.com/taste.

### A Letterboxd profile link

Any URL under `https://letterboxd.com/<username>/` will do; you only need the username. Their films live at
`/films/` (`/films/ratings/` redirects there): every film they've logged, 72 to a page, with a star rating where
they gave one. Walk `/films/`, `/films/page/2/` and on until the last page number shown in the links at the
bottom, or 10 pages (720 films), whichever comes first, and say if you stopped early. Each page goes to
`profile_from_text` as `kind: "letterboxd_page"`, chained with `add_to` the way the IMDb pages are. The watchlist
at `/watchlist/` gets the same treatment with `list: "watchlist"`.

There are no IMDb ids on Letterboxd. The connector matches films through its own Letterboxd links where it has
them and on title and year otherwise, so the odd retitled film slips through. A 403 or a "Just a moment" page
means Letterboxd blocked you: ask for the export zip instead.

### An attached file

Send each file's text to `profile_from_text`, unchanged, and chain the files with `add_to`:

- IMDb ratings export (`Const` and `Your Rating` columns, short or full): `kind: "imdb_csv"`.
- IMDb watchlist export (`Const` without `Your Rating`, or a list export that starts with `Position`):
  `kind: "imdb_csv"`; the tool detects it. Add `list: "watchlist"` if the file name says watchlist and you want to
  be sure.
- Letterboxd `ratings.csv` and `watched.csv`: `kind: "letterboxd_csv"`. `watchlist.csv`: the same with
  `list: "watchlist"`.

A zip (Letterboxd's export): unpack it with your file tool or code sandbox and send `ratings.csv`, `watched.csv` and
`watchlist.csv` as three calls. Skip the rest; `profile.csv` holds their email and has no films. If you can't open
zips here, ask them to attach those three files, or to use https://seatback.len5ky.com/taste, which reads the zip
in their browser.

A file over about 200 KB goes in parts of about 200 KB, cut at line ends. Every part starts with the file's header
line (repeat it), and each call after the first passes the previous result as `add_to`. Over about 1 MB (some 5,000
ratings), suggest the /taste page instead: copying that much through the chat is slow.

### Ratings alone

If they don't want to share anything, run `picks` with no profile; it ranks by the blended ratings. If they'd rather
name a few films they loved and a few they hated, put those in `seen` as `"Title (Year)"` and any genres they like
or avoid in `liked_genres` and `disliked_genres`.

## 3. Offer a taste code (once)

After the first profile that worked from a link or a file, ask once: "Want me to remember this? I'll give you a short
taste code to paste next time." Add one line on what it holds: your rated film ids and scores, nothing else, kept
for a year. If they say yes, call `save_profile` and give them the code on its own line, then the sentence to paste
next time: "My Seatback Cinema taste code is <code>." Anyone with the code can load that film list, so tell them to
keep it somewhere private. Don't offer again in the same chat, and don't offer for a profile built from a few films
named in chat unless they ask. An import through `profile_from_imdb_url` needs no code.

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
