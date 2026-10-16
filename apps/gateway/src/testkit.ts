import { z } from "zod";
import { createMcpApp, type ToolDefinition } from "@urumi/mcp-http";
import { createGatewayApp, type GatewayEnv } from "./app.ts";
import { createApiToken, encryptSecret, hashPassword, sha256Hex } from "./crypto.ts";
import { MemoryStore } from "./memory-store.ts";
import { ToolRouter } from "./router.ts";
import type { Role } from "./types.ts";

export const credentialKey = Buffer.alloc(32, 9).toString("base64");
export const env: GatewayEnv = { sessionSecret: "session-secret-session-secret", credentialKey, cookieSecure: false, allowlist: ["127.0.0.1"], internalToken: "internal-test-token" };

export const mcpHeaders = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2025-06-18" });

export async function listenUpstream(name: string, delayMs = 0, tools?: ToolDefinition[]) {
  const seen: string[] = [];
  const mcp = createMcpApp({
    name,
    version: "0.0.1",
    tools: () => tools ?? [{
      name: "echo",
      description: "echo",
      annotations: { readOnlyHint: true },
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

export type Account = { id: string; username: string; token: string; role: Role };

export async function addUser(store: MemoryStore, username: string, role: Role): Promise<Account> {
  const user = await store.insertUser({ username, passwordHash: await hashPassword("password-1"), role });
  const token = createApiToken();
  await store.insertApiKey({ userId: user.id, prefix: token.prefix, keyHash: await sha256Hex(token.token), label: username });
  return { id: user.id, username, token: token.token, role };
}

export async function gatewayFor(servers: Array<{ slug: string; url: string; bearer?: string }>, routerOptions: { maxResultBytes?: number; rateLimitPerMinute?: number; maxInflight?: number } = {}) {
  const store = new MemoryStore();
  const admin = await addUser(store, "ada", "admin");
  for (const server of servers) {
    await store.insertServer({
      slug: server.slug,
      displayName: server.slug,
      url: server.url,
      credentialType: server.bearer ? "bearer" : "none",
      credentialCiphertext: server.bearer ? await encryptSecret(server.bearer, credentialKey) : null,
    });
  }
  const router = new ToolRouter(store, { credentialKey, allowlist: env.allowlist, rateLimitPerMinute: 60, ...routerOptions });
  return { app: createGatewayApp(store, router, env), store, router, token: admin.token, admin };
}

export async function rpc(app: { request: (path: string, init: RequestInit) => Response | Promise<Response> }, token: string, method: string, params?: Record<string, unknown>, path = "/mcp") {
  const response = await app.request(path, { method: "POST", headers: mcpHeaders(token), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return { status: response.status, body: await response.json() as { result?: any; error?: { code: number; message: string; data?: { code?: string } } } };
}

export async function loginCookie(app: { request: (path: string, init: RequestInit) => Response | Promise<Response> }, username: string, password = "password-1") {
  const response = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "10.9.9.9" }, body: JSON.stringify({ username, password }) });
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { response, cookie };
}
