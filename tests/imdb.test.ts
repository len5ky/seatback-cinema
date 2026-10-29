import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { openDb } from "../src/db.ts";
import { loadImdb } from "../src/imdb.ts";

const DIR = "tmp/test-imdb";
const gz = (name: string, lines: string[]) => Bun.write(`${DIR}/${name}.tsv.gz`, Bun.gzipSync(lines.join("\n") + "\n"));
const quiet = () => {};

async function fixtures(withAkas: boolean) {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  await gz("title.basics", ["h", "tt1\tmovie\tArrival\tArrival\t0\t2016\t\\N\t116\tDrama,Sci-Fi", "tt2\ttvSeries\tLost\tLost\t0\t2004\t2010\t44\tDrama"]);
  if (withAkas) await gz("title.akas", ["h", "tt1\t1\tL'arrivée\tGB\t\\N\t\\N\t\\N\t0"]);
  await gz("title.ratings", ["h", "tt1\t7.9\t880000", "tt2\t8.3\t600000"]);
  await gz("title.crew", ["h", "tt1\tnm1\t\\N", "tt2\tnm2\t\\N"]);
  await gz("name.basics", ["h", "nm1\tDenis Villeneuve\t1967", "nm2\tJ.J. Abrams\t1966", "nm3\tNobody\t1900"]);
}

test("imdb load: full rebuild, then a failing reload leaves the previous data untouched", async () => {
  const db = openDb(":memory:");
  await fixtures(true);
  expect(await loadImdb(db, quiet, 1, DIR)).toEqual({ titles: 1, names: 1 });
  expect(db.query("SELECT tconst, rating, votes, directors FROM imdb_titles").all()).toEqual([{ tconst: "tt1", rating: 7.9, votes: 880000, directors: "nm1" }]);
  expect(db.query("SELECT norm FROM imdb_keys ORDER BY norm").all()).toEqual([{ norm: "arrival" }, { norm: "larrivee" }]);

  await fixtures(false); // title.akas missing -> load fails after title.basics
  await expect(loadImdb(db, quiet, 1, DIR)).rejects.toThrow();
  expect(db.query("SELECT COUNT(*) AS n FROM imdb_titles").get()).toEqual({ n: 1 });
  expect(db.query("SELECT name FROM imdb_names").all()).toEqual([{ name: "Denis Villeneuve" }]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE '%_new'").all()).toEqual([]);
  rmSync(DIR, { recursive: true, force: true });
});

test("imdb load: European retitles (NL, FR, DE, IT, ES) become title keys; other regions do not", async () => {
  const db = openDb(":memory:");
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  await gz("title.basics", ["h", "tt3521164\tmovie\tMoana\tMoana\t0\t2016\t\\N\t107\tAnimation"]);
  await gz("title.akas", ["h",
    "tt3521164\t1\tVaiana\tNL\t\\N\t\\N\t\\N\t0",
    "tt3521164\t2\tOceania\tIT\t\\N\t\\N\t\\N\t0",
    "tt3521164\t3\tVaiana: Das Paradies hat einen Haken\tDE\t\\N\t\\N\t\\N\t0",
    "tt3521164\t4\tMoana Japan\tJP\t\\N\t\\N\t\\N\t0",
  ]);
  await gz("title.ratings", ["h", "tt3521164\t7.6\t400000"]);
  await gz("title.crew", ["h", "tt3521164\tnm1\t\\N"]);
  await gz("name.basics", ["h", "nm1\tRon Clements\t1953"]);
  await loadImdb(db, quiet, 1, DIR);
  const keys = (db.query("SELECT norm FROM imdb_keys ORDER BY norm").all() as { norm: string }[]).map((k) => k.norm);
  expect(keys).toContain("vaiana");
  expect(keys).toContain("oceania");
  expect(keys.some((k) => k.includes("japan"))).toBe(false); // JP is not a filtered region
  expect(keys).toHaveLength(4); // moana + the three European titles
  rmSync(DIR, { recursive: true, force: true });
});
