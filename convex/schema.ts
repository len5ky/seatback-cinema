import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // The import cache: one row per ur id (data = the ImdbImport as JSON: film ids, scores, genres, director names, counts),
  // plus alias rows for p. profile ids (ur only, no data). Read by key, one row at a time.
  imports: defineTable({ key: v.string(), ur: v.string(), data: v.optional(v.string()), expiresAt: v.number() })
    .index("by_key", ["key"])
    .index("by_expires", ["expiresAt"]),
  // Daily counters: "g:<day>" for all imports, "u:<id>:<day>" per profile. Old days are pruned a few rows at a time.
  counters: defineTable({ key: v.string(), day: v.string(), count: v.number() })
    .index("by_key", ["key"])
    .index("by_day", ["day"]),
});
