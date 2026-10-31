// profile_from_letterboxd on a synthetic feed in Letterboxd's RSS shape (no live fetch).
import { expect, test } from "bun:test";
import type { Bundle } from "../src/bundle.ts";
import { Catalogue } from "../worker/src/catalogue.ts";
import { LATEST_ONLY_NOTE, parseLetterboxdRss, parseLetterboxdUser, RSS_LIMIT } from "../worker/src/letterboxd.ts";
import { callTool, ToolError, type ProfileStore, type ToolContext } from "../worker/src/tools.ts";

const rss = await Bun.file(`${import.meta.dir}/fixtures/letterboxd/rss.xml`).text();
const bundle = (await Bun.file(`${import.meta.dir}/../worker/test/fixtures/catalogue.sample.json`).json()) as Bundle;
const catalogue = new Catalogue(bundle);
const store: ProfileStore = { async get() { return null; }, async put() {} };

function ctxServing(res: () => Response) {
  const urls: string[] = [];
  const ctx: ToolContext = { catalogue, profiles: store, web: async (url) => { urls.push(url); return res(); } };
  return { ctx, urls };
}

test("parseLetterboxdRss: film entries only, entities and CDATA decoded, stars doubled", () => {
  const e = parseLetterboxdRss(rss);
  expect(e.map((x) => x.title)).toEqual(["Sinners", "Barbie", "Tom & Jerry: The Movie", "Weapons", "Sinners"]);
  expect(e[0]).toEqual({ title: "Sinners", year: 2025, rating: 9, tmdb: 1233413, slug: "sinners-2025" });
  expect(e[2]!.rating).toBeNull();
  expect(e[4]!.slug).toBe("sinners-2025");
});

test("parseLetterboxdRss stops at 50 entries", () => {
  const item = (i: number) => `<item><link>https://letterboxd.com/u/film/f${i}/</link><letterboxd:filmTitle>Film ${i}</letterboxd:filmTitle><letterboxd:filmYear>2020</letterboxd:filmYear></item>`;
  const xml = `<rss><channel>${Array.from({ length: 60 }, (_, i) => item(i)).join("")}</channel></rss>`;
  expect(parseLetterboxdRss(xml).length).toBe(RSS_LIMIT);
});

test("parseLetterboxdUser takes a username or a profile link, not other paths", () => {
  expect(parseLetterboxdUser("Dave")).toBe("dave");
  expect(parseLetterboxdUser("@some_one")).toBe("some_one");
  expect(parseLetterboxdUser("https://letterboxd.com/dave/films/ratings/")).toBe("dave");
  expect(parseLetterboxdUser("letterboxd.com/dave")).toBe("dave");
  expect(parseLetterboxdUser("https://letterboxd.com/film/barbie/")).toBeNull();
  expect(parseLetterboxdUser("https://evil.example/letterboxd.com/dave/")).toBeNull();
  expect(parseLetterboxdUser("a b")).toBeNull();
});

test("profile_from_letterboxd: TMDB id first, then the film slug, then title and year; newest rating wins", async () => {
  const { ctx, urls } = ctxServing(() => new Response(rss, { headers: { "content-type": "application/rss+xml" } }));
  const r = await callTool(ctx, "profile_from_letterboxd", { username: "https://letterboxd.com/TestMember/" });
  expect(urls).toEqual(["https://letterboxd.com/testmember/rss/"]);
  expect(r).toMatchObject({ username: "testmember", entries: 5, rated: 3, matched: 3, note: LATEST_ONLY_NOTE });
  expect(r.profile).toEqual({
    seen: ["tt31193180", "tt1517268", "Tom & Jerry: The Movie (2021)", "tt26581740"],
    ratings: { tt31193180: 9, tt1517268: 6, tt26581740: 8 },
    source: "letterboxd_rss",
  });
  expect(String(r.note)).toContain("latest 50");
  const picks = await callTool(ctx, "picks", { airline: "emirates", profile: r.profile });
  expect(picks.profile_source).toBe("letterboxd_rss");
  expect((picks.picks as { imdbId: string }[]).some((p) => ["tt31193180", "tt26581740"].includes(p.imdbId))).toBe(false);
});

test("profile_from_letterboxd: unknown member, a challenge and an empty diary say what to do next", async () => {
  const fails = async (res: () => Response) => {
    const e = await callTool(ctxServing(res).ctx, "profile_from_letterboxd", { username: "dave" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ToolError);
    return (e as Error).message;
  };
  expect(await fails(() => new Response("", { status: 404 }))).toContain("no Letterboxd member");
  expect(await fails(() => new Response("", { status: 403, headers: { "cf-mitigated": "challenge" } }))).toContain("seen check");
  expect(await fails(() => new Response("<html>Just a moment</html>"))).toContain("isn't a feed");
  expect(await fails(() => new Response("<rss><channel></channel></rss>"))).toContain("empty");
  await expect(callTool(ctxServing(() => new Response(rss)).ctx, "profile_from_letterboxd", { username: "" })).rejects.toThrow(/username is required/);
});
