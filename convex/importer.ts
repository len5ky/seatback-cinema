"use node";
// The IMDb calls run here, in a Node action (AWS egress), because IMDb answers Cloudflare's IPs with HTTP 429.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { liveDeps, type ImdbImport } from "../worker/src/imdb.ts";
import { capsFromEnv, expiresAt, runImport, type ImportStore } from "./importCore.ts";

/** Returns { status, body } with body as JSON text: a profile can hold more keys than a Convex object allows. */
export const run = internalAction({
  args: { user: v.string() },
  handler: async (ctx, { user }): Promise<{ status: number; body: string }> => {
    const caps = capsFromEnv(process.env);
    const store: ImportStore = {
      cached: async (key) => {
        const data = await ctx.runQuery(internal.store.cached, { key });
        return data === null ? null : (JSON.parse(data) as ImdbImport);
      },
      reserve: (key, countGlobal) => ctx.runMutation(internal.store.reserve, { key, countGlobal, ...caps }),
      save: async (imp, alias) => {
        await ctx.runMutation(internal.store.save, {
          ur: imp.imdb_user, ...(alias ? { alias } : {}), data: JSON.stringify(imp), expiresAt: expiresAt(imp, Date.now()),
        });
      },
    };
    const t0 = Date.now();
    const r = await runImport(store, liveDeps, user);
    // Counts only: no ids, no titles.
    const b = r.body;
    console.log(b.ok
      ? `import ok cached=${b.cached} rated=${b.import.rated} seen=${b.import.profile.seen.length} watchlist=${b.import.watchlist} degraded=${b.import.degraded} calls=${r.calls} ms=${Date.now() - t0}`
      : `import ${b.error}${b.scope ? `:${b.scope}` : ""} calls=${r.calls} ms=${Date.now() - t0}`);
    return { status: r.status, body: JSON.stringify(b) };
  },
});
