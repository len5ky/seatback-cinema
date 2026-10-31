// POST /import/imdb { user: "<IMDb profile URL, ur id or p. id>" } with header x-import-secret. Called by the seatback Worker only.
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { safeEqual } from "./importCore.ts";

const json = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "application/json" } });

const http = httpRouter();
http.route({
  path: "/import/imdb",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.IMPORT_SECRET;
    if (!secret || !safeEqual(req.headers.get("x-import-secret") ?? "", secret)) return json(401, '{"ok":false,"error":"unauthorized"}');
    let user: unknown;
    try { user = ((await req.json()) as { user?: unknown }).user; } catch { user = undefined; }
    if (typeof user !== "string" || !user.trim() || user.length > 300) return json(400, '{"ok":false,"error":"bad_request","message":"body must be { \\"user\\": \\"<IMDb profile URL>\\" }"}');
    const r = await ctx.runAction(internal.importer.run, { user });
    return json(r.status, r.body);
  }),
});
export default http;
