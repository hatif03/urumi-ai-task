import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createMcpApp, type ToolDefinition } from "@urumi/mcp-http";
import { isSlug } from "@urumi/mcp-names";
import { log, metrics, traceFromHeaders } from "@urumi/obs";
import { chatResponse, llmConfigured } from "./chat.ts";
import { createApiToken, decryptSecret, encryptSecret, hashPassword, readSession, sha256Hex, safeEqual, signSession, verifyPassword } from "./crypto.ts";
import type { ToolRouter } from "./router.ts";
import { assertSafeUpstreamUrl, SsrfError } from "./ssrf.ts";
import type { Store } from "./store.ts";
import type { McpServerRow, Role, User } from "./types.ts";

export type GatewayEnv = {
  sessionSecret: string;
  credentialKey: string;
  cookieSecure: boolean;
  allowlist: string[];
};

const SESSION = "urumi_session";
const TWELVE_HOURS = 60 * 60 * 12;

export function createGatewayApp(store: Store, router: ToolRouter, env: GatewayEnv) {
  const api = new Hono();

  api.get("/healthz", (c) => c.json({ ok: true }));
  api.get("/readyz", async (c) => {
    try {
      await store.ping();
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  api.post("/api/login", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { username?: string; password?: string };
    const user = body.username ? await store.getUserByUsername(body.username) : null;
    const valid = user && !user.disabledAt && body.password ? await verifyPassword(body.password, user.passwordHash) : false;
    if (!user || !valid) return c.json({ error: "invalid username or password" }, 401);
    const token = await signSession({ uid: user.id, role: user.role, exp: Date.now() + TWELVE_HOURS * 1000 }, env.sessionSecret);
    setCookie(c, SESSION, token, cookieOptions(env));
    return c.json({ user: publicUser(user) });
  });

  api.post("/api/logout", (c) => {
    deleteCookie(c, SESSION, { path: "/" });
    return c.json({ ok: true });
  });

  api.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/login") return next();
    const user = await userFromCookie(c.req.raw, store, env);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("user", user);
    return next();
  });

  api.get("/api/me", (c) => c.json({ user: publicUser(c.get("user")) }));

  api.get("/api/servers", async (c) => {
    const user = c.get("user");
    const servers = await store.listServers();
    const presented = [];
    for (const server of servers) {
      const tools = server.enabled ? await store.getCachedTools(server.id) : [];
      presented.push(presentServer(server, user.role, tools.length));
    }
    return c.json({ servers: presented, llmConfigured: llmConfigured() });
  });

  api.get("/api/servers/:id/tools", async (c) => {
    const server = await store.getServer(c.req.param("id"));
    if (!server || !server.enabled) return c.json({ tools: [] });
    const tools = await store.getCachedTools(server.id);
    return c.json({ tools: tools.map((tool) => ({ name: `${server.slug}__${tool.upstreamName}`, description: tool.description })) });
  });

  api.post("/api/servers", async (c) => {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json() as ServerBody;
    const problem = await validateServerBody(body, env.allowlist, true);
    if (problem) return c.json({ error: problem }, 400);
    if (await store.getServerBySlug(body.slug)) return c.json({ error: "slug already exists" }, 409);
    const ciphertext = await ciphertextFor(body, env.credentialKey);
    const server = await store.insertServer({
      slug: body.slug,
      displayName: body.displayName,
      url: body.url,
      credentialType: body.credentialType ?? "none",
      credentialHeaderName: body.credentialHeaderName ?? null,
      credentialCiphertext: ciphertext,
    });
    await router.probe(server.id);
    return c.json({ server: presentServer((await store.getServer(server.id))!, "admin", (await store.getCachedTools(server.id)).length) }, 201);
  });

  api.patch("/api/servers/:id", async (c) => {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "forbidden" }, 403);
    const existing = await store.getServer(c.req.param("id"));
    if (!existing) return c.json({ error: "not found" }, 404);
    const body = await c.req.json() as Partial<ServerBody> & { enabled?: boolean };
    if (body.url) {
      try { await assertSafeUpstreamUrl(body.url, env.allowlist); } catch (error) {
        return c.json({ error: error instanceof SsrfError ? error.message : "invalid url" }, 400);
      }
    }
    const patch: Parameters<Store["updateServer"]>[1] = {};
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.url !== undefined) patch.url = body.url;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.credentialType !== undefined) patch.credentialType = body.credentialType;
    if (body.credentialHeaderName !== undefined) patch.credentialHeaderName = body.credentialHeaderName;
    if (body.secret) patch.credentialCiphertext = await encryptSecret(body.secret, env.credentialKey);
    const updated = await store.updateServer(existing.id, patch);
    return c.json({ server: presentServer(updated!, user.role, (await store.getCachedTools(existing.id)).length) });
  });

  api.delete("/api/servers/:id", async (c) => {
    if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
    await store.deleteServer(c.req.param("id"));
    return c.json({ ok: true });
  });

  api.post("/api/servers/:id/probe", async (c) => {
    if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
    const server = await router.probe(c.req.param("id"));
    if (!server) return c.json({ error: "not found" }, 404);
    return c.json({ server: presentServer(server, "admin", (await store.getCachedTools(server.id)).length) });
  });

  api.get("/api/members", async (c) => {
    if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
    const users = await store.listUsers();
    const members = [];
    for (const user of users) {
      const keys = await store.listApiKeys(user.id);
      members.push({ ...publicUser(user), liveKey: keys.some((key) => !key.revokedAt) });
    }
    return c.json({ members });
  });

  api.post("/api/members", async (c) => {
    if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json() as { username?: string; password?: string };
    if (!body.username || !body.password || body.password.length < 8) return c.json({ error: "username and a password of at least 8 characters are required" }, 400);
    if (await store.getUserByUsername(body.username)) return c.json({ error: "username already exists" }, 409);
    const user = await store.insertUser({ username: body.username, passwordHash: await hashPassword(body.password), role: "member" });
    return c.json({ user: publicUser(user) }, 201);
  });

  api.post("/api/members/:id/disable", async (c) => {
    if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
    await store.disableUser(c.req.param("id"));
    return c.json({ ok: true });
  });

  api.get("/api/api-keys", async (c) => {
    const keys = await store.listApiKeys(c.get("user").id);
    return c.json({ keys: keys.map(publicKey) });
  });

  api.post("/api/api-keys", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { label?: string };
    const created = createApiToken();
    const key = await store.insertApiKey({
      userId: c.get("user").id,
      prefix: created.prefix,
      keyHash: await sha256Hex(created.token),
      label: body.label || "default",
    });
    return c.json({ key: publicKey(key), token: created.token }, 201);
  });

  api.delete("/api/api-keys/:id", async (c) => {
    const user = c.get("user");
    const revoked = await store.revokeApiKey(c.req.param("id"), user.role === "admin" ? null : user.id);
    if (!revoked) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  api.get("/api/audit", async (c) => {
    if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
    const rows = await store.listAudit({
      userId: c.req.query("user") || undefined,
      serverSlug: c.req.query("server") || undefined,
      outcome: (c.req.query("outcome") as never) || undefined,
      from: c.req.query("from") || undefined,
      to: c.req.query("to") || undefined,
    });
    return c.json({ audit: rows });
  });

  api.post("/api/chat", async (c) => {
    const trace = traceFromHeaders(c.req.raw.headers);
    const user = c.get("user");
    const body = await c.req.json() as { messages?: unknown[] };
    const response = await chatResponse(router, { userId: user.id, apiKeyId: null, actor: "chat" }, (body.messages ?? []) as never, trace.traceId);
    response.headers.set("traceparent", trace.traceparent);
    return response;
  });

  const mcp = createMcpApp({
    name: "urumi-gateway",
    version: "0.1.0",
    ready: async () => {
      await store.ping();
      return true;
    },
    authorize: async (request, message) => {
      const trace = traceFromHeaders(request.headers);
      const caller = await callerFromBearer(request, store);
      if (caller) {
        await store.touchApiKey(caller.apiKeyId!);
        return null;
      }
      await store.insertAudit({
        userId: null,
        apiKeyId: null,
        actor: "mcp",
        serverSlug: null,
        toolName: message.method === "tools/call" ? toolName(message) : null,
        durationMs: 0,
        outcome: "unauthorized",
        errorCode: "unauthorized",
        traceId: trace.traceId,
      });
      metrics.inc("tool_calls_total", { server: "gateway", tool: "auth", outcome: "unauthorized" });
      log("warn", "rejected mcp credential", { traceId: trace.traceId });
      return Response.json(
        { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32001, message: "unauthorized" } },
        { status: 401, headers: { "www-authenticate": "Bearer", traceparent: trace.traceparent } },
      );
    },
    tools: async (request, message) => {
      const caller = await callerFromBearer(request, store);
      if (!caller) return [];
      const catalog = await router.catalog();
      const defs = catalog.map((item): ToolDefinition => ({
        name: item.publicName,
        description: item.description,
        jsonSchema: item.inputSchema,
          handler: (args) => callHandler(router, request, caller, item.publicName, args),
      }));
      const requested = message.method === "tools/call" ? String(message.params?.name ?? "") : "";
      if (requested && !defs.some((item) => item.name === requested)) {
        defs.push({
          name: requested,
          description: "upstream tool",
          jsonSchema: { type: "object" },
          handler: (args) => callHandler(router, request, caller, requested, args),
        });
      }
      return defs;
    },
  });

  api.route("/", mcp);
  return api;
}

