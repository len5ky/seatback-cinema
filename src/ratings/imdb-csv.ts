// IMDb "Your Ratings" / "Watchlist" CSV parsing. Pure, shared by the CLI importer and the Worker.
import { parseCsv, parseCsvRows } from "../csv.ts";

export type ImdbExportKind = "ratings" | "watchlist";

/**
 * IMDb's "Your Ratings" and "Watchlist" exports both carry a Const column. Only the ratings one has Your Rating, except that
 * list exports (watchlist and custom lists: they start with Position) may add Your Rating and Date Rated too.
 */
export function detectImdbExport(text: string): ImdbExportKind | null {
  const nl = text.search(/\r?\n/);
  const header = (parseCsvRows(nl < 0 ? text : text.slice(0, nl))[0] ?? []).map((h) => h.trim());
  if (!header.includes("Const")) return null;
  return header.includes("Your Rating") && !header.includes("Position") ? "ratings" : "watchlist";
}

/** genres and directors are the export's own comma-separated columns (empty when absent). */
export interface ImdbFilm { tconst: string; title: string; year: number | null; titleType: string; rating: number | null; genres: string[]; directors: string[] }

/** Film-like title types; anything else (series, episodes, shorts, games) is still imported but counted as other. */
const FILM_TYPES = new Set(["movie", "tvmovie", "video", "tvspecial"]);
/** "TV Movie" (export display name) and "tvMovie" (dataset name) both normalise to "tvmovie". */
export const isFilmType = (t: string) => FILM_TYPES.has(t.toLowerCase().replace(/[^a-z]/g, ""));

const commaList = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** Rows with a valid tconst. Your Rating is IMDb's own 1-10 scale, kept as-is; out-of-range or blank becomes null. */
export function parseImdbExport(text: string): { kind: ImdbExportKind; films: ImdbFilm[]; skipped: number } {
  const kind = detectImdbExport(text);
  if (!kind) throw new Error("no Const column: is this an IMDb ratings or watchlist export? When you send a big file in parts, start every part with the file's header line.");
  const films: ImdbFilm[] = [];
  let skipped = 0;
  for (const r of parseCsv(text)) {
    const tconst = r.Const?.trim() ?? "";
    if (!/^tt\d+$/.test(tconst)) { skipped++; continue; }
    const n = Number(r["Your Rating"]);
    films.push({
      tconst, title: r.Title?.trim() || tconst, year: Number(r.Year) || null, titleType: r["Title Type"]?.trim() ?? "",
      rating: kind === "ratings" && r["Your Rating"]?.trim() && n >= 1 && n <= 10 ? n : null,
      genres: commaList(r.Genres), directors: commaList(r.Directors),
    });
  }
  return { kind, films, skipped };
}
