import { BROWSER_UA } from "../airlines/http.ts";

/** Wikidata asks bots for a descriptive UA; the film sites only answer a browser UA. */
export const BOT_UA = "plane_movie/2.0 (personal in-flight film ranking; low volume, 1 req/s)";
export { BROWSER_UA };
const TIMEOUT_MS = 30_000;
const lastHit = new Map<string, number>();

/** fetch with at most one request per second per host (sequential callers only). */
export async function politeFetch(url: string, init: RequestInit = {}, minGapMs = 1000): Promise<Response> {
  const host = new URL(url).host;
  const wait = (lastHit.get(host) ?? 0) + minGapMs - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  lastHit.set(host, Date.now());
  return fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
}
