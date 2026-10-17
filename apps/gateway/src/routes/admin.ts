import { Hono } from "hono";
import type { Store } from "../store.ts";
import type { Outcome } from "../types.ts";

const OUTCOMES: Outcome[] = ["success", "error", "timeout", "unreachable", "denied", "unauthorized"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : new Date(value).toISOString();
}

export function adminRoutes(store: Store) {
  const app = new Hono();
  app.use("/api/audit", async (c, next) => (c.get("user").role === "admin" ? next() : c.json({ error: "forbidden" }, 403)));
  app.use("/api/grants/*", async (c, next) => (c.get("user").role === "admin" ? next() : c.json({ error: "forbidden" }, 403)));
  app.use("/api/grants", async (c, next) => (c.get("user").role === "admin" ? next() : c.json({ error: "forbidden" }, 403)));

  // Who called what, newest first, filtered in SQL and paged by id. `user` is a username or an id.
  app.get("/api/audit", async (c) => {
    const q = c.req.query();
    let userId: string | undefined;
    if (q.user) {
      userId = UUID.test(q.user) ? q.user : (await store.getUserByUsername(q.user))?.id;
      if (!userId) return c.json({ audit: [], nextBeforeId: null });
    }
    const outcome = OUTCOMES.includes(q.outcome as Outcome) ? (q.outcome as Outcome) : undefined;
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const rows = await store.listAudit({
      userId,
      serverSlug: q.server || undefined,
      toolName: q.tool || undefined,
      outcome,
      from: validDate(q.from),
      to: validDate(q.to),
      beforeId: Number(q.beforeId) || undefined,
      limit,
    });
    return c.json({ audit: rows, nextBeforeId: rows.length === limit ? rows[rows.length - 1]!.id : null });
  });

  app.get("/api/grants", async (c) => c.json({ grants: await store.listGrants() }));

  app.put("/api/grants", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { subjectType?: string; subject?: string; serverSlug?: string; toolName?: string; effect?: string };
    const toolName = body.toolName || "*";
    const serverSlug = body.serverSlug || "*";
    if (body.subjectType !== "role" && body.subjectType !== "user") return c.json({ error: "subjectType must be role or user" }, 400);
    if (body.effect !== "allow" && body.effect !== "deny") return c.json({ error: "effect must be allow or deny" }, 400);
    if (body.subjectType === "role" && body.subject !== "admin" && body.subject !== "member") return c.json({ error: "subject must be admin or member" }, 400);
    if (body.subjectType === "user" && !(body.subject && (await store.getUser(body.subject)))) return c.json({ error: "unknown user" }, 400);
    if (serverSlug !== "*" && !(await store.getServerBySlug(serverSlug))) return c.json({ error: "unknown server" }, 400);
    if (toolName !== "*" && serverSlug === "*") return c.json({ error: "a tool rule needs a server" }, 400);
    const grant = await store.upsertGrant({ subjectType: body.subjectType, subject: body.subject!, serverSlug, toolName, effect: body.effect, createdBy: c.get("user").id });
    return c.json({ grant }, 201);
  });

  app.delete("/api/grants/:id", async (c) => ((await store.deleteGrant(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)));

  return app;
}
