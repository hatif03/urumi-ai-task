import { Hono } from "hono";
import { log, traceFromHeaders, withTrace } from "@urumi/obs";
import { originAllowed, userFromCookie, type GatewayEnv } from "./auth.ts";
import { chatResponse, llmConfigured } from "./chat.ts";
import { mcpApp } from "./mcp.ts";
import { oauthRoutes } from "./oauth.ts";
import { accountRoutes, memberRoutes, publicAccountRoutes } from "./routes/accounts.ts";
import { adminRoutes } from "./routes/admin.ts";
import { internalRoutes } from "./routes/internal.ts";
import { provisioningRoutes } from "./routes/provisioning.ts";
import { serverRoutes } from "./routes/servers.ts";
import type { ToolRouter } from "./router.ts";
import type { Store } from "./store.ts";
import type { User } from "./types.ts";

export type { GatewayEnv } from "./auth.ts";

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

  api.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "same-origin");
    if (c.req.path.startsWith("/api/")) c.header("cache-control", "no-store");
  });

  api.use("/api/*", async (c, next) => {
    // A cookie-authenticated browser request from another origin is refused outright.
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !originAllowed(c.req.raw, env)) return c.json({ error: "origin not allowed" }, 403);
    return next();
  });

  api.route("/", publicAccountRoutes(store, env));

  api.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/login" || c.req.path === "/api/logout") return next();
    const user = await userFromCookie(c.req.raw, store, env);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("user", user);
    return next();
  });

  api.route("/", accountRoutes(store));
  api.route("/", memberRoutes(store));
  api.route("/", serverRoutes(store, router, env));
  api.route("/", adminRoutes(store));
  api.route("/", provisioningRoutes(env));

  api.get("/api/status", (c) => c.json({ llmConfigured: llmConfigured() }));

  api.post("/api/chat", async (c) => {
    const trace = traceFromHeaders(c.req.raw.headers);
    const user = c.get("user");
    if (!(await store.consumeToken(`chat:${user.id}`, Number(process.env.CHAT_PER_MINUTE ?? 20)))) return c.json({ error: "chat rate limit reached, wait a minute" }, 429);
    const body = await c.req.json().catch(() => ({})) as { messages?: unknown[] };
    const response = await withTrace(trace, () => chatResponse(router, store, { userId: user.id, role: user.role, apiKeyId: null, actor: "chat" }, (body.messages ?? []) as never, trace.traceId));
    response.headers.set("traceparent", trace.traceparent);
    return response;
  });

  api.route("/", oauthRoutes(store, env));
  api.route("/", internalRoutes(store, router, env));
  api.route("/", mcpApp(store, router, env));
  log("info", "gateway app ready");
  return api;
}

declare module "hono" {
  interface ContextVariableMap {
    user: User;
  }
}
