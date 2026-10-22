const LEADING_ARTICLE = /^(the|a|an|le|la|les|el|los|las|il|der|die|das) /;
// v and x are left alone: "Malcolm X", "Rocky V" collide with letters more often than not
const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8", ix: "9" };

/** Lowercase, strip diacritics/punctuation and a leading article; collapse whitespace. */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(LEADING_ARTICLE, "")
    .replace(/\s+/g, " ")
    .replace(/\b(ii|iii|iv|vi|vii|viii|ix)\b/g, (r) => ROMAN[r] ?? r)
    .replace(/\bpart (\d+)\b/g, "$1");
}

/** Alternative titles to try when the catalogue title has no exact IMDb hit. */
export function titleVariants(title: string): string[] {
  const out = new Set<string>();
  const noPossessive = title.replace(/^[\p{L}. ]+['\u2019]s\s+/u, "");
  for (const t of [noPossessive, ...title.split(/:| - /)]) {
    const n = normalizeTitle(t);
    if (n.length >= 3 && n !== normalizeTitle(title)) out.add(n);
  }
  return [...out];
}

/** Levenshtein distance, early-exit above `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...cur) > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Last name token of a person name, normalised ("Steven Spielberg" -> "spielberg"). */
export function surname(name: string): string {
  const parts = normalizeTitle(name.replace(/\b(jr|sr|ii|iii)\.?$/i, "")).split(" ");
  return parts[parts.length - 1] ?? "";
}

/** Split a credit list like "Joey Palmroos, Austen Paul" or "A & B" into names. */
export function splitNames(s: string | null | undefined): string[] {
  if (!s) return [];
  return s.split(/,|&|\band\b|\//).map((n) => n.trim()).filter(Boolean);
}
