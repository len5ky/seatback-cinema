// Rebuild public/data/index.json from the export files on disk.
// `cli export` only indexes snapshots in the local SQLite DB, which starts empty on every CI run, so an airline that
// failed this run (or any earlier month) would drop out of the index. This keeps every published file listed.
// usage: bun scripts/build-index.ts [dir]   (default: public/data)
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { ExportFile, IndexFile } from "../src/export.ts";

const dir = Bun.argv[2] ?? "public/data";
const index: IndexFile = { generatedAt: new Date().toISOString(), airlines: [] };
for (const id of readdirSync(dir).sort()) {
  if (!statSync(`${dir}/${id}`).isDirectory()) continue;
  const months = readdirSync(`${dir}/${id}`).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort();
  if (!months.length) continue;
  const entry: IndexFile["airlines"][number] = { id, name: id, months: [] };
  for (const f of months) {
    const data = JSON.parse(readFileSync(`${dir}/${id}/${f}`, "utf8")) as ExportFile;
    entry.name = data.name;
    entry.months.push({ month: data.month, count: data.count, fetchedAt: data.fetchedAt, path: `${id}/${f}` });
  }
  index.airlines.push(entry);
}
writeFileSync(`${dir}/index.json`, `${JSON.stringify(index, null, 1)}\n`);
console.log(`index: ${index.airlines.length} airlines, ${index.airlines.reduce((n, a) => n + a.months.length, 0)} files`);
