import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { joinToolName, splitToolName } from "@urumi/mcp-names";
import { childSpan, currentTrace, log, metrics, observeDuration, traceFromHeaders } from "@urumi/obs";
import { decryptSecret } from "./crypto.ts";
import { pinnedFetch, resolveUpstream } from "./ssrf.ts";
import { decide } from "./policy.ts";
import type { Store } from "./store.ts";
import type { Actor, CachedTool, McpServerRow, Outcome, Role, ToolAnnotations } from "./types.ts";

const LIST_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 8000;
const CACHE_MS = 30_000;
const IDLE_MS = 60_000;
const NO_RETRY = new Set(["create_product", "update_order_status"]);

export type Caller = { userId: string; role: Role; apiKeyId: string | null; oauthTokenId?: string | null; actor: Actor };

export type PublicTool = {
  serverId: string;
  slug: string;
  publicName: string;
  upstreamName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
};

export type CallSuccess = { ok: true; result: unknown };
export type CallFailure = { ok: false; rpcCode: number; errorCode: string; message: string };
export type CallResult = CallSuccess | CallFailure;

type Warm = { client: Client; timer: ReturnType<typeof setTimeout> };

export class ToolRouter {
  private warm = new Map<string, Warm>();

  constructor(
    private readonly store: Store,
    private readonly options: { credentialKey: string; credentialKeyPrevious?: string; allowlist: string[]; rateLimitPerMinute: number; maxResultBytes?: number; maxInflight?: number },
  ) {}

  // Every enabled server's tools, minus the ones this caller may not use. Both /mcp tools/list and the
  // chat agent build their tool set from here, so a denied tool is hidden from both.
  async catalogFor(caller: Pick<Caller, "userId" | "role">): Promise<PublicTool[]> {
    const [tools, grants] = await Promise.all([this.catalog(), this.store.listGrants()]);
    return tools.filter((tool) => decide({ id: caller.userId, role: caller.role }, { serverSlug: tool.slug, toolName: tool.upstreamName, annotations: tool.annotations }, grants).allowed);
  }

  // The dashboard view of one server: every cached tool, flagged with this user's decision and why.
  async visibleTools(user: { id: string; role: Role }, server: McpServerRow) {
    const [tools, grants] = await Promise.all([this.store.getCachedTools(server.id), this.store.listGrants()]);
    return tools.map((tool) => {
      const decision = decide(user, { serverSlug: server.slug, toolName: tool.upstreamName, annotations: tool.annotations }, grants);
      return { name: joinToolName(server.slug, tool.upstreamName), upstreamName: tool.upstreamName, description: tool.description, readOnly: tool.annotations.readOnlyHint === true, allowed: decision.allowed, reason: decision.reason };
    });
  }

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

  private inflight = 0;

  // Admission control. Each call costs this replica roughly 15 ms of CPU, so a replica has a ceiling. Past it,
  // queueing every request makes every request slow, and the health probes queue behind them: Kubernetes then
  // restarts a pod that is merely busy, and its load lands on the others. A bounded number in flight, and a fast
  // "busy" answer for the rest, keeps the pod healthy and lets a client (or the autoscaler) react.
  async call(caller: Caller, publicName: string, args: Record<string, unknown>, traceId: string): Promise<CallResult> {
    const limit = this.options.maxInflight ?? 24;
    if (this.inflight >= limit) {
      metrics.inc("calls_shed_total", { reason: "inflight" });
      return this.finish(caller, null, null, publicName, performance.now(), traceId, "error", "overloaded", -32005, "the gateway is busy, retry shortly");
    }
    this.inflight++;
    metrics.setGauge("calls_inflight", {}, this.inflight);
    try {
      return await this.callAdmitted(caller, publicName, args, traceId);
    } finally {
      this.inflight--;
      metrics.setGauge("calls_inflight", {}, this.inflight);
    }
  }

