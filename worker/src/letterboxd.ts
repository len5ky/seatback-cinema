// A Letterboxd member's public RSS feed (https://letterboxd.com/<user>/rss/): the latest 50 diary entries, with star
// ratings and TMDB ids. Letterboxd's film pages answer cloud IPs with a challenge; the feed does not (probed 2026-10-31).
import { titleKey, type Profile } from "./profile.ts";

export const RSS_LIMIT = 50;
export const LATEST_ONLY_NOTE =
  "This covers only the latest 50 diary entries in the member's public Letterboxd feed; films logged before those are not in it. " +
  "Expect some films they have seen to show up in picks: ask which of the top picks they've seen and pass those as seen too.";

/** A username, or any letterboxd.com/<user>/... URL. Letterboxd usernames are letters, digits and underscores. */
export function parseLetterboxdUser(input: string): string | null {
  const s = input.trim().replace(/^@/, "");
  const m = s.match(/^([A-Za-z0-9_]{2,40})$/) ?? s.match(/^(?:https?:\/\/)?(?:www\.)?letterboxd\.com\/([A-Za-z0-9_]{2,40})(?:[/?#]|$)/i);
  const user = m?.[1]?.toLowerCase();
  return user && !["film", "films", "list", "lists", "rss", "search", "settings", "members"].includes(user) ? user : null;
}

/** How the feed's films map to profile keys: TMDB id or film slug to a tconst when the catalogue knows it. */
export interface LetterboxdResolver { tmdb(id: number): string | null; slug(slug: string): string | null }

export interface RssEntry { title: string; year: number | null; rating: number | null; tmdb: number | null; slug: string | null }

const decode = (s: string) => s
  .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
  .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  .trim();

/** Diary entries in feed order (newest first). Items without a film (lists) are skipped. */
export function parseLetterboxdRss(xml: string): RssEntry[] {
  const out: RssEntry[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1]!;
    const tag = (name: string) => { const t = item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]; return t === undefined ? null : decode(t); };
    const title = tag("letterboxd:filmTitle");
    if (!title) continue;
    const year = Number(tag("letterboxd:filmYear")) || null;
    const stars = Number(tag("letterboxd:memberRating"));
    const tmdb = Number(tag("tmdb:movieId")) || null;
    const slug = tag("link")?.match(/letterboxd\.com\/[^/]+\/film\/([a-z0-9-]+)\//)?.[1] ?? null;
    out.push({ title, year, rating: stars > 0 && stars <= 5 ? stars * 2 : null, tmdb, slug });
    if (out.length >= RSS_LIMIT) break;
  }
  return out;
}

export interface LetterboxdProfile { profile: Profile; entries: number; rated: number; matched: number }

/** Seen list and ratings from the feed; the newest rating of a rewatched film wins. Keys: tconst, else "Title (Year)". */
export function profileFromRss(entries: RssEntry[], r: LetterboxdResolver): LetterboxdProfile {
  const seen: string[] = [], ratings: Record<string, number> = {};
  let matched = 0;
  for (const e of entries) {
    const id = (e.tmdb !== null ? r.tmdb(e.tmdb) : null) ?? (e.slug ? r.slug(e.slug) : null);
    const key = id ?? titleKey(e.title, e.year);
    if (!seen.includes(key)) { seen.push(key); if (id) matched++; }
    if (e.rating !== null && ratings[key] === undefined) ratings[key] = e.rating;
  }
  return {
    profile: { seen, ...(Object.keys(ratings).length ? { ratings } : {}), source: "letterboxd_rss" },
    entries: entries.length, rated: Object.keys(ratings).length, matched,
  };
}

export class LetterboxdError extends Error {}

const UA = "Mozilla/5.0 (compatible; SeatbackCinema/1.0; +https://seatback.len5ky.com)";

/** Fetch and parse one member's feed. Errors say what to do next. */
export async function fetchLetterboxd(
  fetcher: (url: string, init: RequestInit) => Promise<Response>, user: string, r: LetterboxdResolver,
): Promise<LetterboxdProfile> {
  let res: Response;
  try {
    res = await fetcher(`https://letterboxd.com/${user}/rss/`, { headers: { "user-agent": UA, accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5" } });
  } catch {
    throw new LetterboxdError("Could not reach Letterboxd. Try once more in a minute, or move on to the seen check.");
  }
  if (res.status === 404) throw new LetterboxdError(`There is no Letterboxd member called "${user}". Check the spelling of the username (it's in their profile link, letterboxd.com/<username>/).`);
  if (res.status === 403 || res.status === 429 || res.headers.get("cf-mitigated") !== null)
    throw new LetterboxdError(`Letterboxd turned the request away (HTTP ${res.status}). Don't retry now; move on to the seen check.`);
  if (!res.ok) throw new LetterboxdError(`Letterboxd answered HTTP ${res.status}. Try once more later, or move on to the seen check.`);
  const xml = await res.text();
  if (!/<rss[\s>]/.test(xml)) throw new LetterboxdError("Letterboxd sent something that isn't a feed. Move on to the seen check.");
  const entries = parseLetterboxdRss(xml);
  if (!entries.length) throw new LetterboxdError(`${user}'s Letterboxd diary is empty, so there is nothing to read. Move on to the seen check.`);
  return profileFromRss(entries, r);
}
