import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { createGatewayApp } from "./app.ts";
import { createApiToken, hashPassword, sha256Hex } from "./crypto.ts";
import * as schema from "./db/schema.ts";
import { runMigrations } from "./migrate.ts";
import { migrations } from "./migrations.ts";
import { createPostgresStore } from "./postgres.ts";
import { ToolRouter } from "./router.ts";
import { credentialKey, env as gatewayEnv, listenUpstream } from "./testkit.ts";

// Needs a real Postgres: TEST_DATABASE_URL=postgres://urumi:test@127.0.0.1:55432/urumi bun test
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("postgres store", () => {
  let sql: SQL;
  let store: ReturnType<typeof createPostgresStore>;

  beforeAll(async () => {
    sql = new SQL(url!);
    await sql.unsafe("drop schema public cascade; create schema public");
    // two replicas start together: the advisory lock must make this safe
    const [first, second] = await Promise.all([runMigrations(sql), runMigrations(new SQL(url!))]);
    expect([...first, ...second].sort()).toEqual(migrations.map((m) => m.version));
    store = createPostgresStore(url!);
  });
  afterAll(async () => {
    await store?.close();
    await sql?.end();
  });

  test("migrations are recorded and a second run applies nothing", async () => {
    expect(await runMigrations(sql)).toEqual([]);
    const rows = await sql`select version from schema_migrations order by version`;
    expect(rows.map((r: { version: number }) => Number(r.version))).toEqual(migrations.map((m) => m.version));
  });

  test("the typed schema and the migrations describe the same tables and columns", async () => {
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const table = getTableName(value);
      const columns = await sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}`;
      const have = new Set(columns.map((c: { column_name: string }) => c.column_name));
      const want = Object.values(getTableColumns(value)).map((c) => c.name);
      expect({ table, missing: want.filter((name) => !have.has(name)) }).toEqual({ table, missing: [] });
    }
  });

  test("users, roles, active-admin count", async () => {
    const admin = await store.insertUser({ username: "ada", passwordHash: "h", role: "admin" });
    const member = await store.insertUser({ username: "bea", passwordHash: "h", role: "member" });
    expect(await store.countActiveAdmins()).toBe(1);
    await store.setUserRole(member.id, "admin");
    expect(await store.countActiveAdmins()).toBe(2);
    await store.setUserDisabled(member.id, true);
    expect(await store.countActiveAdmins()).toBe(1);
    await store.setUserDisabled(member.id, false);
    await store.setUserRole(member.id, "member");
    expect((await store.getUser(member.id))?.disabledAt).toBeNull();
    expect(admin.role).toBe("admin");
  });

  test("audit joins the username, filters in SQL, and pages by id", async () => {
    const ada = (await store.getUserByUsername("ada"))!;
    const bea = (await store.getUserByUsername("bea"))!;
    const row = (userId: string, tool: string, outcome: "success" | "denied") => store.insertAudit({ userId, apiKeyId: null, actor: "mcp", serverSlug: "shop", toolName: tool, durationMs: 12.5, outcome, errorCode: null, traceId: "t" });
    for (let i = 0; i < 5; i++) await row(ada.id, "list_orders", "success");
    await row(bea.id, "create_product", "denied");
    const page = await store.listAudit({ limit: 2 });
    expect(page.map((r) => r.username)).toEqual(["bea", "ada"]);
    expect(page[0]!.durationMs).toBe(12.5);
    const next = await store.listAudit({ limit: 100, beforeId: page[1]!.id });
    expect(next.length).toBe(4);
    // the filter is applied before the limit: the single denied row is found although it is not in the newest 1
    await row(ada.id, "list_orders", "success");
    expect((await store.listAudit({ outcome: "denied", limit: 1 })).map((r) => r.toolName)).toEqual(["create_product"]);
    expect((await store.listAudit({ userId: bea.id })).length).toBe(1);
    expect((await store.listAudit({ from: new Date(Date.now() + 60_000).toISOString() })).length).toBe(0);
  });

  test("grants upsert on their natural key and delete", async () => {
    const first = await store.upsertGrant({ subjectType: "role", subject: "member", serverSlug: "shop", toolName: "*", effect: "allow", createdBy: null });
    const again = await store.upsertGrant({ subjectType: "role", subject: "member", serverSlug: "shop", toolName: "*", effect: "deny", createdBy: null });
    expect(again.id).toBe(first.id);
    expect((await store.listGrants()).map((g) => g.effect)).toEqual(["deny"]);
    expect(await store.deleteGrant(first.id)).toBe(true);
    expect(await store.deleteGrant(first.id)).toBe(false);
  });

  test("the shared token bucket allows a burst, then refuses, per key", async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) results.push(await store.consumeToken("login:test", 3));
    expect(results).toEqual([true, true, true, false, false]);
    expect(await store.consumeToken("login:other", 3)).toBe(true);
  });

  test("tool annotations survive the cache and a server delete cascades", async () => {
    const server = await store.insertServer({ slug: "shop", displayName: "Shop", url: "http://x" });
    await store.replaceTools(server.id, [{ upstreamName: "list_orders", description: "d", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }]);
    expect((await store.getCachedTools(server.id))[0]!.annotations).toEqual({ readOnlyHint: true });
    await store.deleteServer(server.id);
    expect(await store.getCachedTools(server.id)).toEqual([]);
  });

  test("replacing a server's tool list is atomic: a reader never sees it empty", async () => {
    const server = await store.insertServer({ slug: "flip", displayName: "Flip", url: "http://x" });
    const tools = [
      { upstreamName: "a", description: "d", inputSchema: { type: "object" }, annotations: {} },
      { upstreamName: "b", description: "d", inputSchema: { type: "object" }, annotations: {} },
    ];
    await store.replaceTools(server.id, tools);
    let writing = true;
    let empties = 0;
    const reader = (async () => { while (writing) { if ((await store.getCachedTools(server.id)).length === 0) empties++; } })();
    for (let i = 0; i < 40; i++) await store.replaceTools(server.id, tools);
    writing = false;
    await reader;
    expect(empties).toBe(0);
    await store.deleteServer(server.id);
  });

  // A cold replica takes many calls at once against the real database: they must share one upstream connection,
  // none may be told "unknown tool" while the tool cache refreshes, and all must succeed.
  test("sixty concurrent calls on a cold replica all succeed", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const user = await store.insertUser({ username: `conc${tag}`, passwordHash: await hashPassword("x"), role: "admin" });
    const token = createApiToken();
    await store.insertApiKey({ userId: user.id, prefix: token.prefix, keyHash: await sha256Hex(token.token), label: "k" });
    const upstream = await listenUpstream("utility");
    await store.insertServer({ slug: `conc${tag}`, displayName: "u", url: upstream.url });
    const router = new ToolRouter(store, { credentialKey, allowlist: gatewayEnv.allowlist, rateLimitPerMinute: 1000000, maxInflight: 1000 });
    const server = Bun.serve({ port: 0, fetch: createGatewayApp(store, router, gatewayEnv).fetch });
    const results = await Promise.all(Array.from({ length: 60 }, async () => {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        signal: AbortSignal.timeout(20000),
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `conc${tag}__echo`, arguments: { message: "x" } } }),
      });
      return ((await response.json()) as { result?: unknown }).result !== undefined;
    }));
    server.stop(true);
    upstream.server.stop(true);
    expect(results.filter(Boolean).length).toBe(60);
  }, 60_000);
});
