import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Several airline sites tarpit or 444 a non-browser User-Agent (BA, Delta, Emirates). */
export const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const TIMEOUT_MS = 90_000;

/** Date sent to the airline for a month: today for the current month, the 5th otherwise. */
export function fetchDate(month: string, today = new Date()): string {
  const iso = today.toISOString().slice(0, 10);
  return iso.startsWith(month) ? iso : `${month}-05`;
}

/** For sources with no month selector: only the current month can be fetched (cached months stay readable). */
export function assertCurrentMonth(id: string, month: string, today = new Date()): void {
  if (today.toISOString().slice(0, 7) !== month) throw new Error(`${id} only publishes the current cycle; cannot fetch ${month}`);
}

export const monthDir = (cacheDir: string, id: string, month: string) => `${cacheDir}/${id}/${month}`;

export interface CachedRequest { url: string; path: string; init?: RequestInit; refresh?: boolean; minBytes?: number }

/**
 * Return the cached JSON at `path`, or perform one request (no retries) and cache the body.
 * Responses shorter than minBytes are treated as errors and not cached.
 */
export async function cachedJson<T = unknown>({ url, path, init, refresh, minBytes = 100 }: CachedRequest): Promise<T> {
  if (!refresh && existsSync(path)) return (await Bun.file(path).json()) as T;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${text.slice(0, 200)}`);
  if (text.length < minBytes) throw new Error(`${url} returned a near-empty body (${text.length} bytes)`);
  const data = JSON.parse(text) as T;
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, text);
  return data;
}

/** Trimmed, non-empty, first-seen-order unique strings. */
export function uniq(xs: (string | null | undefined)[]): string[] {
  return [...new Set(xs.map((x) => x?.trim() ?? "").filter(Boolean))];
}

/** Split a comma list ("English,English,French") into unique trimmed values. */
export const splitList = (s: string | null | undefined, sep: RegExp | string = ","): string[] => uniq(s?.split(sep) ?? []);
