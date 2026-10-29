import { Database } from "bun:sqlite";
import { editDistance, normalizeTitle, splitNames, splitYearSuffix, surname, titleVariants, truncatedPrefix } from "./text.ts";

export type Confidence = "high" | "medium" | "low" | "none";
export interface FilmInfo { cleanTitle: string; year: number | null; duration: number | null; director: string | null }
export interface Candidate {
  tconst: string; primaryTitle: string; startYear: number | null; runtime: number | null;
  votes: number | null; directorNames: string[];
}
/** strong = confirming signals; hard = director or year disagreement (runtime disagreement only costs score: airlines edit films);
 *  otherDirector = both sides name a director and they are not the same person (a shared surname included). */
export interface Scored { candidate: Candidate; score: number; strong: number; hard: number; yearGap: number | null; otherDirector: boolean; reasons: string[] }
export interface MatchResult { tconst: string | null; confidence: Confidence; score: number; reasons: string[] }

const tokens = (name: string) => new Set(normalizeTitle(name).split(" ").filter((t) => t.length >= 2));

/** Surnames close (typo-tolerant: "Turtletaub"/"Turteltaub"), or the same name in another order ("Gam-sung Pil"/"Pil Gam-sung"). */
function sameSurname(x: string, y: string): boolean {
  const a = surname(x), b = surname(y);
  const tol = Math.min(a.length, b.length) >= 6 ? 2 : Math.min(a.length, b.length) >= 4 ? 1 : 0;
  return !!a && (a === b || (tol > 0 && editDistance(a, b, tol) <= tol));
}
const sameTokens = (x: string, y: string) => {
  const tx = [...tokens(x)].sort().join(" ");
  return tx !== "" && tx === [...tokens(y)].sort().join(" ");
};
/** Given names agree when either is missing or an initial, one extends the other ("Steve"/"Steven"), or they differ by a typo. */
function sameGivenName(x: string, y: string): boolean {
  const a = normalizeTitle(x).split(" "), b = normalizeTitle(y).split(" ");
  if (a.length < 2 || b.length < 2) return true;
  const fa = a[0]!, fb = b[0]!;
  if (fa.length === 1 || fb.length === 1) return fa[0] === fb[0];
  return fa.startsWith(fb) || fb.startsWith(fa) || editDistance(fa, fb, 1) <= 1;
}

export type DirectorAgreement = "full" | "surname" | "none";

/** "full": the same person; "surname": only the family name agrees ("Kevin Lee"/"Ang Lee"), which is no evidence either way. */
export function directorAgreement(a: string[], b: string[]): DirectorAgreement {
  let best: DirectorAgreement = "none";
  for (const x of a) for (const y of b) {
    if (normalizeTitle(x) === normalizeTitle(y) || sameTokens(x, y)) return "full";
    if (sameSurname(x, y)) {
      if (sameGivenName(x, y)) return "full";
      best = "surname";
    }
  }
  return best;
}

export const directorsMatch = (a: string[], b: string[]): boolean => directorAgreement(a, b) === "full";

export function scoreCandidate(film: FilmInfo, c: Candidate, nowYear: number): Scored {
  let score = 0, strong = 0, hard = 0;
  let yearGap: number | null = null;
  let otherDirector = false;
  const reasons: string[] = [];
  if (film.duration && c.runtime) {
    const d = Math.abs(film.duration - c.runtime);
    if (d <= 3) { score += 3; strong++; reasons.push(`runtime ${c.runtime}~${film.duration}`); }
    else if (d <= 10) { score += 1; reasons.push(`runtime ${c.runtime} near ${film.duration}`); }
    else if (d > 15 && d / film.duration > 0.12) { score -= 3; reasons.push(`runtime ${c.runtime} vs ${film.duration}`); }
  }
  const ours = splitNames(film.director);
  if (ours.length && c.directorNames.length) {
    const agree = directorAgreement(ours, c.directorNames);
    otherDirector = agree !== "full";
    if (agree === "full") { score += 4; strong++; reasons.push(`director ${c.directorNames.join(", ")}`); }
    else if (agree === "surname") reasons.push(`director ${c.directorNames.join(", ")} shares only a surname with ${film.director}`);
    else { score -= 2; hard++; reasons.push(`director ${c.directorNames.join(", ")} != ${film.director}`); }
  }
  if (film.year && c.startYear) {
    yearGap = Math.abs(film.year - c.startYear);
    // an exact year confirms; one year off (festival vs release) only hints; more is a different film
    if (yearGap === 0) { score += 4; strong++; reasons.push(`year ${c.startYear}`); }
    else if (yearGap === 1) { score += 1; reasons.push(`year ${c.startYear}~${film.year}`); }
    else { score -= 4; hard++; reasons.push(`year ${c.startYear} vs ${film.year}`); }
  }
  if (strong === 0 && c.startYear && c.startYear >= nowYear - 3) { score += 1; reasons.push(`recent ${c.startYear}`); }
  score += 0.25 * Math.log10((c.votes ?? 0) + 1);
  return { candidate: c, score, strong, hard, yearGap, otherDirector, reasons };
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
  if (best.yearGap !== null && best.yearGap > 1) {
    // a release year more than a year away is a different film however well the rest agrees
    confidence = "low";
  } else if (runner && runner.strong >= best.strong && best.score - runner.score < 1) {
    confidence = DOWNGRADE[confidence];
    reasons.push(`ambiguous with ${runner.candidate.tconst}`);
  } else if (best.yearGap === 1) {
    const exact = ranked.find((r) => r.yearGap === 0);
    if (exact) {
      confidence = DOWNGRADE[confidence];
      reasons.push(`${exact.candidate.tconst} has the exact year`);
    }
  }
  if (best.otherDirector && confidence === "high") {
    // year and runtime alone cannot make a film by someone else a sure match ("Spike Lee" for Ang Lee's "Hero")
    confidence = "medium";
    reasons.push("director differs");
  }
  if (viaVariant) {
    // a title fragment ("Kantara" for "Kantara: Chapter 1") often names the franchise, not the film
    confidence = DOWNGRADE[confidence];
    reasons.push(`via partial title "${best.candidate.primaryTitle}"`);
  }
  return { tconst: best.candidate.tconst, confidence, score: Math.round(best.score * 100) / 100, reasons };
}

