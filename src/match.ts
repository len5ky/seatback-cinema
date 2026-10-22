import { Database } from "bun:sqlite";
import { normalizeTitle, splitNames, surname } from "./text.ts";

export type Confidence = "high" | "medium" | "low" | "none";
export interface FilmInfo { cleanTitle: string; year: number | null; duration: number | null; director: string | null }
export interface Candidate {
  tconst: string; primaryTitle: string; startYear: number | null; runtime: number | null;
  votes: number | null; directorNames: string[];
}
export interface Scored { candidate: Candidate; score: number; strong: number; contradictions: number; reasons: string[] }
export interface MatchResult { tconst: string | null; confidence: Confidence; score: number; reasons: string[] }

const tokens = (name: string) => new Set(normalizeTitle(name).split(" ").filter((t) => t.length >= 2));

/** Directors agree if either side's surname appears among the other side's name tokens (handles "Gam-sung Pil" vs "Pil Gam-sung"). */
export function directorsMatch(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => tokens(y).has(surname(x)) || tokens(x).has(surname(y))));
}

export function scoreCandidate(film: FilmInfo, c: Candidate, nowYear: number): Scored {
  let score = 0, strong = 0, contradictions = 0;
  const reasons: string[] = [];
  if (film.duration && c.runtime) {
    const d = Math.abs(film.duration - c.runtime);
    if (d <= 3) { score += 3; strong++; reasons.push(`runtime ${c.runtime}~${film.duration}`); }
    else if (d <= 10) { score += 1; reasons.push(`runtime ${c.runtime} near ${film.duration}`); }
    else if (d > 15 && d / film.duration > 0.12) { score -= 3; contradictions++; reasons.push(`runtime ${c.runtime} vs ${film.duration}`); }
  }
  const ours = splitNames(film.director);
  if (ours.length && c.directorNames.length) {
    if (directorsMatch(ours, c.directorNames)) { score += 4; strong++; reasons.push(`director ${c.directorNames.join(", ")}`); }
    else { score -= 2; contradictions++; reasons.push(`director ${c.directorNames.join(", ")} != ${film.director}`); }
  }
  if (film.year && c.startYear) {
    const d = Math.abs(film.year - c.startYear);
    if (d === 0) { score += 4; strong++; reasons.push(`year ${c.startYear}`); }
    else if (d === 1) { score += 2; strong++; reasons.push(`year ${c.startYear}~${film.year}`); }
    else { score -= 4; contradictions++; reasons.push(`year ${c.startYear} vs ${film.year}`); }
  }
  if (strong === 0 && c.startYear && c.startYear >= nowYear - 3) { score += 1; reasons.push(`recent ${c.startYear}`); }
  score += 0.25 * Math.log10((c.votes ?? 0) + 1);
  return { candidate: c, score, strong, contradictions, reasons };
}

const DOWNGRADE: Record<Confidence, Confidence> = { high: "medium", medium: "low", low: "low", none: "none" };

/** Pick the best candidate and grade it. Low means "plausible but unverified": never used for ranking. */
export function pickMatch(film: FilmInfo, candidates: Candidate[], nowYear = new Date().getFullYear()): MatchResult {
  if (!candidates.length) return { tconst: null, confidence: "none", score: 0, reasons: ["no IMDb title with this name"] };
  const ranked = candidates.map((c) => scoreCandidate(film, c, nowYear)).sort((a, b) => b.score - a.score);
  const best = ranked[0]!;
  const runner = ranked[1];
  let confidence: Confidence =
    best.contradictions > 0 ? "low" : best.strong >= 2 ? "high" : best.strong === 1 ? "medium" : "low";
  const reasons = [...best.reasons];
  if (runner && runner.strong >= best.strong && best.score - runner.score < 1) {
    confidence = DOWNGRADE[confidence];
    reasons.push(`ambiguous with ${runner.candidate.tconst}`);
  }
  return { tconst: best.candidate.tconst, confidence, score: Math.round(best.score * 100) / 100, reasons };
}

interface CandRow { tconst: string; primary_title: string; start_year: number | null; runtime: number | null; votes: number | null; directors: string | null }

export function findCandidates(db: Database, title: string): Candidate[] {
  const rows = db.query<CandRow, [string]>(
    "SELECT t.tconst, t.primary_title, t.start_year, t.runtime, t.votes, t.directors FROM imdb_keys k JOIN imdb_titles t USING (tconst) WHERE k.norm = ?",
  ).all(normalizeTitle(title));
  const nameQ = db.query<{ name: string }, [string]>("SELECT name FROM imdb_names WHERE nconst = ?");
  return rows.map((r) => ({
    tconst: r.tconst, primaryTitle: r.primary_title, startYear: r.start_year, runtime: r.runtime, votes: r.votes,
    directorNames: (r.directors?.split(",") ?? []).map((n) => nameQ.get(n)?.name).filter((n): n is string => !!n),
  }));
}

/** Match every film of an airline (all snapshots) against IMDb and store the results. */
export function matchAll(db: Database, airline = "emirates"): Record<Confidence, number> {
  const films = db.query<{ track_list: string; clean_title: string; year: number | null; duration: number | null; director: string | null }, [string]>(
    // bare columns come from the MAX(month) row (SQLite min/max semantics)
    "SELECT track_list, clean_title, year, duration, director, MAX(month) AS month FROM movies WHERE airline = ? GROUP BY track_list",
  ).all(airline);
  const ins = db.prepare("INSERT OR REPLACE INTO matches VALUES (?,?,?,?,?,?,?)");
  const counts: Record<Confidence, number> = { high: 0, medium: 0, low: 0, none: 0 };
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const f of films) {
      const m = pickMatch({ cleanTitle: f.clean_title, year: f.year, duration: f.duration, director: f.director }, findCandidates(db, f.clean_title));
      counts[m.confidence]++;
      ins.run(airline, f.track_list, m.tconst, m.confidence, m.score, m.reasons.join("; "), now);
    }
  })();
  return counts;
}
