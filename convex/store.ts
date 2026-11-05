// Cache and cap bookkeeping for the IMDb importer. Every read is one indexed row or a bounded take().
import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { checkCaps, dayOf } from "./importCore.ts";

const PRUNE = 10;

/** The fresh cached import for a ur id or p. alias, as JSON, or null. */
export const cached = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const now = Date.now();
    const row = await ctx.db.query("imports").withIndex("by_key", (q) => q.eq("key", key)).first();
    if (!row || row.expiresAt <= now) return null;
    if (row.data !== undefined) return row.data;
    const target = await ctx.db.query("imports").withIndex("by_key", (q) => q.eq("key", row.ur)).first();
    return target && target.expiresAt > now && target.data !== undefined ? target.data : null;
  },
});

/** The ur id behind a p. alias row, fresh or expired (until pruned), or null. */
export const aliasOf = internalQuery({
  args: { alias: v.string() },
  handler: async (ctx, { alias }) => {
    const row = await ctx.db.query("imports").withIndex("by_key", (q) => q.eq("key", alias)).first();
    return row && row.data === undefined ? row.ur : null;
  },
});

async function counter(ctx: MutationCtx, key: string, day: string) {
  const row = await ctx.db.query("counters").withIndex("by_key", (q) => q.eq("key", key)).first();
  return { row, count: row?.count ?? 0, bump: async () => {
    if (row) await ctx.db.patch(row._id, { count: row.count + 1 });
    else await ctx.db.insert("counters", { key, day, count: 1 });
  } };
}

/** Count one import against today's global cap (when countGlobal) and the profile's own cap, or say which is full. */
export const reserve = internalMutation({
  args: { key: v.string(), countGlobal: v.boolean(), daily: v.number(), perUser: v.number() },
  handler: async (ctx, { key, countGlobal, daily, perUser }) => {
    const day = dayOf(Date.now());
    const g = countGlobal ? await counter(ctx, `g:${day}`, day) : null;
    const u = await counter(ctx, `u:${key}:${day}`, day);
    const r = checkCaps(g ? g.count : null, u.count, { daily, perUser });
    if (r.ok) { await g?.bump(); await u.bump(); }
    for (const old of await ctx.db.query("counters").withIndex("by_day", (q) => q.lt("day", day)).take(PRUNE)) await ctx.db.delete(old._id);
    return r.ok ? { ok: true as const } : { ok: false as const, scope: r.scope };
  },
});

async function upsert(ctx: MutationCtx, key: string, ur: string, data: string | undefined, expiresAt: number) {
  const row = await ctx.db.query("imports").withIndex("by_key", (q) => q.eq("key", key)).first();
  if (row) await ctx.db.replace(row._id, { key, ur, ...(data !== undefined ? { data } : {}), expiresAt });
  else await ctx.db.insert("imports", { key, ur, ...(data !== undefined ? { data } : {}), expiresAt });
}

/** A p. alias for a cached ur import, expiring with it (so an alias never extends the cache). */
export const alias = internalMutation({
  args: { alias: v.string(), ur: v.string() },
  handler: async (ctx, { alias, ur }) => {
    const target = await ctx.db.query("imports").withIndex("by_key", (q) => q.eq("key", ur)).first();
    if (target?.data !== undefined) await upsert(ctx, alias, ur, undefined, target.expiresAt);
  },
});

/** Store an import under its ur id (and a p. alias), and drop a few expired rows. */
export const save = internalMutation({
  args: { ur: v.string(), alias: v.optional(v.string()), data: v.string(), expiresAt: v.number() },
  handler: async (ctx, { ur, alias, data, expiresAt }) => {
    await upsert(ctx, ur, ur, data, expiresAt);
    if (alias) await upsert(ctx, alias, ur, undefined, expiresAt);
    for (const old of await ctx.db.query("imports").withIndex("by_expires", (q) => q.lt("expiresAt", Date.now())).take(PRUNE)) await ctx.db.delete(old._id);
  },
});
