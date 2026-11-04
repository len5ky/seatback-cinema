# Seatback Cinema

Ask Claude what to watch on your flight and get three films and a backup from what your airline is actually showing
this month, with ratings, a one-line synopsis and an IMDb link, skipping everything you've already rated.

Covered: Emirates, United, British Airways, Singapore Airlines, Lufthansa, KLM, Japan Airlines, Cathay Pacific,
Qantas, ANA and American Airlines. Catalogues refresh on the 1st and 15th.

## What's in the plugin

- **Skill `inflight-movie-picker-web`**: asks about the flight (airline, length, who's watching), takes your taste
  from a public IMDb profile link, a Letterboxd username or a taste code, and ranks the catalogue. Without any of
  those it shows likely picks and asks what you've seen.
- **Connector `seatback`** (`https://seatback.len5ky.com/mcp`, no login): optional. The skill reads the same data
  over the plain web API when the connector isn't added. The connector adds pasting an IMDb or Letterboxd export
  straight into the chat.

## Try it

> I'm on Emirates to Dubai on Thursday, about 7 hours. My IMDb ratings are at https://www.imdb.com/user/ur12345678/ratings/. Skip anything I've already seen and pick me three films for the flight, newer ones first.

> BA to New York with two kids, 8 and 11. What's on board for them, and one thing for me after they fall asleep?

## Data handling

Requests go to `https://seatback.len5ky.com`, run by the author on Cloudflare Workers and Convex. The service
receives the airline, flight length and filters, and, only when you provide it, an IMDb profile link, a Letterboxd
username, an export, or a taste code. Imports are cached for 24 hours; taste codes keep film ids and scores for a
year under a random code; there are no accounts, cookies or analytics. Full text: https://seatback.len5ky.com/privacy

Source and dataset: https://github.com/len5ky/seatback-cinema (MIT).
