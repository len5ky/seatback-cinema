import { expect, test } from "bun:test";
import { normalizeTitle, splitNames, surname, titleVariants } from "../src/text.ts";
import { directorsMatch, findCandidates, pickMatch, type Candidate } from "../src/match.ts";
import { openDb } from "../src/db.ts";

test("normalises titles", () => {
  expect(normalizeTitle("The Sheep Detectives")).toBe("sheep detectives");
  expect(normalizeTitle("Amélie")).toBe("amelie");
  expect(normalizeTitle("Bank of Dave 2: The Loan Ranger")).toBe("bank of dave 2 the loan ranger");
  expect(normalizeTitle("Julie & Julia")).toBe("julie and julia");
  expect(normalizeTitle("You're Dating a Narcissist")).toBe("youre dating a narcissist");
  expect(normalizeTitle("C.D: Criminal or Devil")).toBe("c d criminal or devil");
});

test("names", () => {
  expect(surname("Steven Spielberg")).toBe("spielberg");
  expect(splitNames("Joey Palmroos, Austen Paul")).toEqual(["Joey Palmroos", "Austen Paul"]);
  expect(directorsMatch(["Pil Gam-sung"], ["Gam-sung Pil"])).toBe(true);
  expect(directorsMatch(["Michael Curtiz"], ["Mike Newell"])).toBe(false);
});

const cand = (tconst: string, startYear: number, runtime: number | null, directors: string[], votes = 1000): Candidate =>
  ({ tconst, primaryTitle: "Cinderella", startYear, runtime, votes, directorNames: directors });

test("runtime and director disambiguate same-titled films", () => {
  const cands = [
    cand("tt1661199", 2015, 105, ["Kenneth Branagh"], 180000),
    cand("tt0042332", 1950, 74, ["Clyde Geronimi", "Wilfred Jackson", "Hamilton Luske"], 170000),
    cand("tt9000001", 2024, 113, ["Kevin O'Hare"], 40),
  ];
  const m = pickMatch({ cleanTitle: "Cinderella", year: null, duration: 113, director: "Kevin O'Hare" }, cands, 2026);
  expect(m.tconst).toBe("tt9000001");
  expect(m.confidence).toBe("high");
});

test("director alone gives medium; contradiction gives low; nothing gives none", () => {
  const toy = pickMatch({ cleanTitle: "Toy Story 5", year: null, duration: 102, director: "Andrew Stanton" },
    [cand("tt1", 2026, null, ["Andrew Stanton"])], 2026);
  expect(toy.confidence).toBe("medium");
  const wrong = pickMatch({ cleanTitle: "Cinderella", year: null, duration: 113, director: "Kevin O'Hare" },
    [cand("tt1661199", 2015, 105, ["Kenneth Branagh"], 180000)], 2026);
  expect(wrong.confidence).toBe("low");
  expect(pickMatch({ cleanTitle: "Nope", year: null, duration: 90, director: null }, [], 2026).confidence).toBe("none");
});

test("title year picks the right remake", () => {
  const m = pickMatch({ cleanTitle: "Casablanca", year: 1942, duration: 102, director: "Michael Curtiz" },
    [cand("tt0034583", 1942, 102, ["Michael Curtiz"], 600000), cand("tt5", 1955, 60, ["Someone Else"], 50)], 2026);
  expect(m).toMatchObject({ tconst: "tt0034583", confidence: "high" });
});

test("two indistinguishable candidates are downgraded as ambiguous", () => {
  const m = pickMatch({ cleanTitle: "Drive", year: null, duration: 105, director: null },
    [cand("tt1", 2011, 105, ["X"], 1000), cand("tt2", 2019, 104, ["Y"], 1000)], 2026);
  expect(m.confidence).toBe("low");
  expect(m.reasons.join()).toContain("ambiguous");
});

test("findCandidates uses normalised primary and original titles", () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO imdb_titles VALUES ('tt1','movie','Amelie','Le fabuleux destin d''Amélie Poulain',2001,122,'Comedy,Romance',8.3,800000,'nm1')");
  db.run("INSERT INTO imdb_names VALUES ('nm1','Jean-Pierre Jeunet')");
  db.run("INSERT INTO imdb_keys VALUES ('amelie','tt1'), ('fabuleux destin damelie poulain','tt1')");
  const { candidates: c, viaVariant } = findCandidates(db, "Le Fabuleux Destin d'Amélie Poulain");
  expect(viaVariant).toBe(false);
  expect(c.map((x) => [x.tconst, x.directorNames])).toEqual([["tt1", ["Jean-Pierre Jeunet"]]]);
});

test("numerals and alternative titles", () => {
  expect(normalizeTitle("Frozen II")).toBe(normalizeTitle("Frozen 2"));
  expect(normalizeTitle("Back to the Future Part II")).toBe(normalizeTitle("Back to the Future II"));
  expect(normalizeTitle("Malcolm X")).toBe("malcolm x");
  expect(titleVariants("Marvel's The Avengers")).toContain("avengers");
  expect(titleVariants("From the World of John Wick: Ballerina")).toContain("ballerina");
});

test("director typos still match", () => {
  expect(directorsMatch(["Jon Turtletaub"], ["Jon Turteltaub"])).toBe(true);
  expect(directorsMatch(["Phil Alden Robison"], ["Phil Alden Robinson"])).toBe(true);
  expect(directorsMatch(["Toby L."], ["Toby L."])).toBe(true);
  expect(directorsMatch(["Kevin Lee"], ["Ang Lee"])).toBe(true); // surname-only by design; runtime/year break ties
  expect(directorsMatch(["Andrew Stanton"], ["Andrew Stone"])).toBe(false);
  // a surname that is the other director's first name is not a match
  expect(directorsMatch(["James Cameron"], ["Cameron Crowe"])).toBe(false);
  expect(directorsMatch(["Cameron Crowe"], ["James Cameron"])).toBe(false);
});

test("airline-edited runtime does not sink a director+year match", () => {
  const m = pickMatch({ cleanTitle: "The Shawshank Redemption", year: 1994, duration: 120, director: "Frank Darabont" },
    [cand("tt0111161", 1994, 142, ["Frank Darabont"], 3000000)], 2026);
  expect(m.confidence).toBe("high");
});

test("partial-title matches are downgraded one level", () => {
  const film = { cleanTitle: "Kantara: A Legend Chapter 1", year: null, duration: 166, director: "Rishab Shetty" };
  const kantara = [cand("tt15327088", 2022, 148, ["Rishab Shetty"], 119000)];
  expect(pickMatch(film, kantara, 2026, true).confidence).toBe("low");
});

test("James Cameron is not Cameron Crowe: no high-confidence match on runtime alone", () => {
  const m = pickMatch({ cleanTitle: "Billie Eilish - Hit Me Hard and Soft: The Tour", year: null, duration: 107, director: "James Cameron" },
    [cand("tt1", 2025, 107, ["Cameron Crowe"])], 2026);
  expect(m.confidence).toBe("low");
});
