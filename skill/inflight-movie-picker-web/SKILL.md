---
name: inflight-movie-picker-web
description: Recommend what to watch on a flight from the airline's actual in-flight film catalogue for that month, ranked against the person's taste, using the Seatback Cinema connector. Use when someone asks what to watch on their flight or plane, what movies are on Emirates (ice), United, KLM, British Airways, Singapore Airlines, Lufthansa, JAL, Cathay Pacific, Qantas, ANA or American Airlines this month, wants plane movie picks for themselves or their kids, shares an IMDb or Letterboxd profile for flight picks, or asks whether a specific film is on a given airline. Also triggers on "inflight movie picker", "seatback cinema", "what's on the plane" and "in-flight entertainment" questions.
---

# Inflight movie picker (Claude app)

Seatback Cinema holds every film in eleven airlines' seatback catalogues for the current month, with IMDb ids,
ratings and a short synopsis. You reach it one of two ways, and they answer the same: the `seatback` connector's
tools when they're available (`list_airlines`, `catalogue`, `picks`, `profile_from_imdb_url`,
`profile_from_letterboxd`, `profile_from_text`, `save_profile`, `get_profile`), otherwise the GET API at
`https://seatback.len5ky.com/api/` through your web fetch tool (the last section maps each tool to a URL). Check
for the tools first; most people have only the skill, so the API is the usual route. You recommend from what comes
back and from nothing else. If a film isn't in a result, it isn't on the plane as far as you know, however well it
would fit. Never fall back to recommending from memory.

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

Use the first of these the person can give you, in this order: an IMDb profile link, a Letterboxd username, a
taste code from last time. If they already sent one, use it and don't ask. Otherwise, when taste matters (they want
picks, not a yes or no on one title), ask in one line, in your own words:

> Want these ranked for you? Paste your IMDb profile link or your Letterboxd username, or your taste code if you
> have one from last time.

If they have none of those, or would rather not share, go to the seen check below. Bring up exports and file
uploads only if they ask, or if everything else has failed.

### A taste code

It's 20 lowercase letters and digits, usually pasted as "My Seatback Cinema taste code is abcd...". Older ones say
"profile token" instead; treat them the same. Pass `profile: { token: "..." }` straight to `picks` and skip the
other routes, even if they also pasted a profile link. Call `get_profile` only when you need to show them what's in
it. If the code comes back unknown or expired, say so in plain words and ask for the link or the username.

### An IMDb profile link

It looks like `https://www.imdb.com/user/p.xxxxxxxx/ratings/` (older ones use `ur1234567` in place of `p.xxx`), and
the ratings must be public. Call `profile_from_imdb_url` with the link straight away. Don't fetch the IMDb pages
yourself first: the connector reads the profile on its own server, scores and watchlist included, in up to half a
minute for a big one. It answers with counts, the genres and directors it learned, `notes` and an `imdb_user` id.
Pass `profile: { imdb_user: "ur..." }` to `picks` and mention anything in `notes`. Call it once per link: the
import stays on the server for 24 hours, so later picks in the same chat reuse `imdb_user`.

When it fails, the error says why. Don't call it again with the same link.

- **Private ratings.** Tell them how to fix it in one line: on imdb.com, Settings, then Privacy, and set ratings to
  public; then send the link again. Meanwhile offer Letterboxd or the seen check.
- **IMDb said no, or the daily limit is reached.** Say the IMDb import isn't working right now, in a few words,
  and move on to their Letterboxd username or the seen check.

### A Letterboxd username

Any `https://letterboxd.com/<username>/` link will do as well. Call `profile_from_letterboxd` with it and pass the
`profile` it returns to `picks` unchanged. It reads their public diary, which only goes back 50 entries, so tell
them in your reply that you went by their latest 50 logged films. Older films they've seen can still turn up, so
follow with one round of the seen check on the picks.

### The seen check

Most of what a long rating history buys is knowing what they've already watched. Without one, ask:

