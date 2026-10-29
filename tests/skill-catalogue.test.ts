import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";

const SCRIPT = `${import.meta.dir}/../skill/plane-movies/scripts/catalogue.ts`;
const tmpRoot = () => { const d = `${import.meta.dir}/../tmp`; mkdirSync(d, { recursive: true }); return d; };

async function run(base: string, cache: string, ...args: string[]) {
  const p = Bun.spawn(["bun", SCRIPT, ...args], { env: { ...process.env, DATASET_BASE_URL: base, XDG_CACHE_HOME: cache }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  return { out, err, code };
}

test("skill client: a 404 names the likely cause; invalid JSON is never cached; a good index is", async () => {
  let mode: "404" | "junk" | "ok" = "404";
  const index = { generatedAt: "2026-10-29", airlines: [{ id: "qantas", name: "Qantas", months: [] }] };
  const server = Bun.serve({ port: 0, fetch: () =>
    mode === "404" ? new Response("nope", { status: 404 }) : new Response(mode === "junk" ? "<html>challenge" : JSON.stringify(index)) });
  const cache = mkdtempSync(`${tmpRoot()}/skill-`);
  const base = `http://localhost:${server.port}/public`;
  try {
    const a = await run(base, cache, "--list");
    expect(a.code).toBe(1);
    expect(a.err).toContain("may be private, or the path is wrong");
    expect(a.err).not.toContain("placeholder");
    mode = "junk";
    const b = await run(base, cache, "--list");
    expect(b.code).toBe(1);
    expect(b.err).toContain("did not return JSON");
    expect(existsSync(`${cache}/plane-movies/index.json`)).toBe(false);
    mode = "ok";
    const c = await run(base, cache, "--list");
    expect(c.code).toBe(0);
    expect(c.out).toContain("qantas | Qantas");
    expect(existsSync(`${cache}/plane-movies/index.json`)).toBe(true);
  } finally {
    server.stop(true);
    rmSync(cache, { recursive: true, force: true });
  }
}, 20_000);
