import { Hono } from "hono";
import { isSlug } from "@urumi/mcp-names";
import { encryptSecret } from "../crypto.ts";
import type { GatewayEnv } from "../auth.ts";
import type { ToolRouter } from "../router.ts";
import { resolveUpstream, SsrfError } from "../ssrf.ts";
import type { Store } from "../store.ts";
import type { CredentialType, McpServerRow, Role } from "../types.ts";

type ServerBody = {
  slug: string;
  displayName: string;
  url: string;
  credentialType?: CredentialType;
  credentialHeaderName?: string;
  secret?: string;
};

const CREDENTIAL_TYPES = ["none", "bearer", "header"];
// Header names an admin may not set: they would let a stored credential impersonate the hop itself.
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type", "transfer-encoding", "connection", "upgrade", "cookie", "traceparent", "mcp-protocol-version", "mcp-session-id"]);

export function presentServer(server: McpServerRow, role: Role, toolCount: number) {
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
    lastCheckedAt: server.lastCheckedAt,
    managedBy: server.managedBy,
    ...(role === "admin" ? { url: server.url } : {}),
  };
}

async function urlProblem(url: string, allowlist: string[]): Promise<string | null> {
  try {
    await resolveUpstream(url, allowlist);
    return null;
  } catch (error) {
    return error instanceof SsrfError ? error.message : "invalid url";
  }
}

function credentialProblem(body: Partial<ServerBody>): string | null {
  if (body.credentialType !== undefined && !CREDENTIAL_TYPES.includes(body.credentialType)) return "credentialType must be none, bearer or header";
  if (body.credentialType === "header") {
    const name = (body.credentialHeaderName ?? "").toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(name)) return "header name is required for a header credential";
    if (FORBIDDEN_HEADERS.has(name)) return `header ${name} cannot carry a credential`;
  }
  return null;
}

export function serverRoutes(store: Store, router: ToolRouter, env: GatewayEnv) {
  const app = new Hono();
  const adminOnly = (role: Role) => role === "admin";

  app.get("/api/servers", async (c) => {
    const user = c.get("user");
    const servers = await store.listServers();
    const presented = await Promise.all(servers.map(async (server) => presentServer(server, user.role, server.enabled ? (await store.getCachedTools(server.id)).length : 0)));
    return c.json({ servers: presented });
  });

  app.get("/api/servers/:id/tools", async (c) => {
    const server = await store.getServer(c.req.param("id"));
    if (!server || !server.enabled) return c.json({ tools: [] });
    const visible = await router.visibleTools(c.get("user"), server);
    return c.json({ tools: visible });
  });

  app.post("/api/servers", async (c) => {
    if (!adminOnly(c.get("user").role)) return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json().catch(() => ({})) as ServerBody;
    if (!body.slug || !isSlug(body.slug)) return c.json({ error: "slug must be lowercase words joined by single underscores, 2-32 characters" }, 400);
    if (!body.displayName?.trim()) return c.json({ error: "display name is required" }, 400);
    if (!body.url) return c.json({ error: "url is required" }, 400);
    const problem = (await urlProblem(body.url, env.allowlist)) ?? credentialProblem(body);
    if (problem) return c.json({ error: problem }, 400);
    if (await store.getServerBySlug(body.slug)) return c.json({ error: "slug already exists" }, 409);
    const type = body.credentialType ?? "none";
    const server = await store.insertServer({
      slug: body.slug,
      displayName: body.displayName.trim().slice(0, 80),
      url: body.url,
      credentialType: type,
      credentialHeaderName: type === "header" ? body.credentialHeaderName!.toLowerCase() : null,
      credentialCiphertext: type !== "none" && body.secret ? await encryptSecret(body.secret, env.credentialKey) : null,
    });
    await router.probe(server.id);
    const fresh = (await store.getServer(server.id))!;
    return c.json({ server: presentServer(fresh, "admin", (await store.getCachedTools(server.id)).length) }, 201);
  });

  // Edit name, URL, enabled flag, or rotate/clear the credential. The slug never changes: public
  // tool names depend on it and audit rows refer to it.
  app.patch("/api/servers/:id", async (c) => {
    if (!adminOnly(c.get("user").role)) return c.json({ error: "forbidden" }, 403);
    const existing = await store.getServer(c.req.param("id"));
    if (!existing) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({})) as Partial<ServerBody> & { enabled?: boolean; clearCredential?: boolean };
    // A managed server's address and credentials belong to the platform; an admin may only switch it on or off.
    if (existing.managedBy && Object.keys(body).some((key) => key !== "enabled")) return c.json({ error: `this server is managed by the platform (${existing.managedBy}); remove it from the ${existing.managedBy === "store" ? "Stores" : "Hosted"} page` }, 409);
    if (body.url) {
      const problem = await urlProblem(body.url, env.allowlist);
      if (problem) return c.json({ error: problem }, 400);
    }
    const problem = credentialProblem({ ...body, credentialType: body.credentialType ?? existing.credentialType, credentialHeaderName: body.credentialHeaderName ?? existing.credentialHeaderName ?? undefined });
    if (problem && (body.credentialType !== undefined || body.credentialHeaderName !== undefined)) return c.json({ error: problem }, 400);

    const patch: Parameters<Store["updateServer"]>[1] = {};
    if (body.displayName !== undefined) patch.displayName = body.displayName.trim().slice(0, 80);
    if (body.url !== undefined) patch.url = body.url;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.credentialType !== undefined) patch.credentialType = body.credentialType;
    if (body.credentialHeaderName !== undefined) patch.credentialHeaderName = body.credentialHeaderName.toLowerCase();
    if (body.clearCredential || body.credentialType === "none") patch.credentialCiphertext = null;
    if (body.secret) patch.credentialCiphertext = await encryptSecret(body.secret, env.credentialKey);
    let updated = await store.updateServer(existing.id, patch);

    // A changed URL or credential invalidates the warm connection; re-enabling re-checks health.
    router.drop(existing.id);
    if (updated?.enabled && (body.url || body.secret || body.credentialType !== undefined || body.enabled === true || body.clearCredential)) {
      await router.probe(existing.id);
      updated = await store.getServer(existing.id);
    }
    return c.json({ server: presentServer(updated!, "admin", (await store.getCachedTools(existing.id)).length) });
  });

  app.delete("/api/servers/:id", async (c) => {
    if (!adminOnly(c.get("user").role)) return c.json({ error: "forbidden" }, 403);
    const target = await store.getServer(c.req.param("id"));
    if (target?.managedBy) return c.json({ error: `this server is managed by the platform (${target.managedBy}); remove it from the ${target.managedBy === "store" ? "Stores" : "Hosted"} page` }, 409);
    router.drop(c.req.param("id"));
    await store.deleteServer(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/servers/:id/probe", async (c) => {
    if (!adminOnly(c.get("user").role)) return c.json({ error: "forbidden" }, 403);
    const server = await router.probe(c.req.param("id"));
    if (!server) return c.json({ error: "not found" }, 404);
    return c.json({ server: presentServer(server, "admin", (await store.getCachedTools(server.id)).length) });
  });

  return app;
}
