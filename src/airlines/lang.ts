// Airline-specific ISO 639 codes that Intl does not know (or names too broadly)
const OVERRIDES: Record<string, string> = {
  cmn: "Mandarin", yue: "Cantonese", zhk: "Chinese (Hong Kong)", ptb: "Brazilian Portuguese", bpr: "Brazilian Portuguese",
  csp: "Castilian Spanish", lsp: "Latin American Spanish",
};
const names = new Intl.DisplayNames(["en"], { type: "language", fallback: "code" });

/** "eng" / "en" -> "English"; already-named languages pass through; unknown codes are returned as given. */
export function languageName(code: string): string {
  const c = code.trim();
  if (!/^[a-z]{2,3}$/i.test(c)) return c;
  const lower = c.toLowerCase();
  if (OVERRIDES[lower]) return OVERRIDES[lower];
  try { return names.of(lower) ?? c; } catch { return c; }
}
