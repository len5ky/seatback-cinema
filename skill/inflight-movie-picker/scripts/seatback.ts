// Talk to the Seatback Cinema MCP server (POST <base>/mcp, JSON-RPC tools/call): save a taste profile and get a
// token for the Claude app, or load one saved earlier. The server is stateless, so no initialize handshake.
import type { Profile } from "./profile.ts";

export const TOKEN_RE = /^[a-z2-7]{20}$/;
export const PROFILE_MAX_BYTES = 64 * 1024; // the server's save_profile limit
const NAME_MAX = 100, LIST_MAX = 50;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** One tools/call; a tool error (isError) or a JSON-RPC error becomes an Error with the server's message. */
export async function mcpCall(base: string, name: string, args: Record<string, unknown>, fetchFn: Fetch = fetch): Promise<Record<string, unknown>> {
  const url = `${base.replace(/\/+$/, "")}/mcp`;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
  } catch (e) {
    throw new Error(`cannot reach ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status} (${text.slice(0, 120).replace(/\s+/g, " ")})`);
  let body: { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[] }; error?: { message?: string } };
  try { body = JSON.parse(text) as typeof body; } catch { throw new Error(`${url} did not return JSON (${text.slice(0, 80).replace(/\s+/g, " ")})`); }
  if (body.error) throw new Error(`${name}: ${body.error.message ?? "JSON-RPC error"}`);
  const r = body.result;
  const message = r?.content?.find((c) => c.type === "text")?.text;
  if (!r || r.isError) throw new Error(`${name}: ${message ?? "the server returned no result"}`);
  if (r.structuredContent) return r.structuredContent;
  try { return JSON.parse(message ?? "") as Record<string, unknown>; } catch { throw new Error(`${name}: unreadable result`); }
}

/** Trim to the server's 64 KB by dropping the oldest ratings, then the oldest seen ids (lists are newest first). */
export function fitProfile(p: Profile): { profile: Profile; dropped: string | null } {
  const size = (x: Profile) => new TextEncoder().encode(JSON.stringify(x)).length;
  if (size(p) <= PROFILE_MAX_BYTES) return { profile: p, dropped: null };
  const out: Profile = { ...p, seen: [...p.seen], ...(p.ratings ? { ratings: { ...p.ratings } } : {}) };
  const entries = Object.entries(p.ratings ?? {});
  let keep = entries.length;
  while (keep > 0 && size(out) > PROFILE_MAX_BYTES) { keep = Math.floor(keep * 0.9); out.ratings = Object.fromEntries(entries.slice(0, keep)); }
  let seen = out.seen.length;
  while (seen > 0 && size(out) > PROFILE_MAX_BYTES) { seen = Math.floor(seen * 0.9); out.seen = p.seen.slice(0, seen); }
  const parts = [entries.length > keep ? `${entries.length - keep} oldest ratings` : "", p.seen.length > out.seen.length ? `${p.seen.length - out.seen.length} oldest seen films` : ""];
  return { profile: out, dropped: parts.filter(Boolean).join(" and ") };
}

/** A clean Profile with only the fields save_profile takes; list fields deduplicated and capped like the server does. */
export function cleanProfile(p: Profile): Profile {
  const uniq = (xs: string[] | undefined, max = Infinity) => [...new Set((xs ?? []).map((s) => s.trim()).filter(Boolean))].slice(0, max);
  const out: Profile = { seen: uniq(p.seen) };
  if (p.ratings && Object.keys(p.ratings).length) out.ratings = p.ratings;
  const watchlist = uniq(p.watchlist);
  if (watchlist.length) out.watchlist = watchlist;
  for (const f of ["liked_directors", "liked_genres", "disliked_genres"] as const) {
    const list = uniq(p[f], LIST_MAX).map((s) => s.slice(0, NAME_MAX));
    if (list.length) out[f] = list;
  }
  if (p.source?.trim()) out.source = p.source.trim().slice(0, NAME_MAX);
  return out;
}

export async function saveProfile(base: string, p: Profile, fetchFn: Fetch = fetch): Promise<{ token: string; dropped: string | null }> {
  const { profile, dropped } = fitProfile(cleanProfile(p));
  const r = await mcpCall(base, "save_profile", { profile }, fetchFn);
  if (typeof r.token !== "string" || !TOKEN_RE.test(r.token)) throw new Error("save_profile: the server returned no token");
  return { token: r.token, dropped };
}

export async function getProfile(base: string, token: string, fetchFn: Fetch = fetch): Promise<Profile> {
  const t = token.trim().toLowerCase();
  if (!TOKEN_RE.test(t)) throw new Error(`--profile-token: "${token}" is not a profile token (20 letters and digits 2-7, from --save-profile)`);
  const r = await mcpCall(base, "get_profile", { token: t }, fetchFn);
  if (!Array.isArray(r.seen)) throw new Error("get_profile: the server returned no profile");
  return r as unknown as Profile;
}

export const pasteSentence = (token: string) => `My Seatback Cinema profile token is ${token}.`;
