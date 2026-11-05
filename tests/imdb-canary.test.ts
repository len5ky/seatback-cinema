import { expect, test } from "bun:test";
import { checkImport } from "../scripts/imdb-canary.ts";

const imp = (o: Record<string, unknown> = {}) => ({ rated: 941, total_ratings: 941, degraded: false, notes: [], ...o });

test("healthy import passes", () => {
  expect(checkImport(200, { ok: true, cached: false, import: imp() })).toEqual({ ok: true, message: "ok: 941/941 ratings with scores" });
});

test("scoreless import fails (degraded flag, zero rated, or a score-failure note)", () => {
  const note = "IMDb's score lookup failed, so some or all of these films count as seen without scores and taste ranking is weaker.";
  expect(checkImport(200, { ok: true, cached: false, import: imp({ rated: 0, degraded: true, notes: [note] }) }).ok).toBe(false);
  expect(checkImport(200, { ok: true, cached: false, import: imp({ rated: 0 }) }).ok).toBe(false);
  expect(checkImport(200, { ok: true, cached: false, import: imp({ notes: [note] }) }).message).toContain("score lookup failed");
  expect(checkImport(200, { ok: true, cached: false, import: imp({ rated: 0, total_ratings: 0 }) }).message).toBe("import returned no ratings");
});

test("fails when under 80% of the ratings read have scores; a truncated profile counts only what was read", () => {
  expect(checkImport(200, { ok: true, cached: false, import: imp({ rated: 1 }) }).message).toBe(
    "ratings came back without scores (rated=1/941, need 80%, degraded=false)");
  expect(checkImport(200, { ok: true, cached: false, import: imp({ rated: 752 }) }).ok).toBe(false);
  expect(checkImport(200, { ok: true, cached: false, import: imp({ rated: 753 }) }).ok).toBe(true);
  const seen = Array.from({ length: 5000 }, (_, i) => `tt${i}`);
  expect(checkImport(200, { ok: true, cached: false, import: imp({ rated: 4990, total_ratings: 12000, profile: { seen } }) }).ok).toBe(true);
});

test("a cached answer fails: IMDb was not touched", () => {
  expect(checkImport(200, { ok: true, cached: true, import: imp() })).toEqual({
    ok: false, message: "import was answered from the Convex cache, so IMDb was not checked (is force: true deployed?)",
  });
  expect(checkImport(200, { ok: true, import: imp() }).ok).toBe(false);
});

test("error responses fail", () => {
  expect(checkImport(502, { ok: false, error: "challenged", message: "IMDb answered with a challenge" })).toEqual({
    ok: false, message: "import failed: HTTP 502 challenged IMDb answered with a challenge",
  });
  expect(checkImport(401, { ok: false, error: "unauthorized" }).ok).toBe(false);
  expect(checkImport(200, null).ok).toBe(false);
});
