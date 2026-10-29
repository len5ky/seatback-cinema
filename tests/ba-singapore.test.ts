import { expect, test } from "bun:test";
import { parseBa, type BaRaw } from "../src/airlines/ba.ts";
import { krisLanguage, parseSingapore, type KrisRaw } from "../src/airlines/singapore.ts";
import { assertCurrentMonth } from "../src/airlines/http.ts";
import { adapters } from "../src/airlines/index.ts";
import baRaw from "./fixtures/ba-movies.json";
import krisRaw from "./fixtures/singapore-movies.json";

test("BA: 19 sections dedupe to 658 movies, editorial cards dropped (Oct 2026, research report)", () => {
  const raw = baRaw as BaRaw;
  expect(raw.sections.length).toBe(19);
  expect(raw.sections.some((s) => s.items.some((i) => i.type === "editorial"))).toBe(true);
  const films = adapters.ba!.parse(raw);
  expect(films.length).toBe(658);
  expect(new Set(films.map((f) => f.sourceId)).size).toBe(658);
  expect(films.every((f) => f.year && f.runtime)).toBe(true);
  expect(films.filter((f) => f.directors.length).length).toBe(653);
});

test("BA: field mapping and section categories", () => {
  const t = parseBa(baRaw as BaRaw).find((f) => f.title === "Toy Story 5")!;
  expect(t).toMatchObject({
    sourceId: "a33cc7ef-33f6-4623-ac0e-a9df44abbb80", year: 2026, runtime: 120, directors: ["Andrew Stanton"],
    cast: ["Actor 1", "Actor 2", "Actor 3"], genres: ["Adventure", "Animation", "Comedy", "Family"], rating: "PG",
    subtitles: ["Arabic", "Chinese"],
  });
  expect(t.languages.slice(0, 3)).toEqual(["English", "French", "German"]);
  expect(t.poster).toBeUndefined(); // fixture image URLs stripped
  expect(t.categories).toContain("Hollywood Arrivals");
  expect(t.categories.length).toBe(4);
});

test("Singapore: 1,152 keys dedupe to 384 movies", () => {
  const raw = krisRaw as KrisRaw;
  expect(Object.keys(raw).length).toBe(1152);
  const films = adapters.singapore!.parse(raw);
  expect(films.length).toBe(384);
  expect(films.every((f) => f.year && f.runtime)).toBe(true);
  expect(films.filter((f) => f.directors.length).length).toBe(381);
  expect(films.filter((f) => f.categories.includes("New")).length).toBe(59);
});

test("Singapore: field mapping", () => {
  const n = parseSingapore(krisRaw as KrisRaw).find((f) => f.sourceId === "m052683476")!;
  expect(n).toMatchObject({
    title: "Nobody", year: 2025, runtime: 118, directors: ["Yu Shui"], cast: ["Actor 1", "Actor 2", "Actor 3"],
    genres: ["Fantasy"], rating: "G", languages: ["Mandarin"], subtitles: ["English", "Chinese (Simplified)"],
    categories: ["Chinese 中文", "Kids & Family", "Leaving Soon"],
  });
  expect(krisLanguage("EnS / ChT")).toBe("EnS / ChT"); // split happens before mapping
  expect(krisLanguage("FreS")).toBe("French");
  expect(krisLanguage("EnAD")).toBe("English");
});

test("current-cycle-only sources refuse other months", () => {
  const now = new Date("2026-10-29T12:00:00Z");
  expect(() => assertCurrentMonth("ba", "2026-10", now)).not.toThrow();
  expect(() => assertCurrentMonth("ba", "2026-11", now)).toThrow("current cycle");
});
