// Director-name comparison. Pure (no DB), so the Worker shares it with the matcher and the ranker.
import { editDistance, normalizeTitle, surname } from "./text.ts";

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
