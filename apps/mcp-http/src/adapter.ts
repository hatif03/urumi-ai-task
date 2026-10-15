import { Hono } from "hono";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import type { ZodType } from "zod";
import { childSpan, log, metrics, observeDuration, traceFromHeaders } from "@urumi/obs";

export const ACCEPTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"] as const;
const PAGE_SIZE = 50;

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type ToolAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; title?: string };

export type ToolDefinition = {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
  inputSchema?: ZodType;
  jsonSchema?: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

export type McpAppOptions = {
  name: string;
  version: string;
  tools: (request: Request, message: { method?: string; params?: Record<string, unknown> }) => ToolDefinition[] | Promise<ToolDefinition[]>;
  ready?: () => Promise<boolean>;
  authorize?: (request: Request, message: { method?: string; id?: string | number | null; params?: Record<string, unknown> }) => Promise<Response | null>;
};

type JsonRpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function rpcError(id: JsonRpc["id"], code: number, message: string, data?: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data } });
}

function toolPage(tools: ToolDefinition[], cursor: unknown): { tools: unknown[]; nextCursor?: string } {
  const start = typeof cursor === "string" && cursor ? Number(cursor) : 0;
  const slice = tools.slice(start, start + PAGE_SIZE);
  const next = start + PAGE_SIZE < tools.length ? String(start + PAGE_SIZE) : undefined;
  return {
    tools: slice.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.jsonSchema ?? tool.inputSchema?.toJSONSchema() ?? { type: "object", properties: {} },
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    })),
    ...(next ? { nextCursor: next } : {}),
  };
}

export function createMcpApp(options: McpAppOptions): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", async (c) => {
    if (options.ready && !(await options.ready())) return c.json({ ok: false }, 503);
    return c.json({ ok: true });
  });
  app.get("/metrics", () => new Response(renderLocalMetrics(), { headers: { "content-type": "text/plain; version=0.0.4" } }));

  app.on(["GET", "DELETE"], "/mcp", () => new Response(null, { status: 405, headers: { allow: "POST" } }));

  app.post("/mcp", async (c) => {
    const trace = traceFromHeaders(c.req.raw.headers);
    const header = c.req.header("mcp-protocol-version");
    if (header && !ACCEPTED_PROTOCOL_VERSIONS.includes(header as (typeof ACCEPTED_PROTOCOL_VERSIONS)[number])) {
      return c.text("unsupported protocol version", 400);
    }

    const raw = await c.req.text();
    let message: unknown;
    try {
      message = raw ? JSON.parse(raw) : null;
    } catch {
      return rpcError(null, -32700, "parse error");
    }
    if (Array.isArray(message)) return c.text("batching is not supported", 400);
    if (!message || typeof message !== "object") return rpcError(null, -32600, "invalid request");

    if (options.authorize) {
      const rejected = await options.authorize(c.req.raw, message as JsonRpc);
      if (rejected) return rejected;
    }

    const rpc = message as JsonRpc;
    if (rpc.method === "notifications/initialized" || rpc.id === undefined) {
      return new Response(null, { status: 202, headers: { traceparent: trace.traceparent } });
    }

    if (rpc.method === "initialize") {
      const requested = String((rpc.params?.protocolVersion as string | undefined) ?? "");
      if (requested && !ACCEPTED_PROTOCOL_VERSIONS.includes(requested as (typeof ACCEPTED_PROTOCOL_VERSIONS)[number])) {
        return rpcError(rpc.id, -32602, `unsupported protocol version: ${requested}`);
      }
      const version = requested || "2025-06-18";
      return jsonResult(rpc.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: options.name, version: options.version },
      }, trace.traceparent);
    }

    const tools = await options.tools(c.req.raw, rpc);

    if (rpc.method === "ping") return jsonResult(rpc.id, {}, trace.traceparent);
    if (rpc.method === "resources/list") return jsonResult(rpc.id, { resources: [] }, trace.traceparent);
    if (rpc.method === "prompts/list") return jsonResult(rpc.id, { prompts: [] }, trace.traceparent);

    if (rpc.method === "tools/list") {
      const started = performance.now();
      const page = toolPage(tools, (rpc.params?.cursor as string | undefined) ?? undefined);
      observeDuration("tool_list_duration_seconds", { server: options.name }, started);
      return jsonResult(rpc.id, page, trace.traceparent);
    }

    if (rpc.method === "tools/call") {
      const name = String(rpc.params?.name ?? "");
      const tool = tools.find((item) => item.name === name);
      if (!tool) return rpcError(rpc.id, -32602, `unknown tool: ${name}`);
      const invalid = invalidArguments(tool, rpc.params?.arguments ?? {});
      if (invalid) return rpcError(rpc.id, -32602, invalid);

      const started = performance.now();
      try {
        const result = await childSpan(trace, `mcp.tool ${name}`, { server: options.name, tool: name }, () => tool.handler((rpc.params?.arguments ?? {}) as Record<string, unknown>));
        const outcome = result.isError ? "error" : "success";
        metrics.inc("tool_calls_total", { server: options.name, tool: name, outcome });
        observeDuration("tool_call_duration_seconds", { server: options.name, tool: name }, started);
        log("info", "tool call", { server: options.name, tool: name, outcome, traceId: trace.traceId });
        return jsonResult(rpc.id, result, trace.traceparent);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String((error as { code?: string }).code) : "internal_error";
        const rpcCode = Number((error as { rpcCode?: number }).rpcCode) || -32000;
        const outcome = code === "upstream_timeout" ? "timeout" : code === "upstream_unreachable" ? "unreachable" : "error";
        metrics.inc("tool_calls_total", { server: options.name, tool: name, outcome });
        observeDuration("tool_call_duration_seconds", { server: options.name, tool: name }, started);
        log("error", "tool call failed", { server: options.name, tool: name, outcome, traceId: trace.traceId });
        return rpcError(rpc.id, rpcCode, error instanceof Error ? error.message : "tool failed", { code });
      }
    }

    const server = new McpServer({ name: options.name, version: options.version });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      supportedProtocolVersions: [...ACCEPTED_PROTOCOL_VERSIONS],
    });
    await server.connect(transport);
    const response = await transport.handleRequest(new Request(c.req.url, {
      method: "POST",
      headers: c.req.raw.headers,
      body: raw,
    }));
    const headers = new Headers(response.headers);
    headers.set("traceparent", trace.traceparent);
    return new Response(response.body, { status: response.status, headers });
  });

  return app;
}

