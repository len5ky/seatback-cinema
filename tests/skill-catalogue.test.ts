import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";

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
  const p = Bun.spawn(["bun", SCRIPT, ...args], { env: { ...process.env, DATASET_BASE_URL: base, XDG_CACHE_HOME: cache }, stdout: "pipe", stderr: "pipe" });
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
    expect(a.err).toContain("may be private, or the path is wrong");
    expect(a.err).not.toContain("placeholder");
    mode = "junk";
    const b = await run(base, cache, "--list");
    expect(b.code).toBe(1);
    expect(b.err).toContain("did not return JSON");
    expect(existsSync(`${cache}/inflight-movie-picker/index.json`)).toBe(false);
    mode = "ok";
    const c = await run(base, cache, "--list");
    expect(c.code).toBe(0);
    expect(c.out).toContain("qantas | Qantas");
    expect(existsSync(`${cache}/inflight-movie-picker/index.json`)).toBe(true);
  } finally {
    server.stop(true);
    rmSync(cache, { recursive: true, force: true });
  }
}, 20_000);
