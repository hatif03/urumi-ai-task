import { Hono } from "hono";
import { metrics } from "@urumi/obs";
import { statusCounts } from "./db.ts";
import { createHosted, deleteHosted, HostedError, listHosted, retryHosted, SIZES, type HostedInput } from "./hosted.ts";
import { createStore, deleteStore, listStores, retryStore, StoreError } from "./stores.ts";
import type { Deps } from "./worker.ts";

// Internal API for the gateway. Only the gateway pod can reach it (NetworkPolicy) and every call must
// carry the shared token. The gateway has already authenticated the user and passes who they are in
// headers; the provisioner trusts those headers only because of the token.
export function createApi(deps: Deps, token: string) {
  const app = new Hono();
  const { sql, config } = deps;

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", async (c) => {
    try {
      await sql`select 1`;
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const given = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token || given.length !== token.length || !timingSafe(given, token)) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.header("x-urumi-user-id");
    const username = c.req.header("x-urumi-username");
    const role = c.req.header("x-urumi-role");
    if (!id || !username || (role !== "admin" && role !== "member")) return c.json({ error: "missing caller identity" }, 400);
    c.set("caller", { id, username, role });
    return next();
  });

  const guard = async (c: { json: (body: unknown, status?: number) => Response }, run: () => Promise<Response>) => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof StoreError || error instanceof HostedError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  };

  app.get("/v1/stores", async (c) => c.json(await listStores(sql, config, c.get("caller"))));
  app.post("/v1/stores", (c) => guard(c, async () => {
    const body = await c.req.json().catch(() => ({})) as { name?: string };
    const { store, created } = await createStore(sql, config, c.get("caller"), String(body.name ?? ""));
    return c.json({ store }, created ? 201 : 200);
  }));
  app.post("/v1/stores/:id/retry", (c) => guard(c, async () => c.json({ store: await retryStore(sql, config, c.get("caller"), c.req.param("id")) }, 202)));
  app.delete("/v1/stores/:id", (c) => guard(c, async () => c.json({ store: await deleteStore(sql, config, c.get("caller"), c.req.param("id")) }, 202)));

  const isAdmin = (c: { get: (key: "caller") => { role: string } }) => c.get("caller").role === "admin";
  app.get("/v1/hosted", async (c) => (isAdmin(c) ? c.json({ hosted: await listHosted(sql), registries: config.hostedRegistries, sizes: Object.keys(SIZES) }) : c.json({ error: "forbidden" }, 403)));
  app.post("/v1/hosted", (c) => guard(c, async () => {
    if (!isAdmin(c)) return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json().catch(() => ({})) as HostedInput;
    return c.json({ hosted: await createHosted(sql, deps.kube, config, c.get("caller").id, body) }, 201);
  }));
  app.post("/v1/hosted/:id/retry", (c) => guard(c, async () => (isAdmin(c) ? c.json({ hosted: await retryHosted(sql, config, c.req.param("id")) }, 202) : c.json({ error: "forbidden" }, 403))));
  app.delete("/v1/hosted/:id", (c) => guard(c, async () => (isAdmin(c) ? c.json({ hosted: await deleteHosted(sql, c.req.param("id")) }, 202) : c.json({ error: "forbidden" }, 403))));

  app.get("/metrics", async () => {
    for (const table of ["stores", "hosted_servers"] as const) {
      const counts = await statusCounts(sql, table);
      for (const status of ["provisioning", "ready", "failed", "deleting"]) metrics.setGauge(table === "stores" ? "stores_by_status" : "hosted_by_status", { status }, counts[status] ?? 0);
    }
    return new Response(metrics.render(), { headers: { "content-type": "text/plain; version=0.0.4" } });
  });

  return app;
}

function timingSafe(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

declare module "hono" {
  interface ContextVariableMap {
    caller: { id: string; username: string; role: "admin" | "member" };
  }
}
