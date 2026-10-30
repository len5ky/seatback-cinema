// Stateless MCP over streamable HTTP: JSON-RPC 2.0 in a POST body, one JSON response back (no SSE, no sessions).
import { TOOLS, ToolError, callTool, type ToolContext } from "./tools.ts";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const SERVER_INFO = { name: "seatback-cinema", title: "Seatback Cinema", version: "1.0.0" };
const INSTRUCTIONS =
  "In-flight film catalogues for this month, by airline. Start with list_airlines, then picks for recommendations " +
  "(pass flight_minutes and a profile when you have them) or catalogue to browse or check a title. " +
  "Build a profile with profile_from_text from an IMDb or Letterboxd export or page you have fetched; save_profile returns a token for next time.";

export type Id = string | number | null;
interface RpcRequest { jsonrpc: "2.0"; id?: Id; method: string; params?: unknown }
export interface RpcResponse { jsonrpc: "2.0"; id: Id; result?: unknown; error?: { code: number; message: string; data?: unknown } }

export const ERR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;
const error = (id: Id, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
const ok = (id: Id, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The client's version if we speak it, else our latest. */
export function negotiate(requested: unknown): string {
  return typeof requested === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : PROTOCOL_VERSIONS[0];
}

/** One message; null for notifications and client responses, which get no reply. */
export async function handleMessage(msg: unknown, ctx: ToolContext): Promise<RpcResponse | null> {
  if (!isObj(msg) || msg.jsonrpc !== "2.0") return error(null, ERR.invalidRequest, "expected a JSON-RPC 2.0 object");
  const hasId = "id" in msg;
  const id = msg.id;
  if (hasId && id !== null && typeof id !== "string" && typeof id !== "number") return error(null, ERR.invalidRequest, "id must be a string or number");
  if (typeof msg.method !== "string") return hasId && !("result" in msg || "error" in msg) ? error(id as Id, ERR.invalidRequest, "method is required") : null;
  if (!hasId) return null; // notifications/initialized, notifications/cancelled, ...
  const req = msg as unknown as RpcRequest & { id: Id };
  const params = isObj(req.params) ? req.params : {};
  switch (req.method) {
    case "initialize":
      return ok(req.id, {
        protocolVersion: negotiate(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return ok(req.id, {});
    case "tools/list":
      return ok(req.id, { tools: TOOLS });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || !TOOLS.some((t) => t.name === name))
        return error(req.id, ERR.invalidParams, `unknown tool ${String(name)}; call tools/list for the available tools`);
      const args = params.arguments ?? {};
      if (!isObj(args)) return error(req.id, ERR.invalidParams, "arguments must be an object");
      try {
        const result = await callTool(ctx, name, args);
        return ok(req.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (e) {
        if (e instanceof ToolError) return ok(req.id, { content: [{ type: "text", text: e.message }], isError: true });
        console.error("tool failed", name, e);
        return error(req.id, ERR.internal, "internal error; try again, and report it if it keeps failing");
      }
    }
    default:
      return error(req.id, ERR.methodNotFound, `method ${req.method} is not supported`);
  }
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

/** POST /mcp (JSON-RPC), GET 405 (no server-initiated stream), DELETE 200 (no sessions to end), OPTIONS preflight. */
export async function handleMcp(req: Request, ctx: ToolContext): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method === "DELETE") return new Response(null, { status: 200, headers: CORS_HEADERS });
  if (req.method !== "POST")
    return new Response("This MCP server does not stream; send JSON-RPC requests with POST.", { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, DELETE, OPTIONS" } });
  const version = req.headers.get("MCP-Protocol-Version");
  if (version && !(PROTOCOL_VERSIONS as readonly string[]).includes(version))
    return json(error(null, ERR.invalidRequest, `unsupported MCP-Protocol-Version ${version}; supported: ${PROTOCOL_VERSIONS.join(", ")}`), 400);
  let body: unknown;
  try { body = await req.json(); } catch { return json(error(null, ERR.parse, "body is not valid JSON"), 400); }
  if (Array.isArray(body)) {
    if (!body.length) return json(error(null, ERR.invalidRequest, "empty batch"), 400);
    const out = (await Promise.all(body.map((m) => handleMessage(m, ctx)))).filter((r): r is RpcResponse => r !== null);
    return out.length ? json(out) : new Response(null, { status: 202, headers: CORS_HEADERS });
  }
  const res = await handleMessage(body, ctx);
  if (!res) return new Response(null, { status: 202, headers: CORS_HEADERS });
  return json(res, res.error?.code === ERR.invalidRequest ? 400 : 200);
}
