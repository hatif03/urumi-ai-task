import { Hono } from "hono";
import { isSlug } from "@urumi/mcp-names";
import { safeEqual } from "../crypto.ts";
import { encryptSecret } from "../crypto.ts";
import type { GatewayEnv } from "../auth.ts";
import type { ToolRouter } from "../router.ts";
import { resolveUpstream, SsrfError } from "../ssrf.ts";
import type { Store } from "../store.ts";

// Service-to-service API for the provisioner. Not on the Ingress (only /api and /mcp are routed) and
// closed by NetworkPolicy to the provisioner pod; the bearer token is the second lock.
// It can do two things: register an MCP server the platform deployed, and remove it again.
export function internalRoutes(store: Store, router: ToolRouter, env: GatewayEnv) {
  const app = new Hono();

  app.use("/internal/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!env.internalToken || !token || !safeEqual(token, env.internalToken)) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  // Idempotent: the provisioner may repeat this call after a restart.
  app.put("/internal/servers/:slug", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.json().catch(() => ({})) as { displayName?: string; url?: string; managedBy?: string; secret?: string };
    if (!isSlug(slug) || !body.url || !body.displayName || (body.managedBy !== "store" && body.managedBy !== "hosted")) return c.json({ error: "slug, displayName, url and managedBy (store|hosted) are required" }, 400);
    try {
      await resolveUpstream(body.url, env.allowlist);
    } catch (error) {
      return c.json({ error: error instanceof SsrfError ? error.message : "invalid url" }, 400);
    }
    const existing = await store.getServerBySlug(slug);
    if (existing && existing.managedBy !== body.managedBy) return c.json({ error: "slug belongs to a server that is not managed this way" }, 409);
    const credentialCiphertext = body.secret ? await encryptSecret(body.secret, env.credentialKey) : null;
    const server = existing
      ? await store.updateServer(existing.id, { displayName: body.displayName, url: body.url, enabled: true, ...(body.secret ? { credentialType: "bearer" as const, credentialCiphertext } : {}) })
      : await store.insertServer({ slug, displayName: body.displayName, url: body.url, managedBy: body.managedBy, credentialType: body.secret ? "bearer" : "none", credentialCiphertext });
    router.drop(server!.id);
    await router.probe(server!.id);
    return c.json({ id: server!.id, status: (await store.getServer(server!.id))?.status });
  });

  app.delete("/internal/servers/:slug", async (c) => {
    const server = await store.getServerBySlug(c.req.param("slug"));
    if (!server) return c.json({ ok: true });
    if (!server.managedBy) return c.json({ error: "not a managed server" }, 409);
    router.drop(server.id);
    await store.deleteServer(server.id);
    return c.json({ ok: true });
  });

  return app;
}
