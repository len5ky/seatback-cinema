// Helpers for adapters that need one detail call per film, and for sources with messy name lists.

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

/**
 * Run `load` for every item with a concurrency limit. A failure is logged and skipped, but more than
 * max(2, 10%) failures abort the fetch so a broken recipe does not pass as a thin catalogue.
 */
export async function loadDetails<T>(label: string, items: readonly T[], limit: number, load: (item: T) => Promise<void>): Promise<void> {
  let failed = 0;
  await mapLimit(items, limit, async (item) => {
    try {
      await load(item);
    } catch (e) {
      failed++;
      console.warn(`${label}: detail call failed: ${(e as Error).message}`);
    }
  });
  if (failed > Math.max(2, items.length / 10)) throw new Error(`${label}: ${failed}/${items.length} detail calls failed`);
}

const clean = (v: string | null | undefined) => (v ?? "").replace(/[​ ]/g, " ").trim();

/** Trim, drop zero-width characters and empties, dedupe. */
export function cleanList(values: readonly (string | null | undefined)[] | null | undefined): string[] {
  return [...new Set((values ?? []).map(clean).filter(Boolean))];
}

/** Flatten name lists where some entries pack several names ("Ann Lee, Bo Ray"); keeps "Jr." attached. */
export function nameList(values: readonly (string | null | undefined)[] | string | null | undefined): string[] {
  const list = typeof values === "string" ? [values] : (values ?? []);
  const out: string[] = [];
  for (const v of list) {
    for (const raw of (v ?? "").split(/\s*[,、]\s*/)) {
      const name = clean(raw);
      if (!name) continue;
      if (/^(jr|sr)\.?$/i.test(name) && out.length) out[out.length - 1] += `, ${name}`;
      else out.push(name);
    }
  }
  return [...new Set(out)];
}