1. Call `picks` with whatever profile you have (none is fine) and `limit: 20`.
2. Show the top ten as one short list, title and year only, and ask which they've seen. A reply like "seen 2, 5
   and Wicked" is enough.
3. Add the ones they name to the profile's `seen` as their `imdbId`s, call `picks` again, and ask once more about
   the next ten they haven't been shown.
4. Then pick from the third call. Two rounds at most, even if they've seen a lot.

If they mention films they loved or hated along the way, add those to `seen` too, and put any genres they want or
want to avoid in `liked_genres` and `disliked_genres`. Keep each round to two lines.

### Files, if they ask

An IMDb ratings export (CSV), a Letterboxd export (zip) or its CSVs, attached to the chat, still work. Send each
file's text to `profile_from_text`, unchanged, and chain the files with `add_to`:

- IMDb ratings export (`Const` and `Your Rating` columns): `kind: "imdb_csv"`. A watchlist or list export (`Const`
  without `Your Rating`, or one that starts with `Position`) is detected; add `list: "watchlist"` to be sure.
- Letterboxd `ratings.csv` and `watched.csv`: `kind: "letterboxd_csv"`. `watchlist.csv`: the same with
  `list: "watchlist"`.

Unpack a Letterboxd zip with your file tool or code sandbox and send those three files; skip `profile.csv`, which
holds their email and no films. A file over about 200 KB goes in parts of about 200 KB cut at line ends, each part
starting with the file's header line, each call after the first passing the previous result as `add_to`.

The IMDb export is at https://www.imdb.com/list/ratings/export on a computer (it appears under Your exports a
minute later); Letterboxd's is under Settings, Data, Export your data. For a big export, or a phone where attaching
a file is awkward, https://seatback.len5ky.com/taste turns the same files into a taste code in their browser.

## 3. Offer a taste code (once)

After the first import that worked (an IMDb link or a file), offer it once, in one line: "Want a taste code so
next time you can skip this? It holds your film ids and scores, nothing else, for a year." If they say yes, call
`save_profile` with `profile: { imdb_user: "ur..." }` after an IMDb import, or with the profile itself after a file,
and give them the code on its own line with the sentence to paste next time: "My Seatback Cinema taste code is
<code>." Anyone with the code can load that film list, so tell them to keep it private. Don't offer again in the
same chat, and don't offer after a Letterboxd read or a seen check unless they ask.

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

## Without the connector: the GET API

The same data answers plain GET requests. Fetch these with your web fetch tool and read the JSON:

- `https://seatback.len5ky.com/api/airlines`
- `https://seatback.len5ky.com/api/catalogue?airline=qantas&q=project%20hail%20mary` to check a title or browse
  (`genre`, `min_year`, `max_year`, `max_runtime`, `family`, `limit` and `offset` work too)
- `https://seatback.len5ky.com/api/picks?airline=emirates&flight_minutes=420&min_year=2024&limit=8`, with at most
  one of `imdb=<their profile link>`, `letterboxd=<username>` or `code=<taste code>`
- `https://seatback.len5ky.com/api/profile?imdb=<their profile link>` returns a taste code for an IMDb profile

Build each URL from what they said, as you would fill the tool arguments: 7 hours is `flight_minutes=420`, kids
mean `family=true`, several genres go comma-separated, and a profile link goes in URL-encoded. Picks come back as
the same cards, so sections 4 and 5 hold as written. A failure comes back as `{ error, hint }`; do what the hint
says. For the seen check, ask for `limit=20` and drop the films they name yourself, since the API takes no seen list.

Exports pasted into the chat need the connector (`profile_from_text`); over the API, offer
https://seatback.len5ky.com/taste instead, which turns the export into a taste code in the browser. If the fetch
tool refuses these URLs or you don't have one, say in one line that adding the connector fixes it: Settings,
Connectors, Add custom connector, URL `https://seatback.len5ky.com/mcp`.
