import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SCRIPT = `${import.meta.dir}/../skill/inflight-movie-picker/scripts/catalogue.ts`;
const tmpRoot = () => { const d = `${import.meta.dir}/../tmp`; mkdirSync(d, { recursive: true }); return d; };

// The test serves the dataset from a loopback server and fetches it. Sandboxes that cannot bind one (codex's: listen
// EPERM) or reach it (no loopback interface: ENETUNREACH) skip it with a note.
async function loopbackError(): Promise<string | null> {
  try {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    try { return (await (await fetch(`http://127.0.0.1:${s.port}/`)).text()) === "ok" ? null : "unexpected reply"; }
    finally { s.stop(true); }
  } catch (e) { return e instanceof Error ? e.message : String(e); }
}
const noLoopback = await loopbackError();
if (noLoopback) console.warn(`skill client test skipped: no usable loopback server (${noLoopback})`);

async function run(base: string, cache: string, ...args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, SEATBACK_DATASET_URL: base, XDG_CACHE_HOME: cache };
  delete env.DATASET_BASE_URL;
  const p = Bun.spawn(["bun", SCRIPT, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  return { out, err, code };
}

test.skipIf(!!noLoopback)("skill client: a 404 names the likely cause; invalid JSON is never cached; a good index is", async () => {
  let mode: "404" | "junk" | "ok" = "404";
  const index = { generatedAt: "2026-10-29", airlines: [{ id: "qantas", name: "Qantas", months: [] }] };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () =>
    mode === "404" ? new Response("nope", { status: 404 }) : new Response(mode === "junk" ? "<html>challenge" : JSON.stringify(index)) });
  const cache = mkdtempSync(`${tmpRoot()}/skill-`);
  const base = `http://127.0.0.1:${server.port}/public`;
  try {
    const a = await run(base, cache, "--list");
    expect(a.code).toBe(1);
    expect(a.err).toContain("nothing is published at this address, or the path is wrong");
    expect(a.err).not.toContain("placeholder");
    mode = "junk";
    const b = await run(base, cache, "--list");
    expect(b.code).toBe(1);
    expect(b.err).toContain("did not return JSON");
    expect(existsSync(`${cache}/inflight-movie-picker/127.0.0.1_${server.port}_public/index.json`)).toBe(false);
    mode = "ok";
    const c = await run(base, cache, "--list");
    expect(c.code).toBe(0);
    expect(c.out).toContain("qantas | Qantas");
    expect(existsSync(`${cache}/inflight-movie-picker/127.0.0.1_${server.port}_public/index.json`)).toBe(true);
  } finally {
    server.stop(true);
    rmSync(cache, { recursive: true, force: true });
  }
}, 20_000);

// A local copy of public/ works as a path, a file:// URL or via --base, and --taste joins IMDb ids and Letterboxd titles.
test("skill client: local dataset directory, file:// and --base; --taste hides seen films and flags the watchlist", async () => {
  const dir = mkdtempSync(`${tmpRoot()}/skill-local-`);
  const film = (id: string, title: string, year: number | null, imdbId: string | null, imdbConfidence = "high") =>
    ({ sourceId: id, title, year, runtime: 100, directors: [], genres: ["Drama"], rating: "PG", languages: [], categories: [], imdbId, imdbConfidence, tmdbId: null });
  try {
    mkdirSync(`${dir}/public/data/qantas`, { recursive: true });
    writeFileSync(`${dir}/public/data/index.json`, JSON.stringify({ generatedAt: "2026-10-29", airlines: [{ id: "qantas", name: "Qantas", months: [{ month: "2026-10", count: 4, fetchedAt: "2026-10-01T00:00:00Z", path: "qantas/2026-10.json" }] }] }));
    writeFileSync(`${dir}/public/data/qantas/2026-10.json`, JSON.stringify({ airline: "qantas", name: "Qantas", month: "2026-10", fetchedAt: "2026-10-01T00:00:00Z", count: 4, films: [
      film("1", "Seen On IMDb", 2020, "tt0000001"), film("2", "The Seen Letterboxd", null, "tt0000002"),
      film("3", "Wanted", 2024, "tt0000003", "medium"), film("4", "Fresh", 2025, null)] }));
    writeFileSync(`${dir}/ratings.csv`, "Const,Your Rating,Title,Year,Title Type\ntt0000001,9,\"Seen On IMDb\",2020,Movie\n");
    mkdirSync(`${dir}/letterboxd`);
    writeFileSync(`${dir}/letterboxd/watched.csv`, "Date,Name,Year,Letterboxd URI\n2024-01-01,Seen Letterboxd,2021,https://boxd.it/a\n");
    writeFileSync(`${dir}/letterboxd/watchlist.csv`, "Date,Name,Year,Letterboxd URI\n2024-01-01,Wanted,2024,https://boxd.it/b\n");
    const cache = `${dir}/cache`;

    for (const base of [dir, `${dir}/public`, pathToFileURL(`${dir}/public`).href]) {
      const r = await run(base, cache, "qantas");
      expect(r.code).toBe(0);
      expect(r.out).toContain("Qantas 2026-10: 4 films, 3 with an IMDb id");
      expect(r.out).toContain("Wanted | 2024 | 100 | Drama | PG | tt0000003 (medium)");
    }
    const viaFlag = await run("https://example.invalid/none", cache, "--base", `${dir}/public`, "--list");
    expect(viaFlag.code).toBe(0);
    expect(viaFlag.out).toContain("qantas | Qantas | 2026-10 (4)");

    const t = await run(dir, cache, "qantas", "--taste", dir);
    expect(t.code).toBe(0);
    expect(t.out).toContain("hid 2 seen films");
    expect(t.out).toContain("loved (9-10/10): Seen On IMDb (2020) 9");
    expect(t.out).not.toContain("| tt0000001 |");
    expect(t.out).not.toContain("Seen Letterboxd |");
    expect(t.out).toContain("tt0000003 (medium) | watchlist");
    expect(t.out).toContain("Fresh | 2025 | 100 | Drama | PG | - | -");

    const fam = await run(dir, cache, "qantas", "--family");
    expect(fam.out).toContain("showing 0");

    const missing = await run(`${dir}/nowhere`, cache, "--list");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("no data/index.json under");
    expect(existsSync(`${cache}/inflight-movie-picker`)).toBe(false); // local datasets are read in place, never cached
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