type ServerBody = {
  slug: string;
  displayName: string;
  url: string;
  credentialType?: "none" | "bearer" | "header";
  credentialHeaderName?: string;
  secret?: string;
};

async function validateServerBody(body: ServerBody, allowlist: string[], creating: boolean): Promise<string | null> {
  if (!body.slug || !isSlug(body.slug)) return "slug must match ^[a-z][a-z0-9_]{1,31}$";
  if (!body.displayName) return "display name is required";
  if (creating && !body.url) return "url is required";
  if (body.url) {
    try { await assertSafeUpstreamUrl(body.url, allowlist); } catch (error) {
      return error instanceof SsrfError ? error.message : "invalid url";
    }
  }
  return null;
}

async function ciphertextFor(body: ServerBody, key: string): Promise<string | null> {
  if (!body.secret || body.credentialType === "none" || !body.credentialType) return null;
  return encryptSecret(body.secret, key);
}

function cookieOptions(env: GatewayEnv) {
  return { httpOnly: true, sameSite: "Lax" as const, secure: env.cookieSecure, path: "/", maxAge: TWELVE_HOURS };
}

async function userFromCookie(request: Request, store: Store, env: GatewayEnv): Promise<User | null> {
  const header = request.headers.get("cookie") ?? "";
  const token = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION}=`))?.slice(SESSION.length + 1);
  if (!token) return null;
  const session = await readSession(decodeURIComponent(token), env.sessionSecret);
  if (!session) return null;
  const user = await store.getUser(session.uid);
  if (!user || user.disabledAt) return null;
  return user;
}

async function callHandler(router: ToolRouter, request: Request, caller: { userId: string; apiKeyId: string | null; actor: "mcp" }, name: string, args: Record<string, unknown>) {
  const trace = traceFromHeaders(request.headers);
  const result = await router.call(caller, name, args, trace.traceId);
  if (!result.ok) {
    const error = new Error(result.message) as Error & { code?: string };
    error.code = result.errorCode;
    throw error;
  }
  const value = result.result as { content?: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
  if (value?.content) return value;
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: (value ?? {}) as Record<string, unknown> };
}

async function callerFromBearer(request: Request, store: Store) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token.startsWith("umk_")) return null;
  const key = await store.findLiveKeyByPrefix(token.slice(0, 12));
  if (!key || !safeEqual(key.keyHash, await sha256Hex(token))) return null;
  const user = await store.getUser(key.userId);
  if (!user || user.disabledAt) return null;
  return { userId: user.id, apiKeyId: key.id, actor: "mcp" as const };
}

function toolName(message: { method?: string; id?: string | number | null; params?: unknown }): string | null {
  const params = (message as { params?: { name?: string } }).params;
  return params?.name ?? null;
}

function publicUser(user: User) {
  return { id: user.id, username: user.username, role: user.role, disabledAt: user.disabledAt };
}

function publicKey(key: { id: string; prefix: string; label: string; createdAt: string; revokedAt: string | null; lastUsedAt: string | null }) {
  return { id: key.id, prefix: key.prefix, label: key.label, createdAt: key.createdAt, revokedAt: key.revokedAt, lastUsedAt: key.lastUsedAt };
}

function presentServer(server: McpServerRow, role: Role, toolCount: number) {
  return {
    id: server.id,
    slug: server.slug,
    displayName: server.displayName,
    status: server.enabled ? server.status : "disabled",
    statusDetail: server.statusDetail,
    enabled: server.enabled,
    toolCount,
    credentialType: server.credentialType,
    credentialHeaderName: server.credentialHeaderName,
    credentialSet: Boolean(server.credentialCiphertext),
    ...(role === "admin" ? { url: server.url } : {}),
  };
}

declare module "hono" {
  interface ContextVariableMap {
    user: User;
  }
}

void getCookie;
void deleteCookie;
void decryptSecret;