  private async callAdmitted(caller: Caller, publicName: string, args: Record<string, unknown>, traceId: string): Promise<CallResult> {
    const started = performance.now();
    const split = splitToolName(publicName);
    if (!split) return this.finish(caller, null, null, publicName, started, traceId, "error", "invalid_name", -32602, "unknown tool");
    const server = await this.store.getServerBySlug(split.slug);
    if (!server) return this.finish(caller, null, split.slug, split.tool, started, traceId, "error", "invalid_name", -32602, "unknown tool");
    if (!server.enabled) return this.finish(caller, server, server.slug, split.tool, started, traceId, "error", "server_disabled", -32000, "server is disabled");

    const limitKey = caller.apiKeyId ? `key:${caller.apiKeyId}` : caller.oauthTokenId ? `oauth:${caller.userId}` : caller.actor === "chat" ? `chat-call:${caller.userId}` : null;
    if (limitKey && !(await this.allowRate(limitKey))) {
      metrics.inc("rate_limit_rejected_total", { server: server.slug });
      return this.finish(caller, server, server.slug, split.tool, started, traceId, "denied", "rate_limited", -32000, "rate limit exceeded");
    }

    const cached = await this.findTool(server, split.tool);
    if (!cached) {
      const fresh = await this.store.getServer(server.id);
      if (fresh?.status !== "unreachable") {
        return this.finish(caller, server, server.slug, split.tool, started, traceId, "error", "invalid_name", -32602, "unknown tool");
      }
    }

    // Checked here, not only in tools/list: hiding a tool is not a control, rejecting the call is.
    const decision = decide({ id: caller.userId, role: caller.role }, { serverSlug: server.slug, toolName: split.tool, annotations: cached?.annotations ?? {} }, await this.store.listGrants());
    if (!decision.allowed) {
      metrics.inc("tool_calls_total", { server: server.slug, tool: split.tool, outcome: "denied" });
      return this.finish(caller, server, server.slug, split.tool, started, traceId, "denied", "denied", -32003, `not permitted: ${decision.reason}`);
    }

    try {
      let result = await this.invoke(server, split.tool, args, traceId);
      // A server (or a hostile one) can answer with an enormous payload. It is refused here, before it is
      // copied to a client or put into a model's context.
      const limit = this.options.maxResultBytes ?? 1_000_000;
      const size = JSON.stringify(result ?? null).length;
      if (size > limit) {
        metrics.inc("tool_calls_total", { server: server.slug, tool: split.tool, outcome: "error" });
        result = { isError: true, content: [{ type: "text", text: `result too large (${size} bytes, limit ${limit}); ask for less data` }] };
      }
      const failed = Boolean((result as { isError?: boolean }).isError);
      const outcome: Outcome = failed ? "error" : "success";
      metrics.inc("tool_calls_total", { server: server.slug, tool: split.tool, outcome });
      return this.finish(caller, server, server.slug, split.tool, started, traceId, outcome, failed ? "tool_error" : null, 0, "", result);
    } catch (error) {
      const code = classifyUpstream(error);
      const message = error instanceof Error ? error.message : "upstream failed";
      if (code === "upstream_timeout" || code === "upstream_unreachable") {
        const outcome: Outcome = code === "upstream_timeout" ? "timeout" : "unreachable";
        await this.store.setStatus(server.id, "unreachable", explainFailure(error));
        metrics.setGauge("upstream_up", { server: server.slug }, 0);
        metrics.inc("tool_calls_total", { server: server.slug, tool: split.tool, outcome });
        return this.finish(caller, server, server.slug, split.tool, started, traceId, outcome, code, -32000, message);
      }
      metrics.inc("tool_calls_total", { server: server.slug, tool: split.tool, outcome: "error" });
      return this.finish(caller, server, server.slug, split.tool, started, traceId, "error", code, -32000, message);
    }
  }

