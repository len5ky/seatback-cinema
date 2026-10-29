import { Database } from "bun:sqlite";
import { editDistance, normalizeTitle, splitNames, splitYearSuffix, surname, titleVariants, truncatedPrefix } from "./text.ts";

export type Confidence = "high" | "medium" | "low" | "none";
export interface FilmInfo { cleanTitle: string; year: number | null; duration: number | null; director: string | null }
export interface Candidate {
  tconst: string; primaryTitle: string; startYear: number | null; runtime: number | null;
  votes: number | null; directorNames: string[];
}
/** strong = confirming signals; hard = director or year disagreement (runtime disagreement only costs score: airlines edit films). */
export interface Scored { candidate: Candidate; score: number; strong: number; hard: number; reasons: string[] }
export interface MatchResult { tconst: string | null; confidence: Confidence; score: number; reasons: string[] }

const tokens = (name: string) => new Set(normalizeTitle(name).split(" ").filter((t) => t.length >= 2));

/** Surnames close (typo-tolerant: "Turtletaub"/"Turteltaub"), or the same name in another order ("Gam-sung Pil"/"Pil Gam-sung"). */
function sameDirector(x: string, y: string): boolean {
  const a = surname(x), b = surname(y);
  const tol = Math.min(a.length, b.length) >= 6 ? 2 : Math.min(a.length, b.length) >= 4 ? 1 : 0;
  if (a && (a === b || (tol > 0 && editDistance(a, b, tol) <= tol))) return true;
  const tx = [...tokens(x)].sort().join(" ");
  return tx !== "" && tx === [...tokens(y)].sort().join(" ");
}

export function directorsMatch(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => normalizeTitle(x) === normalizeTitle(y) || sameDirector(x, y)));
}

export function scoreCandidate(film: FilmInfo, c: Candidate, nowYear: number): Scored {
  let score = 0, strong = 0, hard = 0;
  const reasons: string[] = [];
  if (film.duration && c.runtime) {
    const d = Math.abs(film.duration - c.runtime);
    if (d <= 3) { score += 3; strong++; reasons.push(`runtime ${c.runtime}~${film.duration}`); }
    else if (d <= 10) { score += 1; reasons.push(`runtime ${c.runtime} near ${film.duration}`); }
    else if (d > 15 && d / film.duration > 0.12) { score -= 3; reasons.push(`runtime ${c.runtime} vs ${film.duration}`); }
  }
  const ours = splitNames(film.director);
  if (ours.length && c.directorNames.length) {
    if (directorsMatch(ours, c.directorNames)) { score += 4; strong++; reasons.push(`director ${c.directorNames.join(", ")}`); }
    else { score -= 2; hard++; reasons.push(`director ${c.directorNames.join(", ")} != ${film.director}`); }
  }
  if (film.year && c.startYear) {
    const d = Math.abs(film.year - c.startYear);
    if (d === 0) { score += 4; strong++; reasons.push(`year ${c.startYear}`); }
    else if (d === 1) { score += 2; strong++; reasons.push(`year ${c.startYear}~${film.year}`); }
    else { score -= 4; hard++; reasons.push(`year ${c.startYear} vs ${film.year}`); }
  }
  if (strong === 0 && c.startYear && c.startYear >= nowYear - 3) { score += 1; reasons.push(`recent ${c.startYear}`); }
  score += 0.25 * Math.log10((c.votes ?? 0) + 1);
  return { candidate: c, score, strong, hard, reasons };
}

const DOWNGRADE: Record<Confidence, Confidence> = { high: "medium", medium: "low", low: "low", none: "none" };

/** Pick the best candidate and grade it. Low means "plausible but unverified": never used for ranking. */
export function pickMatch(film: FilmInfo, candidates: Candidate[], nowYear = new Date().getFullYear(), viaVariant = false): MatchResult {
  if (!candidates.length) return { tconst: null, confidence: "none", score: 0, reasons: ["no IMDb title with this name"] };
  const ranked = candidates.map((c) => scoreCandidate(film, c, nowYear)).sort((a, b) => b.score - a.score);
  const best = ranked[0]!;
  const runner = ranked[1];
  const net = best.strong - best.hard;
  let confidence: Confidence = best.hard === 0 && net >= 2 ? "high" : net >= 1 ? "medium" : "low";
  const reasons = [...best.reasons];
  if (runner && runner.strong >= best.strong && best.score - runner.score < 1) {
    confidence = DOWNGRADE[confidence];
    reasons.push(`ambiguous with ${runner.candidate.tconst}`);
  }
  if (viaVariant) {
    // a title fragment ("Kantara" for "Kantara: Chapter 1") often names the franchise, not the film
    confidence = DOWNGRADE[confidence];
    reasons.push(`via partial title "${best.candidate.primaryTitle}"`);
  }
  return { tconst: best.candidate.tconst, confidence, score: Math.round(best.score * 100) / 100, reasons };
}

