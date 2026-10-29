import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

/** Return the JSON cached at `path`, or run `request`, check it, write the body to `path` and return it parsed. */
export async function cachedJson(path: string, refresh: boolean | undefined, request: () => Promise<Response>): Promise<unknown> {
  if (!refresh && existsSync(path)) return Bun.file(path).json();
  const res = await request();
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.url || path} -> ${res.status}: ${text.slice(0, 200)}`);
  const parsed: unknown = JSON.parse(text);
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, text);
  return parsed;
}

/** Map with at most `limit` calls in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The date sent to an airline for a month: the 5th. */
export function monthDate(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`bad month ${month}, expected YYYY-MM`);
  return `${month}-05`;
}

/** Split "A, B" name lists (some sources pack several names into one string), keeping "Jr." suffixes attached. */
export function splitNames(values: readonly (string | null | undefined)[] | string | null | undefined): string[] {
  const list = typeof values === "string" ? [values] : (values ?? []);
  const out: string[] = [];
  for (const v of list) {
    for (const raw of (v ?? "").split(/\s*[,、]\s*/)) {
      const name = raw.replace(/[​ ]/g, " ").trim();
      if (!name) continue;
      if (/^(jr|sr)\.?$/i.test(name) && out.length) out[out.length - 1] += `, ${name}`;
      else out.push(name);
    }
  }
  return [...new Set(out)];
}

/** Trim, drop zero-width characters and empties, dedupe. */
export function cleanList(values: readonly (string | null | undefined)[] | null | undefined): string[] {
  return [...new Set((values ?? []).map((v) => (v ?? "").replace(/[​ ]/g, " ").trim()).filter(Boolean))];
}