function invalidArguments(tool: ToolDefinition, args: unknown): string | null {
  if (tool.inputSchema) {
    const parsed = tool.inputSchema.safeParse(args);
    return parsed.success ? null : parsed.error.issues.map((issue) => issue.message).join("; ");
  }
  return validateAgainstSchema(tool.jsonSchema ?? { type: "object" }, args);
}

function validateAgainstSchema(schema: Record<string, unknown>, value: unknown): string | null {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const key of required) {
      if (record[key] === undefined) return `${key} is required`;
    }
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, property] of Object.entries(properties)) {
      if (record[key] === undefined) continue;
      const problem = validateAgainstSchema(property, record[key]);
      if (problem) return `${key}: ${problem}`;
    }
    return null;
  }
  if (schema.type === "string" && typeof value !== "string") return "expected string";
  if (schema.type === "boolean" && typeof value !== "boolean") return "expected boolean";
  if (schema.type === "integer" && !Number.isInteger(value)) return "expected integer";
  if (schema.type === "number" && typeof value !== "number") return "expected number";
  if (schema.type === "array") {
    if (!Array.isArray(value)) return "expected array";
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      for (const item of value) {
        const problem = validateAgainstSchema(items, item);
        if (problem) return problem;
      }
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return "value is not allowed";
  return null;
}

function jsonResult(id: JsonRpc["id"], result: unknown, traceparent: string): Response {
  return Response.json(
    { jsonrpc: "2.0", id, result },
    { headers: { traceparent } },
  );
}

function renderLocalMetrics(): string {
  return metrics.render();
}

export function listen(app: Hono): void {
  const port = Number(process.env.PORT ?? 8080);
  const metricsPort = Number(process.env.METRICS_PORT ?? 9090);
  const http = Bun.serve({ port, hostname: "0.0.0.0", fetch: app.fetch });
  const metricsServer = Bun.serve({
    port: metricsPort,
    hostname: "0.0.0.0",
    fetch(req) {
      if (new URL(req.url).pathname === "/metrics") {
        return new Response(metrics.render(), { headers: { "content-type": "text/plain; version=0.0.4" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  log("info", "listening", { port, metricsPort, service: process.env.OTEL_SERVICE_NAME ?? "mcp" });

  const shutdown = () => {
    http.stop(true);
    metricsServer.stop(true);
    setTimeout(() => process.exit(0), 20_000).unref?.();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
