// Cathay Pacific runs Anuvu's AirTime API (the Geemedia API at afg.anuvu.cloud/api/v1). The whole Movies tree in
// one call is 38 MB, so this fetches the section list once and then each of the ~36 sections on its own.
import { BROWSER_UA, cachedJson, fetchDate, monthDir } from "./http.ts";
import { parseAirtime, type AirtimeNode, type AirtimeTree } from "./platforms/geemedia.ts";
import { loadDetails } from "./platforms/batch.ts";
import type { AirlineAdapter, CatalogueFilm } from "./types.ts";

const BASE = "https://afg.anuvu.cloud/api/v1";
const HOST_ID = "460e26f4-d499-11e9-b038-6306ca4fd90b"; // public constant in the entertainment.cathaypacific.com bundle
const MOVIES_SECTION = "21004340";
const CONCURRENCY = 4;

interface AirtimeItem extends AirtimeNode { child_id_list?: string[] | null }

async function fetchCathay(month: string, { cacheDir, refresh }: { cacheDir: string; refresh?: boolean }): Promise<AirtimeTree> {
  const dir = monthDir(cacheDir, "cathay", month);
  let token: Promise<string> | undefined;
  // anonymous guest session, created only when something is not cached
  const session = () => (token ??= fetch(`${BASE}/account/session`, {
    method: "POST", signal: AbortSignal.timeout(30_000),
    headers: { "host-id": HOST_ID, "Content-Type": "application/json", "User-Agent": BROWSER_UA },
    body: JSON.stringify({ email: "", password: "" }),
  }).then(async (res) => {
    const body = (await res.json().catch(() => ({}))) as { auth_token?: string };
    if (!res.ok || !body.auth_token) throw new Error(`cathay: guest session failed (${res.status})`);
    return body.auth_token;
  }));
  const item = async (id: string, depth: number, path: string) => {
    const query = new URLSearchParams({
      max_child_depth: String(depth), max_child_per_item: "2000", staging: "false", child_items: "true",
      flight_date: fetchDate(month), language: "en",
    });
    const url = `${BASE}/content/items/${id}?${query}`;
    const cached = !refresh && (await Bun.file(path).exists());
    const headers: Record<string, string> = cached ? {} : { "host-id": HOST_ID, "auth-token": await session(), Accept: "application/json", "User-Agent": BROWSER_UA };
    const tree = await cachedJson<AirtimeTree>({ url, path, refresh, init: { headers } });
    const node = tree.items[0] as AirtimeItem | undefined;
    if (!node) throw new Error(`cathay: item ${id} came back empty`);
    return node;
  };

  // the API rejects max_child_depth=0; depth 1 lists the child sections without their movies
  const root = await item(MOVIES_SECTION, 1, `${dir}/movies.json`);
  const sectionIds = root.child_id_list ?? [];
  if (!sectionIds.length) throw new Error(`cathay: Movies section ${MOVIES_SECTION} lists no child sections`);
  const sections = new Map<string, AirtimeNode>();
  await loadDetails("cathay", sectionIds, CONCURRENCY, async (id) => {
    sections.set(id, await item(id, 1, `${dir}/sections/${id}.json`));
  });
  // reassemble the shape of the one-call tree so parseAirtime (shared with United/KLM) reads it unchanged
  const child_items = sectionIds.flatMap((id) => sections.get(id) ?? []);
  return { items: [{ ...root, child_items }] };
}

/** parseAirtime already moves a disambiguating "(2026)" title suffix into `year` (~50 Cathay titles). */
export const parseCathay = (raw: unknown): CatalogueFilm[] => parseAirtime(raw as AirtimeTree);

export const cathay: AirlineAdapter = {
  id: "cathay",
  name: "Cathay Pacific",
  fetchMonth: fetchCathay,
  parse: parseCathay,
};
