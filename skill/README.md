# inflight-movie-picker skill

Ask your coding agent "what should I watch on my Emirates flight?" and it picks from the films Emirates is
actually showing that month, with IMDb links. The skill is two files: `SKILL.md` (instructions for the model) and
`scripts/catalogue.ts` (downloads and prints a catalogue from the open dataset). There are no dependencies;
any one of Bun, Node 22.6+ or Deno will run it.

Airlines: Emirates, United, KLM, British Airways, Singapore Airlines, Lufthansa, Japan Airlines, Cathay Pacific,
Qantas, ANA, American Airlines. The data is refreshed on the 1st and 15th of each month.

The dataset is read from `https://raw.githubusercontent.com/len5ky/seatback-cinema/main/public`. `--base` or
`SEATBACK_DATASET_URL` points the script at a mirror or a local copy: `http://localhost:4173` from `bun run serve`
in a checkout, a `public/` folder, or a `file://` URL.

## Get the files

```bash
git clone --depth 1 https://github.com/len5ky/seatback-cinema /tmp/inflight-movie-picker-src
# the skill is the skill/inflight-movie-picker directory; copy it to where your agent looks (below)
```

## Claude Code

```bash
cp -r /tmp/inflight-movie-picker-src/skill/inflight-movie-picker ~/.claude/skills/       # all projects
# or: cp -r ... <project>/.claude/skills/                              # one project
```

Claude Code picks it up from the `description` in `SKILL.md`. Ask "what's good on my United flight next week?"

## Codex CLI

```bash
mkdir -p ~/.codex/skills && cp -r /tmp/inflight-movie-picker-src/skill/inflight-movie-picker ~/.codex/skills/
```

If your Codex version doesn't load skills, add this line to `~/.codex/AGENTS.md`:
`For in-flight movie questions, follow ~/.codex/skills/inflight-movie-picker/SKILL.md.`

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

## Options

| variable | what it does |
|---|---|
| `SEATBACK_DATASET_URL` | where to read the data: a URL, a local `public/` folder or `file://` URL (default: this repo's published `public/`). `--base` does the same per call; `DATASET_BASE_URL` still works as the old name |
| `TMDB_API_KEY` | optional; `--tmdb` adds TMDB score and vote count per film (free key at themoviedb.org) |
| `XDG_CACHE_HOME` | cache root; files go in `$XDG_CACHE_HOME/inflight-movie-picker/` (default `~/.cache/inflight-movie-picker/`) |

Try it by hand:

```bash
cd ~/.claude/skills/inflight-movie-picker   # or wherever you put it
bun scripts/catalogue.ts --list
bun scripts/catalogue.ts singapore --genre comedy --max-runtime 110
bun scripts/catalogue.ts emirates --taste ~/Downloads/imdb-ratings    # hides films you rated, flags your watchlist
```

`--taste` takes an IMDb ratings or watchlist CSV, an unzipped Letterboxd export, or a folder holding either.

The dataset holds catalogue facts and IDs only (title, year, runtime, directors, genres, classification,
languages, airline categories, IMDb id). It has no synopses, posters or review scores. IMDb ids come from
IMDb's non-commercial datasets.
