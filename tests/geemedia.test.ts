import { expect, test } from "bun:test";
import { parseAirtime, type AirtimeTree } from "../src/airlines/platforms/geemedia.ts";
import { adapters } from "../src/airlines/index.ts";
import { languageName } from "../src/airlines/lang.ts";
import unitedRaw from "./fixtures/united-movies.json";
import klmRaw from "./fixtures/klm-movies.json";

const placements = (t: AirtimeTree) => {
  let n = 0;
  const walk = (x: { template?: string | null; child_items?: unknown[] | null }) => {
    if (x.template === "movie") n++;
    for (const c of (x.child_items ?? []) as typeof x[]) walk(c);
  };
  t.items.forEach(walk);
  return n;
};

test("United: 720 carousel placements dedupe to 508 movies (Oct 2026, research report)", () => {
  const raw = unitedRaw as AirtimeTree;
  expect(placements(raw)).toBe(720);
  const films = adapters.united!.parse(raw);
  expect(films.length).toBe(508);
  expect(new Set(films.map((f) => f.sourceId)).size).toBe(508);
  expect(films.every((f) => f.year && f.runtime && f.genres.length)).toBe(true);
  expect(films.filter((f) => f.directors.length).length).toBe(504);
});

test("United: field mapping", () => {
  const b = parseAirtime(unitedRaw as AirtimeTree).find((f) => f.sourceId === "24096987")!;
  expect(b).toMatchObject({
    title: "Backrooms", year: 2026, runtime: 110, directors: ["Kane Parsons"],
    cast: ["Chiwetel Ejiofor", "Renate Reinsve", "Mark Duplass"], genres: ["Thriller", "Drama"], rating: "R",
    languages: ["English", "French", "Italian", "Spanish"], subtitles: ["Arabic", "Chinese", "Korean", "English", "Castilian Spanish"],
  });
  expect(b.poster).toStartWith("https://");
  expect(b.synopsis).toStartWith("When a furniture salesman");
  // placed in three carousels; categories are carousel titles, not the root "Movies" section
  expect(b.categories.length).toBe(3);
  expect(b.categories).toContain("New releases");
  expect(b.categories).not.toContain("Movies");
});

test("KLM: 614 placements dedupe to 474 movies", () => {
  const raw = klmRaw as AirtimeTree;
  expect(placements(raw)).toBe(614);
  const films = adapters.klm!.parse(raw);
  expect(films.length).toBe(474);
  expect(films.filter((f) => f.directors.length).length).toBe(472);
  expect(films.find((f) => f.sourceId === "24109897")).toMatchObject({
    title: "Disclosure Day", year: 2026, runtime: 145, directors: ["Steven Spielberg"], genres: ["Sci-Fi", "Thriller"], rating: "PG13",
    languages: ["English", "German", "Italian", "Latin American Spanish", "Brazilian Portuguese", "Japanese", "Russian"],
  });
});

test("Anuvu variant: release_date gives the year when year is missing", () => {
  const films = parseAirtime({ items: [{ id: 1, template: "section", title: "Classics", child_items: [
    { id: 7, template: "movie", title: "Hard Boiled", release_date: "1992-07-28", duration_minute: 128, director_list: "John Woo" },
    { id: 7, template: "movie", title: "Hard Boiled" },
  ] }] });
  expect(films).toEqual([expect.objectContaining({ sourceId: "7", year: 1992, runtime: 128, directors: ["John Woo"], categories: ["Classics"] })]);
});

test("language codes", () => {
  expect(languageName("eng")).toBe("English");
  expect(languageName("cmn")).toBe("Mandarin");
  expect(languageName("ptb")).toBe("Brazilian Portuguese");
  expect(languageName("English")).toBe("English");
  expect(languageName("xqz")).toBe("xqz");
});
