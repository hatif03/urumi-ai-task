import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createMcpApp } from "@urumi/mcp-http";
import { createGatewayApp, type GatewayEnv } from "./app.ts";
import { encryptSecret, hashPassword, sha256Hex } from "./crypto.ts";
import { MemoryStore } from "./memory-store.ts";
import { ToolRouter } from "./router.ts";
import { createApiToken } from "./crypto.ts";

const credentialKey = Buffer.alloc(32, 9).toString("base64");
const env: GatewayEnv = { sessionSecret: "session-secret-session-secret", credentialKey, cookieSecure: false, allowlist: ["127.0.0.1"] };

async function listenUpstream(name: string, delayMs = 0) {
  const seen: string[] = [];
  const mcp = createMcpApp({
    name,
    version: "0.0.1",
    tools: () => [{
      name: "echo",
      description: "echo",
      inputSchema: z.object({ message: z.string() }),
      handler: async (args) => ({ content: [{ type: "text", text: String(args.message) }], structuredContent: { message: args.message } }),
    }],
  });
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push(req.headers.get("authorization") ?? "");
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return mcp.fetch(req);
    },
  });
  return { server, seen, url: `http://127.0.0.1:${server.port}/mcp` };
}

async function gatewayFor(servers: Array<{ slug: string; url: string; bearer?: string }>) {
  const store = new MemoryStore();
  const user = await store.insertUser({ username: "ada", passwordHash: await hashPassword("password-1"), role: "admin" });
  const token = createApiToken();
  await store.insertApiKey({ userId: user.id, prefix: token.prefix, keyHash: await sha256Hex(token.token), label: "ada" });
  for (const server of servers) {
    await store.insertServer({
      slug: server.slug,
      displayName: server.slug,
      url: server.url,
      credentialType: server.bearer ? "bearer" : "none",
      credentialCiphertext: server.bearer ? await encryptSecret(server.bearer, credentialKey) : null,
    });
  }
  const router = new ToolRouter(store, { credentialKey, allowlist: env.allowlist, rateLimitPerMinute: 60 });
  return { app: createGatewayApp(store, router, env), store, token: token.token };
}

describe("gateway", () => {
  test("lists the healthy server when another upstream sleeps past 3s", async () => {
    const healthy = await listenUpstream("utility");
    const slow = await listenUpstream("policy", 4000);
    const ctx = await gatewayFor([
      { slug: "utility", url: healthy.url, bearer: "upstream-secret" },
      { slug: "policy", url: slow.url },
    ]);
    try {
      const response = await ctx.app.request("/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.token}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const body = await response.json();
      const names = body.result.tools.map((tool: { name: string }) => tool.name);
      expect(names).toContain("utility__echo");
      expect(names.some((name: string) => name.startsWith("policy__"))).toBe(false);
    } finally {
      healthy.server.stop(true);
      slow.server.stop(true);
    }
  }, 20_000);

  test("a dead upstream times out and the next healthy call still works", async () => {
    const healthy = await listenUpstream("utility");
    const ctx = await gatewayFor([
      { slug: "utility", url: healthy.url, bearer: "upstream-secret" },
      { slug: "dead", url: "http://127.0.0.1:1/mcp" },
    ]);
    try {
      const headers = { authorization: `Bearer ${ctx.token}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2025-06-18" };
      const dead = await ctx.app.request("/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dead__echo", arguments: {} } }),
      });
      const deadBody = await dead.json();
      expect(["upstream_timeout", "upstream_unreachable"]).toContain(deadBody.error?.data?.code);
      const live = await ctx.app.request("/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "utility__echo", arguments: { message: "hi" } } }),
      });
      const liveBody = await live.json();
      expect(JSON.stringify(liveBody)).toContain("hi");
      expect(healthy.seen.some((header) => header.includes("upstream-secret"))).toBe(true);
      expect(healthy.seen.some((header) => header.includes(ctx.token))).toBe(false);
    } finally {
      healthy.server.stop(true);
    }
  }, 20_000);

  test("a revoked key returns 401 and writes an audit row", async () => {
    const healthy = await listenUpstream("utility");
    const ctx = await gatewayFor([{ slug: "utility", url: healthy.url }]);
    try {
      const key = ctx.store.keys[0]!;
      key.revokedAt = new Date().toISOString();
      const response = await ctx.app.request("/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
      });
      expect(response.status).toBe(401);
      expect(ctx.store.audits.some((row) => row.outcome === "unauthorized")).toBe(true);
    } finally {
      healthy.server.stop(true);
    }
  });
});
