import { createMcpApp, type ToolDefinition, type ToolResult } from "@urumi/mcp-http";
import { log, metrics, traceFromHeaders, withTrace } from "@urumi/obs";
import { bearerToken, callerFromApiKey, originAllowed, publicBase, type GatewayEnv, type McpCaller } from "./auth.ts";
import { callerFromOAuthToken } from "./oauth.ts";
import type { PublicTool, ToolRouter } from "./router.ts";
import { searchTools } from "./search.ts";
import type { Store } from "./store.ts";

// Resolved once per request in authorize() and read again in tools().
const callers = new WeakMap<Request, McpCaller>();

export async function authenticateMcp(request: Request, store: Store, env: GatewayEnv) {
  const token = bearerToken(request);
  return (await callerFromApiKey(token, store)) ?? (await callerFromOAuthToken(token, store, request, env));
}

function text(value: unknown): ToolResult {
  const body = JSON.stringify(value);
  return { content: [{ type: "text", text: body }], structuredContent: Array.isArray(value) ? { items: value } : (value as Record<string, unknown>) };
}

function summary(tool: PublicTool, score?: number) {
  return {
    name: tool.publicName,
    description: tool.description.length > 240 ? `${tool.description.slice(0, 240)}…` : tool.description,
    readOnly: tool.annotations.readOnlyHint === true,
    ...(score !== undefined ? { score: Number(score.toFixed(3)) } : {}),
  };
}

// The "search" surface: three tools instead of the whole catalog. A model with hundreds of tools
// behind the gateway holds three definitions and fetches only the schemas it needs.
export function searchSurface(router: ToolRouter, store: Store, caller: McpCaller & { role: "admin" | "member" }, traceId: string): ToolDefinition[] {
  const audit = async (tool: string, started: number, outcome: "success" | "error") => {
    await store.insertAudit({ userId: caller.userId, apiKeyId: caller.apiKeyId, actor: caller.actor, serverSlug: "gateway", toolName: tool, durationMs: performance.now() - started, outcome, errorCode: null, traceId });
  };
  return [
    {
      name: "search_tools",
      description: "Search the tools of every connected server by keyword. Returns names and short descriptions. Call describe_tool for the full input schema, then call_tool to run one.",
      annotations: { readOnlyHint: true },
      jsonSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] },
      handler: async (args) => {
        const started = performance.now();
        const hits = searchTools(await router.catalogFor(caller), String(args.query ?? ""), Number(args.limit ?? 8));
        await audit("search_tools", started, "success");
        return text({ tools: hits.map((hit) => summary(hit.tool, hit.score)), hint: hits.length ? "describe_tool then call_tool" : "no match, try other words" });
      },
    },
    {
      name: "describe_tool",
      description: "Return the full description and JSON input schema of one tool found by search_tools.",
      annotations: { readOnlyHint: true },
      jsonSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      handler: async (args) => {
        const started = performance.now();
        const tool = (await router.catalogFor(caller)).find((item) => item.publicName === String(args.name));
        await audit("describe_tool", started, tool ? "success" : "error");
        if (!tool) return { isError: true, content: [{ type: "text", text: "unknown tool" }] };
        return text({ ...summary(tool), description: tool.description, inputSchema: tool.inputSchema });
      },
    },
    {
      name: "call_tool",
      description: "Run a tool by its full name (server__tool) with an arguments object. The same permissions, rate limit and audit apply as for a direct call.",
      jsonSchema: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name"] },
      handler: (args) => callThrough(router, caller, String(args.name ?? ""), (args.arguments ?? {}) as Record<string, unknown>, traceId),
    },
  ];
}

export async function callThrough(router: ToolRouter, caller: McpCaller & { role: "admin" | "member" }, name: string, args: Record<string, unknown>, traceId: string): Promise<ToolResult> {
  // Runs inside a trace context built from the request's id, so the upstream call and its spans join it.
  const result = await withTrace(traceFromHeaders(new Headers({ traceparent: `00-${traceId}-${traceId.slice(0, 16)}-01` })), () => router.call(caller, name, args, traceId));
  if (!result.ok) {
    const error = new Error(result.message) as Error & { code?: string; rpcCode?: number };
    error.code = result.errorCode;
    error.rpcCode = result.rpcCode;
    throw error;
  }
  const value = result.result as Partial<ToolResult> | undefined;
  if (value?.content) return value as ToolResult;
  return text(value ?? {});
}

export function mcpApp(store: Store, router: ToolRouter, env: GatewayEnv) {
  return createMcpApp({
    name: "urumi-gateway",
    version: "0.2.0",
    ready: async () => {
      await store.ping();
      return true;
    },
    authorize: async (request, message) => {
      const trace = traceFromHeaders(request.headers);
      if (!originAllowed(request, env)) {
        return Response.json({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32600, message: "origin not allowed" } }, { status: 403 });
      }
      const caller = await authenticateMcp(request, store, env);
      if (caller) {
        callers.set(request, caller);
        // last_used_at is a hint for humans: one write a minute per key, not one per call
        if (caller.apiKeyId && (!caller.lastUsedAt || Date.now() - Date.parse(caller.lastUsedAt) > 60_000)) await store.touchApiKey(caller.apiKeyId);
        return null;
      }
      const toolName = message.method === "tools/call" ? String(message.params?.name ?? "") || null : null;
      await store.insertAudit({ userId: null, apiKeyId: null, actor: "mcp", serverSlug: null, toolName, durationMs: 0, outcome: "unauthorized", errorCode: "unauthorized", traceId: trace.traceId });
      metrics.inc("tool_calls_total", { server: "gateway", tool: "auth", outcome: "unauthorized" });
      log("warn", "rejected mcp credential", { traceId: trace.traceId });
      // resource_metadata tells an OAuth-capable client where to start (RFC 9728, MCP authorization spec).
      const challenge = `Bearer resource_metadata="${publicBase(request, env)}/.well-known/oauth-protected-resource"`;
      return Response.json({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32001, message: "unauthorized" } }, { status: 401, headers: { "www-authenticate": challenge, traceparent: trace.traceparent } });
    },
    tools: async (request, message) => {
      const caller = callers.get(request);
      if (!caller) return [];
      const trace = traceFromHeaders(request.headers);
      if (new URL(request.url).searchParams.get("surface") === "search") return searchSurface(router, store, caller, trace.traceId);
      if (message.method === "tools/list") {
        return (await router.catalogFor(caller)).map((item): ToolDefinition => ({
          name: item.publicName,
          description: item.description,
          annotations: item.annotations,
          jsonSchema: item.inputSchema,
          handler: (args) => callThrough(router, caller, item.publicName, args, trace.traceId),
        }));
      }
      if (message.method === "tools/call") {
        // No catalog fan-out on the hot path: the router resolves the server, checks the tool exists
        // and checks permission, and answers unknown tools with -32602.
        const name = String(message.params?.name ?? "");
        return [{ name, description: "", jsonSchema: { type: "object" }, handler: (args) => callThrough(router, caller, name, args, trace.traceId) }];
      }
      return [];
    },
  });
}