  // The cached row for a tool, refreshing the server's list once if it is not there. One read in the common case.
  private async findTool(server: McpServerRow, name: string): Promise<CachedTool | undefined> {
    const hit = (await this.store.getCachedTools(server.id)).find((tool) => tool.upstreamName === name);
    if (hit) return hit;
    await this.toolsFor(server, true);
    return (await this.store.getCachedTools(server.id)).find((tool) => tool.upstreamName === name);
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
          description: cleanDescription(tool.description ?? ""),
          inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
          annotations: pickAnnotations(tool.annotations),
        }));
        await this.store.replaceTools(server.id, rows);
        const skipped = listed.tools.length - rows.length;
        await this.store.setStatus(server.id, "connected", skipped ? `${skipped} tool names contained __ and were skipped` : "");
        metrics.setGauge("upstream_up", { server: server.slug }, 1);
        return this.store.getCachedTools(server.id);
      } catch (error) {
        await this.store.setStatus(server.id, "unreachable", explainFailure(error));
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
      annotations: tool.annotations ?? {},
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
    const parent = currentTrace() ?? traceFromHeaders(new Headers({ traceparent: `00-${traceId}-${traceId.slice(0, 16)}-01` }));
    return childSpan(parent, "gateway.call_upstream", { server: server.slug, tool: name }, () =>
      this.withClient(server, CALL_TIMEOUT_MS, (client) => client.callTool({ name, arguments: args }), retry));
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

  private connecting = new Map<string, Promise<Client>>();

  private async clientFor(server: McpServerRow): Promise<Client> {
    const existing = this.warm.get(server.id);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.drop(server.id), IDLE_MS);
      return existing.client;
    }
    // Forty callers arriving at a cold replica share one connection attempt instead of opening forty.
    const pending = this.connecting.get(server.id);
    if (pending) return pending;
    const attempt = this.connect(server).finally(() => this.connecting.delete(server.id));
    this.connecting.set(server.id, attempt);
    return attempt;
  }

  private async connect(server: McpServerRow): Promise<Client> {
    // Resolved again on every new connection: a warm client keeps its connection, a cold one re-checks.
    const resolved = await resolveUpstream(server.url, this.options.allowlist);
    const headers = new Headers({ accept: "application/json, text/event-stream" });
    if (server.credentialType !== "none" && server.credentialCiphertext) {
      const secret = await decryptSecret(server.credentialCiphertext, this.options.credentialKey, this.options.credentialKeyPrevious);
      if (server.credentialType === "bearer") headers.set("authorization", `Bearer ${secret}`);
      else if (server.credentialHeaderName) headers.set(server.credentialHeaderName, secret);
    }
    const transport = new StreamableHTTPClientTransport(resolved.url, { requestInit: { headers, redirect: "error" }, fetch: pinnedFetch(resolved) });
    const client = new Client({ name: "urumi-gateway", version: "0.1.0" });
    await client.connect(transport);
    this.warm.set(server.id, { client, timer: setTimeout(() => this.drop(server.id), IDLE_MS) });
    return client;
  }

  drop(serverId: string): void {
    const warm = this.warm.get(serverId);
    if (!warm) return;
    clearTimeout(warm.timer);
    this.warm.delete(serverId);
    void warm.client.close().catch(() => undefined);
  }

  // One shared token bucket in Postgres per caller, so every replica enforces the same limit. (An earlier
  // in-memory shortcut admitted up to 20 calls a second whatever the limit; it is gone.)
  private allowRate(bucket: string): Promise<boolean> {
    return this.store.consumeToken(bucket, this.options.rateLimitPerMinute);
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

// Tool text comes from an upstream we do not control and goes into a model context. Strip control
// characters and zero-width/bidi marks that hide instructions from a human reviewer, and cap length.
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
export function cleanDescription(text: string): string {
  const cleaned = text.replace(INVISIBLE, "");
  return cleaned.length > 1500 ? `${cleaned.slice(0, 1500)}…` : cleaned;
}

function pickAnnotations(raw: unknown): ToolAnnotations {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    ...(typeof source.readOnlyHint === "boolean" ? { readOnlyHint: source.readOnlyHint } : {}),
    ...(typeof source.destructiveHint === "boolean" ? { destructiveHint: source.destructiveHint } : {}),
    ...(typeof source.title === "string" ? { title: cleanDescription(source.title).slice(0, 120) } : {}),
  };
}

// Why an upstream is unreachable, in one short sentence an admin can act on.
export function explainFailure(error: unknown): string {
  const code = (error as { code?: string }).code ?? "";
  const text = error instanceof Error ? `${error.name} ${code} ${error.message}` : String(error);
  const detail = (label: string) => `${label}: ${(error instanceof Error ? error.message : text).slice(0, 200)}`;
  if (error instanceof Error && error.name === "SsrfError") return detail("blocked by SSRF policy");
  if (code === "upstream_timeout" || /timed out|timeout/i.test(text)) return detail("timeout");
  if (/ENOTFOUND|EAI_AGAIN|dns/i.test(text)) return detail("dns");
  if (/ECONNREFUSED|ConnectionRefused|refused|Unable to connect|EHOSTUNREACH|ENETUNREACH/i.test(text)) return detail("connection refused");
  if (/certificate|TLS|SSL|self.signed|CERT_/i.test(text)) return detail("tls");
  if (/401|403|unauthorized|forbidden/i.test(text)) return detail("upstream rejected the credential");
  if (/ECONNRESET|socket|closed|aborted|network|fetch failed/i.test(text)) return detail("connection dropped");
  return detail("protocol or upstream error");
}
