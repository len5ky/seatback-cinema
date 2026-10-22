const LEADING_ARTICLE = /^(the|a|an|le|la|les|el|los|las|il|der|die|das) /;

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
    .replace(/\s+/g, " ");
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
