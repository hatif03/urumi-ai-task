import { Hono, type Context } from "hono";
import type { GatewayEnv } from "../auth.ts";

// The dashboard talks to the gateway; the gateway authenticates the user and forwards to the provisioner
// with the shared service token and the user's identity. The browser never reaches the provisioner, and
// the provisioner never sees a session cookie or an API key.
export function provisioningRoutes(env: GatewayEnv, fetchImpl: typeof fetch = fetch) {
  const app = new Hono();

  async function forward(c: Context, method: string, path: string, body?: unknown): Promise<Response> {
    if (!env.provisionerUrl || !env.provisionerToken) return c.json({ error: "provisioning is not enabled on this gateway" }, 501);
    const user = c.get("user");
    try {
      const response = await fetchImpl(`${env.provisionerUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${env.provisionerToken}`,
          "content-type": "application/json",
          "x-urumi-user-id": user.id,
          "x-urumi-username": user.username,
          "x-urumi-role": user.role,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      return new Response(text, { status: response.status, headers: { "content-type": "application/json" } });
    } catch {
      return c.json({ error: "the provisioner is not reachable" }, 502);
    }
  }

  const json = (c: Context) => c.req.json().catch(() => ({}));
  const adminOnly = (c: Context) => (c.get("user").role === "admin" ? null : c.json({ error: "forbidden" }, 403));

  app.get("/api/stores", (c) => forward(c, "GET", "/v1/stores"));
  app.post("/api/stores", async (c) => forward(c, "POST", "/v1/stores", await json(c)));
  app.post("/api/stores/:id/retry", (c) => forward(c, "POST", `/v1/stores/${encodeURIComponent(c.req.param("id"))}/retry`, {}));
  app.delete("/api/stores/:id", (c) => forward(c, "DELETE", `/v1/stores/${encodeURIComponent(c.req.param("id"))}`));

  app.get("/api/hosted", (c) => adminOnly(c) ?? forward(c, "GET", "/v1/hosted"));
  app.post("/api/hosted", async (c) => adminOnly(c) ?? forward(c, "POST", "/v1/hosted", await json(c)));
  app.post("/api/hosted/:id/retry", (c) => adminOnly(c) ?? forward(c, "POST", `/v1/hosted/${encodeURIComponent(c.req.param("id"))}/retry`, {}));
  app.delete("/api/hosted/:id", (c) => adminOnly(c) ?? forward(c, "DELETE", `/v1/hosted/${encodeURIComponent(c.req.param("id"))}`));

  return app;
}
