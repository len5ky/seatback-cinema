# plane-movies skill

Ask your coding agent "what should I watch on my Emirates flight?" and get picks from that airline's real
catalogue for the month, with IMDb links. The skill is two files: `SKILL.md` (instructions for the model) and
`scripts/catalogue.ts` (downloads and prints a catalogue from the open dataset). It has no dependencies and
needs only one of Bun, Node 22.6+ or Deno.

Airlines: Emirates, United, KLM, British Airways, Singapore Airlines, Lufthansa, Japan Airlines, Cathay Pacific,
Qantas, ANA, American Airlines. The data is refreshed on the 1st and 15th of each month.

The dataset is read from `https://raw.githubusercontent.com/len5ky/seatback/main/public`. Set `DATASET_BASE_URL`
to point the script at a mirror or a local copy (for example `http://localhost:3000` serving `public/`).

## Get the files

```bash
git clone --depth 1 https://github.com/len5ky/seatback /tmp/plane-movies-src
# the skill is the skill/plane-movies directory; copy it to where your agent looks (below)
```

## Claude Code

```bash
cp -r /tmp/plane-movies-src/skill/plane-movies ~/.claude/skills/       # all projects
# or: cp -r ... <project>/.claude/skills/                              # one project
```

Claude Code picks it up from the `description` in `SKILL.md`. Ask "what's good on my United flight next week?"

## Codex CLI

```bash
mkdir -p ~/.codex/skills && cp -r /tmp/plane-movies-src/skill/plane-movies ~/.codex/skills/
```

If your Codex version doesn't load skills, add this line to `~/.codex/AGENTS.md`:
`For in-flight movie questions, follow ~/.codex/skills/plane-movies/SKILL.md.`

## Cursor

Copy the directory into your project (for example `.cursor/plane-movies/`) and add a rule,
`.cursor/rules/plane-movies.mdc`:

```markdown
---
description: In-flight movie recommendations from airline catalogues
alwaysApply: false
---
For questions about what to watch on a flight, follow .cursor/plane-movies/SKILL.md and run its script from that directory.
```

## Any other agent

Point the agent at `SKILL.md` (paste it, or reference it from `AGENTS.md`). It only needs to run a shell command.

## Options

| variable | what it does |
|---|---|
| `DATASET_BASE_URL` | where to fetch the data from (defaults to this repo's published `public/` directory) |
| `TMDB_API_KEY` | optional; `--tmdb` adds TMDB score and vote count per film (free key at themoviedb.org) |
| `XDG_CACHE_HOME` | cache root; files go in `$XDG_CACHE_HOME/plane-movies/` (default `~/.cache/plane-movies/`) |

Try it by hand:

```bash
cd ~/.claude/skills/plane-movies   # or wherever you put it
bun scripts/catalogue.ts --list
bun scripts/catalogue.ts singapore --genre comedy --max-runtime 110
```

The dataset holds catalogue facts and IDs only (title, year, runtime, directors, genres, classification,
languages, airline categories, IMDb id). It has no synopses, posters or review scores. IMDb ids come from
IMDb's non-commercial datasets.