interface CandRow { tconst: string; primary_title: string; start_year: number | null; runtime: number | null; votes: number | null; directors: string | null }

/** IMDb titles for an airline title: exact normalised keys, then title variants, then a truncated-title fragment. The fragment
 *  search can hit hundreds of titles, so it is narrowed to the airline's year (±1) and runtime (±15 min) when known. */
export function findCandidates(db: Database, title: string, hint: { year?: number | null; runtime?: number | null } = {}): { candidates: Candidate[]; viaVariant: boolean } {
  const q = db.query<CandRow, [string]>(
    "SELECT DISTINCT t.tconst, t.primary_title, t.start_year, t.runtime, t.votes, t.directors FROM imdb_keys k JOIN imdb_titles t USING (tconst) WHERE k.norm = ?");
  let rows = q.all(normalizeTitle(title));
  const viaVariant = !rows.length;
  if (viaVariant) {
    const seen = new Set<string>();
    rows = titleVariants(title).flatMap((v) => q.all(v)).filter((r) => !seen.has(r.tconst) && !!seen.add(r.tconst));
    const frag = truncatedPrefix(title);
    if (frag) {
      // a chopped title may have lost its head too ("The Desolation Of ..." for "The Hobbit: The Desolation of Smaug"),
      // so match the fragment at any word start; short fragments only as a prefix. Year/director must then confirm.
      // a year more than one off caps the match at low anyway; an IMDb row without a year or runtime stays in
      const cols = `SELECT DISTINCT t.tconst, t.primary_title, t.start_year, t.runtime, t.votes, t.directors FROM imdb_keys k JOIN imdb_titles t USING (tconst)
        WHERE (?1 IS NULL OR t.start_year IS NULL OR t.start_year BETWEEN ?1 - 1 AND ?1 + 1)
          AND (?2 IS NULL OR t.runtime IS NULL OR t.runtime BETWEEN ?2 - 15 AND ?2 + 15)`;
      const y = hint.year ?? null, rt = hint.runtime || null;
      const found = frag.length >= 8
        ? db.query<CandRow, [number | null, number | null, string]>(`${cols} AND (' ' || k.norm) LIKE ?3 ORDER BY t.votes DESC LIMIT 2000`).all(y, rt, `% ${frag}%`) // full scan; rare
        : db.query<CandRow, [number | null, number | null, string, string]>(`${cols} AND k.norm >= ?3 AND k.norm < ?4 ORDER BY t.votes DESC LIMIT 2000`).all(y, rt, frag, `${frag}\uffff`);
      rows.push(...found
        .filter((r) => !seen.has(r.tconst) && !!seen.add(r.tconst)));
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
        const year = f.year ?? t.year ?? null;
        const { candidates, viaVariant } = findCandidates(db, t.title, { year, runtime: f.runtime });
        m = pickMatch({ cleanTitle: t.title, year, duration: f.runtime, director: f.directors }, candidates, undefined, viaVariant);
      }
      counts[m.confidence]++;
      ins.run(f.airline, f.source_id, m.tconst, m.confidence, m.score, m.reasons.join("; "), now);
    }
  })();
  return counts;
}
