// Serve public/ (the leaderboard page and the dataset) on http://localhost:4173, so the skill's catalogue script
// can read a local copy: SEATBACK_DATASET_URL=http://localhost:4173. SEATBACK_PORT overrides the port (a generic
// PORT is ignored on purpose: shells often export one for something else).
import { join, normalize } from "node:path";

const ROOT = join(import.meta.dir, "..", "public");
const port = Number(process.env.SEATBACK_PORT ?? 4173);

async function serveFile(req: Request): Promise<Response> {
  const path = normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = Bun.file(join(ROOT, path.endsWith("/") ? `${path}index.html` : path));
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file, { headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } });
}

try {
  const server = Bun.serve({ port, fetch: serveFile });
  console.log(`serving ${ROOT} on http://localhost:${server.port}`);
} catch (e) {
  console.error(`cannot listen on port ${port} (${e instanceof Error ? e.message : e})`);
  console.error(`Pick another: SEATBACK_PORT=${port + 1} bun run serve, then SEATBACK_DATASET_URL=http://localhost:${port + 1}`);
  process.exit(1);
}
