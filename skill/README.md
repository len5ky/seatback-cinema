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

Claude Code users don't need this folder: `/plugin install seatback-cinema --marketplace len5ky/seatback-cinema`
installs the Seatback Cinema plugin (skill plus connector) in one step. This folder is for Codex, Cursor and other
agents, or for Claude Code without network tools. One command, from GitHub:

```bash
npx skills add len5ky/seatback-cinema
```

Without it, fetch the folder straight into place (no clone):

```bash
mkdir -p ~/.codex/skills && curl -fsSL https://github.com/len5ky/seatback-cinema/archive/refs/heads/main.tar.gz \
  | tar xz -C ~/.codex/skills --strip-components=2 seatback-cinema-main/skill/inflight-movie-picker
```

## Claude Code (without the plugin)

Put the folder at `~/.claude/skills/inflight-movie-picker/` for all projects, or `<project>/.claude/skills/` for
one. Claude Code picks it up from the `description` in `SKILL.md`. Ask "what's good on my United flight next week?"

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

The Claude app can't run the script, so it has its own skill, `plugins/seatback-cinema/skills/inflight-movie-picker-web/`,
which reads the same data over `https://seatback.len5ky.com/api/`. It ships as the Seatback Cinema plugin:
Customize, Plugins, Add marketplace, `len5ky/seatback-cinema`. The plugin also carries the connector
(`https://seatback.len5ky.com/mcp`), added from its Connectors tab if wanted: that enables pasting an IMDb or
Letterboxd export into the chat. Plans without plugins can upload the zip at
https://seatback.len5ky.com/inflight-movie-picker-web.zip instead; `scripts/package-web-skill.sh` rebuilds it.

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