interface CandRow { tconst: string; primary_title: string; start_year: number | null; runtime: number | null; votes: number | null; directors: string | null }

export function findCandidates(db: Database, title: string): { candidates: Candidate[]; viaVariant: boolean } {
  const q = db.query<CandRow, [string]>(
    "SELECT DISTINCT t.tconst, t.primary_title, t.start_year, t.runtime, t.votes, t.directors FROM imdb_keys k JOIN imdb_titles t USING (tconst) WHERE k.norm = ?");
  let rows = q.all(normalizeTitle(title));
  const viaVariant = !rows.length;
  if (viaVariant) {
    const seen = new Set<string>();
    rows = titleVariants(title).flatMap((v) => q.all(v)).filter((r) => !seen.has(r.tconst) && !!seen.add(r.tconst));
    const prefix = truncatedPrefix(title);
    if (prefix) {
      // index range scan over normalised titles starting with the prefix; year/director must then confirm
      rows.push(...db.query<CandRow, [string, string]>(
        `SELECT DISTINCT t.tconst, t.primary_title, t.start_year, t.runtime, t.votes, t.directors FROM imdb_keys k JOIN imdb_titles t USING (tconst)
         WHERE k.norm >= ? AND k.norm < ? LIMIT 200`).all(prefix, `${prefix}\uffff`).filter((r) => !seen.has(r.tconst) && !!seen.add(r.tconst)));
    }
  }
  const nameQ = db.query<{ name: string }, [string]>("SELECT name FROM imdb_names WHERE nconst = ?");
  const candidates = rows.map((r) => ({
    tconst: r.tconst, primaryTitle: r.primary_title, startYear: r.start_year, runtime: r.runtime, votes: r.votes,
    directorNames: (r.directors?.split(",") ?? []).map((n) => nameQ.get(n)?.name).filter((n): n is string => !!n),
  }));
  return { candidates, viaVariant: viaVariant && candidates.length > 0 };
}

interface FilmRow { source_id: string; title: string; year: number | null; runtime: number | null; directors: string | null; imdb_id: string | null }

/** Match every film of one airline (or all airlines) against IMDb and store the results. An airline-provided IMDb id is trusted when IMDb knows it. */
export function matchAll(db: Database, airline?: string): Record<Confidence, number> {
  const films = db.query<FilmRow & { airline: string }, [string | null, string | null]>(
    // bare columns come from the MAX(month) row (SQLite min/max semantics)
    `SELECT airline, source_id, title, year, runtime, directors, imdb_id, MAX(month) AS month FROM movies
     WHERE (? IS NULL OR airline = ?) GROUP BY airline, source_id`,
  ).all(airline ?? null, airline ?? null);
  const known = db.query<{ tconst: string }, [string]>("SELECT tconst FROM imdb_titles WHERE tconst = ?");
  const ins = db.prepare("INSERT OR REPLACE INTO matches VALUES (?,?,?,?,?,?,?)");
  const counts: Record<Confidence, number> = { high: 0, medium: 0, low: 0, none: 0 };
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const f of films) {
      let m: MatchResult;
      if (f.imdb_id && known.get(f.imdb_id)) m = { tconst: f.imdb_id, confidence: "high", score: 100, reasons: ["airline-provided IMDb id"] };
      else {
        const t = splitYearSuffix(f.title); // adapters without their own split ("The Breadwinner (2026)")
        const { candidates, viaVariant } = findCandidates(db, t.title);
        m = pickMatch({ cleanTitle: t.title, year: f.year ?? t.year ?? null, duration: f.runtime, director: f.directors }, candidates, undefined, viaVariant);
      }
      counts[m.confidence]++;
      ins.run(f.airline, f.source_id, m.tconst, m.confidence, m.score, m.reasons.join("; "), now);
    }
  })();
  return counts;
}
