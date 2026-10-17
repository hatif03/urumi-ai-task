import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { clientIp, SESSION_COOKIE, SESSION_SECONDS, type GatewayEnv } from "../auth.ts";
import { createApiToken, hashPassword, sha256Hex, signSession, verifyPassword } from "../crypto.ts";
import type { Store } from "../store.ts";
import type { Role, User } from "../types.ts";

export function publicUser(user: User) {
  return { id: user.id, username: user.username, role: user.role, disabledAt: user.disabledAt, createdAt: user.createdAt };
}

function publicKey(key: { id: string; prefix: string; label: string; createdAt: string; revokedAt: string | null; lastUsedAt: string | null }) {
  return { id: key.id, prefix: key.prefix, label: key.label, createdAt: key.createdAt, revokedAt: key.revokedAt, lastUsedAt: key.lastUsedAt };
}

const MIN_PASSWORD = 8;

// Public routes: login and logout. Everything else in this file is mounted behind the session check.
export function publicAccountRoutes(store: Store, env: GatewayEnv) {
  const app = new Hono();

  app.post("/api/login", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { username?: string; password?: string };
    const username = String(body.username ?? "").slice(0, 100);
    // Two buckets: one per client address (slows a spray across usernames) and one per username
    // (slows a guess against one account). Both are shared by every gateway replica.
    const ipOk = await store.consumeToken(`login:ip:${clientIp(c.req.raw)}`, 20);
    const userOk = await store.consumeToken(`login:user:${username.toLowerCase()}`, 8);
    if (!ipOk || !userOk) return c.json({ error: "too many attempts, wait a minute" }, 429);
    const user = username ? await store.getUserByUsername(username) : null;
    // verifyPassword runs against a dummy hash when the user is missing so timing does not reveal accounts.
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const valid = body.password ? await verifyPassword(body.password, hash) : false;
    if (!user || user.disabledAt || !valid) return c.json({ error: "invalid username or password" }, 401);
    const token = await signSession({ uid: user.id, role: user.role, exp: Date.now() + SESSION_SECONDS * 1000 }, env.sessionSecret);
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: env.cookieSecure, path: "/", maxAge: SESSION_SECONDS });
    return c.json({ user: publicUser(user) });
  });

  app.post("/api/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  return app;
}

let DUMMY_HASH = "";
hashPassword("not-a-real-password").then((hash) => { DUMMY_HASH = hash; });

export function accountRoutes(store: Store) {
  const app = new Hono();

  app.get("/api/me", (c) => c.json({ user: publicUser(c.get("user")) }));

  app.post("/api/me/password", async (c) => {
    const user = c.get("user");
    const body = await c.req.json().catch(() => ({})) as { current?: string; next?: string };
    if (!body.current || !body.next || body.next.length < MIN_PASSWORD) return c.json({ error: `new password must be at least ${MIN_PASSWORD} characters` }, 400);
    if (!(await verifyPassword(body.current, user.passwordHash))) return c.json({ error: "current password is wrong" }, 403);
    await store.setUserPassword(user.id, await hashPassword(body.next));
    return c.json({ ok: true });
  });

  app.get("/api/api-keys", async (c) => {
    const keys = await store.listApiKeys(c.get("user").id);
    return c.json({ keys: keys.map(publicKey) });
  });

  app.post("/api/api-keys", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { label?: string };
    const created = createApiToken();
    const key = await store.insertApiKey({
      userId: c.get("user").id,
      prefix: created.prefix,
      keyHash: await sha256Hex(created.token),
      label: String(body.label || "default").slice(0, 80),
    });
    return c.json({ key: publicKey(key), token: created.token }, 201);
  });

  // A member can revoke only their own key; an admin can revoke anyone's.
  app.delete("/api/api-keys/:id", async (c) => {
    const user = c.get("user");
    const revoked = await store.revokeApiKey(c.req.param("id"), user.role === "admin" ? null : user.id);
    if (!revoked) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}

export function memberRoutes(store: Store) {
  const app = new Hono();
  app.use("/api/members/*", async (c, next) => (c.get("user").role === "admin" ? next() : c.json({ error: "forbidden" }, 403)));
  app.use("/api/members", async (c, next) => (c.get("user").role === "admin" ? next() : c.json({ error: "forbidden" }, 403)));

  app.get("/api/members", async (c) => {
    const [users, keys] = await Promise.all([store.listUsers(), store.listAllApiKeys()]);
    return c.json({
      members: users.map((user) => ({
        ...publicUser(user),
        keys: keys.filter((key) => key.userId === user.id).map(publicKey),
      })),
    });
  });

  app.post("/api/members", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { username?: string; password?: string; role?: Role };
    const username = String(body.username ?? "").trim();
    if (!/^[A-Za-z0-9._-]{2,40}$/.test(username)) return c.json({ error: "username must be 2-40 letters, digits, dot, dash or underscore" }, 400);
    if (!body.password || body.password.length < MIN_PASSWORD) return c.json({ error: `password must be at least ${MIN_PASSWORD} characters` }, 400);
    if (body.role && body.role !== "admin" && body.role !== "member") return c.json({ error: "role must be admin or member" }, 400);
    if (await store.getUserByUsername(username)) return c.json({ error: "username already exists" }, 409);
    const user = await store.insertUser({ username, passwordHash: await hashPassword(body.password), role: body.role ?? "member" });
    return c.json({ user: publicUser(user) }, 201);
  });

  // Disable, enable, or change role. The last active admin can be neither disabled nor demoted.
  app.patch("/api/members/:id", async (c) => {
    const target = await store.getUser(c.req.param("id"));
    if (!target) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({})) as { disabled?: boolean; role?: Role };
    const losesAdmin = target.role === "admin" && !target.disabledAt && (body.disabled === true || body.role === "member");
    if (losesAdmin && (await store.countActiveAdmins()) <= 1) return c.json({ error: "cannot remove the last active admin" }, 409);
    if (body.disabled !== undefined) await store.setUserDisabled(target.id, body.disabled);
    if (body.role) {
      if (body.role !== "admin" && body.role !== "member") return c.json({ error: "role must be admin or member" }, 400);
      await store.setUserRole(target.id, body.role);
    }
    return c.json({ user: publicUser((await store.getUser(target.id))!) });
  });

  app.post("/api/members/:id/password", async (c) => {
    const target = await store.getUser(c.req.param("id"));
    if (!target) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({})) as { password?: string };
    if (!body.password || body.password.length < MIN_PASSWORD) return c.json({ error: `password must be at least ${MIN_PASSWORD} characters` }, 400);
    await store.setUserPassword(target.id, await hashPassword(body.password));
    return c.json({ ok: true });
  });

  return app;
}
