import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { joinToolName, splitToolName } from "@urumi/mcp-names";
import { log, metrics, observeDuration } from "@urumi/obs";
import { decryptSecret } from "./crypto.ts";
import { assertSafeUpstreamUrl } from "./ssrf.ts";
import type { Store } from "./store.ts";
import type { Actor, CachedTool, McpServerRow, Outcome } from "./types.ts";

const LIST_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 8000;
const CACHE_MS = 30_000;
const IDLE_MS = 60_000;
const NO_RETRY = new Set(["create_product", "update_order_status"]);

export type Caller = { userId: string; apiKeyId: string | null; actor: Actor };

export type PublicTool = {
  serverId: string;
  slug: string;
  publicName: string;
  upstreamName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type CallSuccess = { ok: true; result: unknown };
export type CallFailure = { ok: false; rpcCode: number; errorCode: string; message: string };
export type CallResult = CallSuccess | CallFailure;

type Warm = { client: Client; timer: ReturnType<typeof setTimeout> };

export function policyAllows(): { allowed: true } | { allowed: false; reason: string } {
  return { allowed: true };
}

export class ToolRouter {
  private warm = new Map<string, Warm>();
  private shadow = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly store: Store,
    private readonly options: { credentialKey: string; allowlist: string[]; rateLimitPerMinute: number },
  ) {}

  async catalog(): Promise<PublicTool[]> {
    const started = performance.now();
    const servers = (await this.store.listServers()).filter((server) => server.enabled);
    const settled = await Promise.allSettled(servers.map((server) => this.toolsFor(server, false)));
    const tools: PublicTool[] = [];
    const seen = new Set<string>();
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const tool of result.value) {
        if (seen.has(tool.publicName)) continue;
        seen.add(tool.publicName);
        tools.push(tool);
      }
    }
    observeDuration("tool_list_duration_seconds", { server: "gateway" }, started);
    return tools;
  }

  async probe(id: string): Promise<McpServerRow | null> {
    const server = await this.store.getServer(id);
    if (!server) return null;
    if (!server.enabled) return server;
    await this.toolsFor(server, true);
    return this.store.getServer(id);
  }

  async probeOwned(): Promise<void> {
    for (const server of await this.store.listServers()) {
      if (!server.enabled) {
        metrics.setGauge("upstream_up", { server: server.slug }, 0);
        continue;
      }
      if (!(await this.store.claimProbe(server.id, 10_000))) continue;
      await this.toolsFor(server, true);
    }
  }

  async call(caller: Caller, publicName: string, args: Record<string, unknown>, traceId: string): Promise<CallResult> {
    const started = performance.now();
    const split = splitToolName(publicName);
    if (!split) return this.finish(caller, null, null, publicName, started, traceId, "error", "invalid_name", -32602, "unknown tool");
    const server = await this.store.getServerBySlug(split.slug);
    if (!server) return this.finish(caller, null, split.slug, split.tool, started, traceId, "error", "invalid_name", -32602, "unknown tool");
    if (!server.enabled) return this.finish(caller, server, server.slug, split.tool, started, traceId, "error", "server_disabled", -32000, "server is disabled");
    if (!policyAllows().allowed) return this.finish(caller, server, server.slug, split.tool, started, traceId, "denied", "denied", -32000, "denied");

    if (caller.apiKeyId && !(await this.allowRate(caller.apiKeyId))) {
      metrics.inc("rate_limit_rejected_total", { server: server.slug });
      return this.finish(caller, server, server.slug, split.tool, started, traceId, "denied", "rate_limited", -32000, "rate limit exceeded");
    }

    const known = await this.ensureTool(server, split.tool);
    if (!known) {
      const fresh = await this.store.getServer(server.id);
      if (fresh?.status !== "unreachable") {
        return this.finish(caller, server, server.slug, split.tool, started, traceId, "error", "invalid_name", -32602, "unknown tool");
      }
    }

    try {
      const result = await this.invoke(server, split.tool, args, traceId);
      const failed = Boolean((result as { isError?: boolean }).isError);
      const outcome: Outcome = failed ? "error" : "success";
      metrics.inc("tool_calls_total", { server: server.slug, tool: split.tool, outcome });
      return this.finish(caller, server, server.slug, split.tool, started, traceId, outcome, failed ? "tool_error" : null, 0, "", result);
    } catch (error) {
      const code = classifyUpstream(error);
      const message = error instanceof Error ? error.message : "upstream failed";
      if (code === "upstream_timeout" || code === "upstream_unreachable") {
        const outcome: Outcome = code === "upstream_timeout" ? "timeout" : "unreachable";
        await this.store.setStatus(server.id, "unreachable", message);
        metrics.setGauge("upstream_up", { server: server.slug }, 0);
        metrics.inc("tool_calls_total", { server: server.slug, tool: split.tool, outcome });
        return this.finish(caller, server, server.slug, split.tool, started, traceId, outcome, code, -32000, message);
      }
      metrics.inc("tool_calls_total", { server: server.slug, tool: split.tool, outcome: "error" });
      return this.finish(caller, server, server.slug, split.tool, started, traceId, "error", code, -32000, message);
    }
  }

  private async ensureTool(server: McpServerRow, name: string): Promise<boolean> {
    const cached = await this.store.getCachedTools(server.id);
    if (cached.some((tool) => tool.upstreamName === name)) return true;
    const listed = await this.toolsFor(server, true);
    return listed.some((tool) => tool.upstreamName === name);
  }

  private async toolsFor(server: McpServerRow, force: boolean): Promise<PublicTool[]> {
    if (!force && server.status !== "unreachable") {
      const cached = await this.freshCache(server.id);
      if (cached) return this.publish(server, cached);
    }
    const tools = await this.store.withServerLock(server.id, async () => {
      if (!force && server.status !== "unreachable") {
        const cached = await this.freshCache(server.id);
        if (cached) return cached;
      }
      try {
        const listed = await this.withClient(server, LIST_TIMEOUT_MS, (client) => client.listTools(), false);
        const rows = listed.tools.filter((tool) => tool.name && !tool.name.includes("__")).map((tool) => ({
          upstreamName: tool.name,
          description: tool.description ?? "",
          inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
        }));
        await this.store.replaceTools(server.id, rows);
        const skipped = listed.tools.length - rows.length;
        await this.store.setStatus(server.id, "connected", skipped ? `${skipped} tool names contained __ and were skipped` : "");
        metrics.setGauge("upstream_up", { server: server.slug }, 1);
        return this.store.getCachedTools(server.id);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unreachable";
        await this.store.setStatus(server.id, "unreachable", detail.slice(0, 300));
        metrics.setGauge("upstream_up", { server: server.slug }, 0);
        return [];
      }
    });
    return this.publish(server, tools);
  }

  private publish(server: McpServerRow, tools: CachedTool[]): PublicTool[] {
    return tools.map((tool) => ({
      serverId: server.id,
      slug: server.slug,
      publicName: joinToolName(server.slug, tool.upstreamName),
      upstreamName: tool.upstreamName,
      description: `[${server.slug}] ${tool.description}`,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
  }

  private async freshCache(serverId: string): Promise<CachedTool[] | null> {
    const cached = await this.store.getCachedTools(serverId);
    if (!cached.length) return null;
    if (Date.now() - Date.parse(cached[0]!.fetchedAt) > CACHE_MS) return null;
    return cached;
  }

  private async invoke(server: McpServerRow, name: string, args: Record<string, unknown>, traceId: string): Promise<unknown> {
    const retry = !NO_RETRY.has(name);
    return this.withClient(server, CALL_TIMEOUT_MS, (client) => client.callTool({ name, arguments: args }, { traceId } as never), retry);
  }

  private async withClient<T>(server: McpServerRow, timeoutMs: number, fn: (client: Client) => Promise<T>, retry: boolean): Promise<T> {
    const once = async () => {
      const client = await this.clientFor(server);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          fn(client),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error("upstream timed out"), { code: "upstream_timeout" })), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    try {
      return await once();
    } catch (error) {
      this.drop(server.id);
      const code = (error as { code?: string }).code;
      if (retry && code !== "upstream_timeout" && isConnectionDrop(error)) return once();
      if (code === "upstream_timeout") throw error;
      if (isConnectionDrop(error)) throw Object.assign(error instanceof Error ? error : new Error("unreachable"), { code: "upstream_unreachable" });
      throw error;
    }
  }

  private async clientFor(server: McpServerRow): Promise<Client> {
    const existing = this.warm.get(server.id);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.drop(server.id), IDLE_MS);
      return existing.client;
    }
    const url = await assertSafeUpstreamUrl(server.url, this.options.allowlist);
    const headers = new Headers({ accept: "application/json, text/event-stream" });
    if (server.credentialType !== "none" && server.credentialCiphertext) {
      const secret = await decryptSecret(server.credentialCiphertext, this.options.credentialKey);
      if (server.credentialType === "bearer") headers.set("authorization", `Bearer ${secret}`);
      else if (server.credentialHeaderName) headers.set(server.credentialHeaderName, secret);
    }
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers, redirect: "error" } });
    const client = new Client({ name: "urumi-gateway", version: "0.1.0" });
    await client.connect(transport);
    this.warm.set(server.id, { client, timer: setTimeout(() => this.drop(server.id), IDLE_MS) });
    return client;
  }

  private drop(serverId: string): void {
    const warm = this.warm.get(serverId);
    if (!warm) return;
    clearTimeout(warm.timer);
    this.warm.delete(serverId);
    void warm.client.close().catch(() => undefined);
  }

  private async allowRate(apiKeyId: string): Promise<boolean> {
    const shadow = this.shadow.get(apiKeyId);
    if (shadow && shadow.tokens > 5 && Date.now() - shadow.at < 1000) {
      shadow.tokens -= 1;
      return true;
    }
    const allowed = await this.store.consumeToken(apiKeyId, this.options.rateLimitPerMinute);
    if (allowed) this.shadow.set(apiKeyId, { tokens: 20, at: Date.now() });
    else this.shadow.delete(apiKeyId);
    return allowed;
  }

  private async finish(
    caller: Caller,
    server: McpServerRow | null,
    slug: string | null,
    toolName: string | null,
    started: number,
    traceId: string,
    outcome: Outcome,
    errorCode: string | null,
    rpcCode: number,
    message: string,
    result?: unknown,
  ): Promise<CallResult> {
    const durationMs = performance.now() - started;
    observeDuration("tool_call_duration_seconds", { server: slug ?? "unknown", tool: toolName ?? "unknown" }, started);
    await this.store.insertAudit({
      userId: caller.userId,
      apiKeyId: caller.apiKeyId,
      actor: caller.actor,
      serverSlug: slug,
      toolName,
      durationMs,
      outcome,
      errorCode,
      traceId,
    });
    log("info", "tool call", { traceId, userId: caller.userId, server: slug, tool: toolName, durationMs, outcome });
    if (result !== undefined && rpcCode === 0) return { ok: true, result };
    return { ok: false, rpcCode, errorCode: errorCode ?? "error", message };
  }
}

function classifyUpstream(error: unknown): string {
  const code = (error as { code?: string }).code;
  if (code === "upstream_timeout") return code;
  if (code === "upstream_unreachable" || isConnectionDrop(error)) return "upstream_unreachable";
  return "upstream_error";
}

function isConnectionDrop(error: unknown): boolean {
  const code = (error as { code?: string }).code ?? "";
  const message = error instanceof Error ? `${error.name} ${code} ${error.message}` : String(error);
  return /ECONNRESET|ECONNREFUSED|ConnectionRefused|ENOTFOUND|EAI_AGAIN|socket|fetch failed|network|closed|aborted|refused/i.test(message);
}
