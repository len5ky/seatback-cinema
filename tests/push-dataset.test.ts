// scripts/push-dataset.sh against a local bare repo: CI's dataset commit lands after a concurrent American publish
// that touched index.json, ids.json and health.json, without losing American's entries.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const hasTools = ["git", "jq"].every((t) => Bun.which(t));

function sh(cwd: string, cmd: string): string {
  const r = Bun.spawnSync(["bash", "-c", cmd], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`${cmd}: exit ${r.exitCode}\n${r.stdout}\n${r.stderr}`);
  return r.stdout.toString();
}
const w = (dir: string, rel: string, data: unknown) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), typeof data === "string" ? data : `${JSON.stringify(data, null, 1)}\n`);
};
const film = (airline: string, month: string, count: number) => ({ airline, name: airline, month, fetchedAt: "2026-10-01", count, films: [] });
const ids = (o: Record<string, unknown>) => `{\n${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}: ${JSON.stringify(o[k])}`).join(",\n")}\n}\n`;
const health = (airlines: Record<string, unknown>) => ({ generatedAt: "x", month: "2026-10", ok: 1, failed: 0, airlines });

describe.skipIf(!hasTools)("push-dataset.sh", () => {
  test("regenerates the shared files over a concurrent American push", () => {
    const tmp = mkdtempSync(join(tmpdir(), "push-dataset-"));
    const remote = join(tmp, "remote.git"), ci = join(tmp, "ci"), local = join(tmp, "local");
    sh(tmp, `git init -q --bare -b main ${remote} && git clone -q ${remote} ${ci} 2>/dev/null`);
    w(ci, "public/data/emirates/2026-10.json", film("emirates", "2026-10", 1));
    w(ci, "public/data/american/2026-10.json", film("american", "2026-10", 1));
    w(ci, "public/data/ids.json", ids({ tt1: { tmdb: 1 } }));
    w(ci, "public/data/health.json", health({ emirates: { status: "ok", films: 1 }, american: { status: "failed" } }));
    w(ci, "public/data/index.json", "{}\n");
    sh(ci, "git add -A && git commit -qm base && git push -q origin HEAD:main");
    sh(tmp, `git clone -q ${remote} ${local}`);

    // American publishes first
    w(local, "public/data/american/2026-10.json", film("american", "2026-10", 5));
    w(local, "public/data/ids.json", ids({ tt1: { tmdb: 1 }, tt_aa: { tmdb: 9 } }));
    w(local, "public/data/health.json", health({ emirates: { status: "ok", films: 1 }, american: { status: "ok", films: 5 } }));
    w(local, "public/data/index.json", '{"american": 5}\n');
    sh(local, "git commit -qam american && git push -q origin HEAD:main");

    // CI's run, based on the old main
    w(ci, "public/data/emirates/2026-10.json", film("emirates", "2026-10", 2));
    w(ci, "public/data/ids.json", ids({ tt1: { tmdb: 1 }, tt_ek: { tmdb: 7 } }));
    w(ci, "public/data/health.json", health({ emirates: { status: "ok", films: 2 }, american: { status: "failed" } }));
    w(ci, "public/data/index.json", '{"ci": 1}\n');
    sh(ci, "git commit -qam ci");
    const out = sh(ci, `SKIP_AIRLINES=american ${ROOT}/scripts/push-dataset.sh public/data`);
    expect(out).toContain("regenerating");

    const check = join(tmp, "check");
    sh(tmp, `git clone -q ${remote} ${check}`);
    const d = (rel: string) => JSON.parse(readFileSync(join(check, "public/data", rel), "utf8"));
    expect(d("health.json").airlines).toEqual({ emirates: { status: "ok", films: 2 }, american: { status: "ok", films: 5 } });
    expect(d("ids.json")).toEqual({ tt1: { tmdb: 1 }, tt_aa: { tmdb: 9 }, tt_ek: { tmdb: 7 } });
    expect(d("american/2026-10.json").count).toBe(5);
    expect(d("emirates/2026-10.json").count).toBe(2);
    const months = Object.fromEntries(d("index.json").airlines.map((a: { id: string; months: { count: number }[] }) => [a.id, a.months[0]!.count]));
    expect(months).toEqual({ american: 5, emirates: 2 });
    expect(sh(check, "git log --format=%s").trim().split("\n")).toEqual(["ci", "american", "base"]);
  }, 30_000);
});
