// Routing: /mcp, /healthz, everything else from the static assets (public/).
import type { Bundle } from "../../src/bundle.ts";
import { Catalogue } from "./catalogue.ts";
import { CORS_HEADERS, handleMcp, SERVER_INFO } from "./mcp.ts";
import type { ProfileStore } from "./tools.ts";

/** IMPORT_URL (the Convex site URL, a var) and IMPORT_SECRET (a Worker secret) turn on the Convex import service. */
export interface Env { PROFILES: ProfileStore; ASSETS: { fetch(req: Request): Promise<Response> }; IMPORT_URL?: string; IMPORT_SECRET?: string }

export function createApp(bundle: Bundle) {
  const catalogue = new Catalogue(bundle);
  return {
    async fetch(req: Request, env: Env): Promise<Response> {
      const { pathname } = new URL(req.url);
      if (pathname === "/mcp" || pathname === "/mcp/") {
        const importer = env.IMPORT_URL && env.IMPORT_SECRET ? { url: env.IMPORT_URL, secret: env.IMPORT_SECRET } : undefined;
        return handleMcp(req, { catalogue, profiles: env.PROFILES, ...(importer ? { importer } : {}) });
      }
      if (pathname === "/healthz")
        return Response.json(
          { ok: true, server: SERVER_INFO, generatedAt: bundle.generatedAt, airlines: bundle.airlines.length },
          { headers: CORS_HEADERS },
        );
      return env.ASSETS.fetch(req);
    },
  };
}
