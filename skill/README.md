# inflight-movie-picker skill

Ask your coding agent "what should I watch on my Emirates flight?" and it picks from the films Emirates is
actually showing that month, with IMDb links. The skill is two files: `SKILL.md` (instructions for the model) and
`scripts/catalogue.ts` (downloads and prints a catalogue from the open dataset). There are no dependencies;
any one of Bun, Node 22.6+ or Deno will run it.

Airlines: Emirates, United, KLM, British Airways, Singapore Airlines, Lufthansa, Japan Airlines, Cathay Pacific,
Qantas, ANA, American Airlines. The data is refreshed on the 1st and 15th of each month.

The dataset is read from `https://seatback.len5ky.com` (the same files as this repo's `public/`). `--base` or
`SEATBACK_DATASET_URL` points the script at a mirror or a local copy: `http://localhost:4173` from `bun run serve`
in a checkout, a `public/` folder, or a `file://` URL.

## Install

One command, from GitHub, for Claude Code, Codex, Cursor and the other agents the `skills` CLI knows:

```bash
npx skills add len5ky/seatback-cinema
```

Without it, fetch the folder straight into place (no clone):

```bash
mkdir -p ~/.claude/skills && curl -fsSL https://github.com/len5ky/seatback-cinema/archive/refs/heads/main.tar.gz \
  | tar xz -C ~/.claude/skills --strip-components=2 seatback-cinema-main/skill/inflight-movie-picker
```

## Claude Code

`~/.claude/skills/inflight-movie-picker/` for all projects, or `<project>/.claude/skills/` for one. Claude Code
picks it up from the `description` in `SKILL.md`. Ask "what's good on my United flight next week?"

## Codex CLI

Same folder under `~/.codex/skills/`. If your Codex version doesn't load skills, add this line to
`~/.codex/AGENTS.md`: `For in-flight movie questions, follow ~/.codex/skills/inflight-movie-picker/SKILL.md.`

## Cursor

Copy the directory into your project (for example `.cursor/inflight-movie-picker/`) and add a rule,
`.cursor/rules/inflight-movie-picker.mdc`:

```markdown
---
description: In-flight movie recommendations from airline catalogues
alwaysApply: false
---
For questions about what to watch on a flight, follow .cursor/inflight-movie-picker/SKILL.md and run its script from that directory.
```

## Any other agent

Point the agent at `SKILL.md` (paste it, or reference it from `AGENTS.md`). It only needs to be able to run a shell command.

## Claude app (claude.ai on the web, desktop and mobile)

The Claude app can't run the script, so it has its own skill, `skill/inflight-movie-picker-web/`, which reads the
same data over `https://seatback.len5ky.com/api/`. Download https://seatback.len5ky.com/inflight-movie-picker-web.zip
and upload it at Settings, Capabilities, Skills; that's the whole setup. Adding the Seatback Cinema connector
(Settings, Connectors, Add custom connector, `https://seatback.len5ky.com/mcp`) is optional: it lets you paste an
IMDb or Letterboxd export into the chat and doesn't depend on Claude's web fetch. Both carry over to the mobile
apps. `scripts/package-web-skill.sh` rebuilds the zip from a checkout.

## Options

| variable | what it does |
|---|---|
| `SEATBACK_DATASET_URL` | where to read the data: a URL, a local `public/` folder or `file://` URL (default: `https://seatback.len5ky.com`). `--base` does the same per call; `DATASET_BASE_URL` still works as the old name |
| `TMDB_API_KEY` | optional; `--tmdb` adds TMDB score and vote count per film (free key at themoviedb.org) |
| `XDG_CACHE_HOME` | cache root; files go in `$XDG_CACHE_HOME/inflight-movie-picker/` (default `~/.cache/inflight-movie-picker/`) |

Try it by hand:

```bash
cd ~/.claude/skills/inflight-movie-picker   # or wherever you put it
bun scripts/catalogue.ts --list
bun scripts/catalogue.ts singapore --genre comedy --max-runtime 110
bun scripts/catalogue.ts emirates --taste ~/Downloads/imdb-ratings    # hides films you rated, flags your watchlist
bun scripts/catalogue.ts klm --imdb-url https://www.imdb.com/user/ur12345678/ratings/
bun scripts/catalogue.ts ba --letterboxd-url https://letterboxd.com/<username>/
```

`--taste` takes an IMDb ratings or watchlist CSV, an unzipped Letterboxd export, or a folder holding either.
`--imdb-url` and `--letterboxd-url` read a public profile instead, from your machine, and cache it for a day. IMDb
often refuses scripted requests (an empty HTTP 202); the script then tells you to use the CSV export.

The dataset holds catalogue facts and IDs only (title, year, runtime, directors, genres, classification,
languages, airline categories, IMDb id). It has no synopses, posters or review scores. IMDb ids come from
IMDb's non-commercial datasets.
