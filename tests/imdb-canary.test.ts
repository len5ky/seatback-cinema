import { expect, test } from "bun:test";
import { checkImport } from "../scripts/imdb-canary.ts";

const imp = (o: Record<string, unknown> = {}) => ({ rated: 941, total_ratings: 941, degraded: false, notes: [], ...o });

test("healthy import passes", () => {
  expect(checkImport(200, { ok: true, cached: false, import: imp() })).toEqual({ ok: true, message: "ok: 941/941 ratings with scores, cached=false" });
});

test("scoreless import fails (degraded flag, zero rated, or a score-failure note)", () => {
  const note = "IMDb's score lookup failed, so some or all of these films count as seen without scores and taste ranking is weaker.";
  expect(checkImport(200, { ok: true, cached: false, import: imp({ rated: 0, degraded: true, notes: [note] }) }).ok).toBe(false);
  expect(checkImport(200, { ok: true, cached: false, import: imp({ rated: 0 }) }).ok).toBe(false);
  expect(checkImport(200, { ok: true, cached: false, import: imp({ notes: [note] }) }).message).toContain("score lookup failed");
  expect(checkImport(200, { ok: true, cached: false, import: imp({ rated: 0, total_ratings: 0 }) }).message).toBe("import returned no ratings");
});

test("error responses fail", () => {
  expect(checkImport(502, { ok: false, error: "challenged", message: "IMDb answered with a challenge" })).toEqual({
    ok: false, message: "import failed: HTTP 502 challenged IMDb answered with a challenge",
  });
  expect(checkImport(401, { ok: false, error: "unauthorized" }).ok).toBe(false);
  expect(checkImport(200, null).ok).toBe(false);
});
