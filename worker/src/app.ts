// Routing: /mcp, /api/*, /healthz, everything else from the static assets (public/).
import type { Bundle } from "../../src/bundle.ts";
import { Catalogue } from "./catalogue.ts";
import { handleApi, type EdgeCache, type WaitUntil } from "./api.ts";
import { CORS_HEADERS, handleMcp, SERVER_INFO } from "./mcp.ts";
import type { ProfileStore } from "./tools.ts";

/** IMPORT_URL (the Convex site URL, a var) and IMPORT_SECRET (a Worker secret) turn on the Convex import service. */
export interface Env { PROFILES: ProfileStore; ASSETS: { fetch(req: Request): Promise<Response> }; IMPORT_URL?: string; IMPORT_SECRET?: string }

/** The Workers edge cache when running on Cloudflare; tests pass their own or none. */
const edgeCache = (): EdgeCache | undefined => (globalThis as { caches?: { default?: EdgeCache } }).caches?.default;

export function createApp(bundle: Bundle, opts: { cache?: EdgeCache } = {}) {
  const catalogue = new Catalogue(bundle);
  return {
    async fetch(req: Request, env: Env, exec?: WaitUntil): Promise<Response> {
      const { pathname } = new URL(req.url);
      const importer = env.IMPORT_URL && env.IMPORT_SECRET ? { url: env.IMPORT_URL, secret: env.IMPORT_SECRET } : undefined;
      const ctx = { catalogue, profiles: env.PROFILES, ...(importer ? { importer } : {}) };
      if (pathname === "/mcp" || pathname === "/mcp/") return handleMcp(req, ctx);
      if (pathname === "/api" || pathname.startsWith("/api/")) return handleApi(req, ctx, opts.cache ?? edgeCache(), exec);
      if (pathname === "/healthz")
        return Response.json(
          { ok: true, server: SERVER_INFO, generatedAt: bundle.generatedAt, airlines: bundle.airlines.length },
          { headers: CORS_HEADERS },
        );
      return env.ASSETS.fetch(req);
    },
  };
}
