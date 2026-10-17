import { Hono, type Context } from "hono";
import { clientIp, publicBase, userFromCookie, type GatewayEnv, type McpCaller } from "./auth.ts";
import { hmac, safeEqual, sha256Hex } from "./crypto.ts";
import { resolveUpstream } from "./ssrf.ts";
import type { Store } from "./store.ts";
import type { OAuthClient } from "./types.ts";

// OAuth 2.1 authorization server and resource server for /mcp, following the MCP authorization spec:
// protected resource metadata (RFC 9728), authorization server metadata (RFC 8414), public clients
// with PKCE S256 only, the resource parameter (RFC 8707) bound to the token audience, issuer
// identification in the response (RFC 9207), Client ID Metadata Documents and Dynamic Client
// Registration (RFC 7591) for client identity, refresh rotation with reuse detection.
// Tokens are opaque and stored as SHA-256, like API keys, so revocation is a row update.

const CODE_SECONDS = 600;
const ACCESS_SECONDS = 3600;
const REFRESH_SECONDS = 30 * 86400;
const SCOPE = "mcp";
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "ftp:"]);

const rand = (prefix: string) => `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
const resourceFor = (request: Request | Context, env: GatewayEnv) => `${publicBase(request as Request, env)}/mcp`;
const nowPlus = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

export function validRedirectUri(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length > 2000 || /\s/.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || BLOCKED_SCHEMES.has(url.protocol)) return false;
  if (url.protocol === "https:") return !url.username && !url.password;
  if (url.protocol === "http:") return isLoopback(url.hostname);
  return true; // private-use scheme for a native app, e.g. cursor:// or vscode://
}

const isLoopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

// Exact match, except that a loopback redirect may use any port (RFC 8252 section 7.3).
export function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (want.protocol !== "http:" || !isLoopback(want.hostname)) return false;
  return registered.some((entry) => {
    const url = new URL(entry);
    return url.protocol === "http:" && url.hostname === want.hostname && url.pathname === want.pathname && url.search === want.search;
  });
}

export function parseClientMetadata(doc: unknown, clientId: string): Omit<OAuthClient, "createdAt"> | string {
  const meta = (doc ?? {}) as Record<string, unknown>;
  if (meta.client_id !== clientId) return "client_id in the document does not match its URL";
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(validRedirectUri)) return "redirect_uris is missing or has an unacceptable entry";
  const method = meta.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") return "only public clients (token_endpoint_auth_method none) are supported";
  const name = typeof meta.client_name === "string" && meta.client_name.trim() ? meta.client_name.trim().slice(0, 80) : new URL(clientId).hostname;
  return { clientId, name, redirectUris: uris as string[], kind: "cimd" };
}

// A client_id that is an https URL names a metadata document. The fetch is an SSRF risk by design (the
// URL is attacker-chosen), so it goes through the same resolver as admin-supplied upstream URLs.
async function loadCimdClient(clientId: string, env: GatewayEnv): Promise<Omit<OAuthClient, "createdAt"> | string> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return "invalid client_id";
  }
  if (url.protocol !== "https:" || url.pathname === "/" || url.hash || url.username) return "client_id must be an https URL with a path";
  try {
    await resolveUpstream(clientId, env.allowlist);
    const response = await fetch(clientId, { redirect: "error", signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
    if (!response.ok) return "client metadata document could not be fetched";
    const text = await response.text();
    if (text.length > 10_000) return "client metadata document is too large";
    return parseClientMetadata(JSON.parse(text), clientId);
  } catch {
    return "client metadata document could not be fetched";
  }
}

const esc = (value: string) => value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px system-ui,sans-serif;max-width:30rem;margin:12vh auto;padding:0 1rem;color:#1c1917}button{font:inherit;padding:.6rem 1.2rem;margin-right:.5rem;cursor:pointer}.allow{background:#1c1917;color:#fff;border:0;border-radius:6px}.deny{background:#fff;border:1px solid #c9c2b8;border-radius:6px}code{background:#f3efe8;padding:.1rem .3rem}</style>${body}`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", "cache-control": "no-store" } });
}

type AuthParams = { client_id: string; redirect_uri: string; code_challenge: string; state: string; resource: string };

// The consent form carries the validated request in hidden fields. The signature binds them to the
// signed-in user and an expiry, so the POST cannot be forged or edited, and it doubles as the CSRF token.
async function sign(params: AuthParams, userId: string, exp: number, secret: string): Promise<string> {
  return hmac(JSON.stringify([params.client_id, params.redirect_uri, params.code_challenge, params.state, params.resource, userId, exp]), secret);
}

function redirectWith(base: string, params: Record<string, string>): Response {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== "") url.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { location: url.toString(), "cache-control": "no-store" } });
}

export async function callerFromOAuthToken(token: string, store: Store, request: Request, env: GatewayEnv): Promise<McpCaller | null> {
  if (!token.startsWith("umo_")) return null;
  const row = await store.findOAuthToken(await sha256Hex(token));
  if (!row || row.kind !== "access" || row.revokedAt || Date.parse(row.expiresAt) < Date.now()) return null;
  // Audience binding: a token issued for another resource is not accepted here.
  if (row.resource !== resourceFor(request, env)) return null;
  const user = await store.getUser(row.userId);
  if (!user || user.disabledAt) return null;
  await store.touchOAuthToken(row.id);
  return { userId: user.id, role: user.role, apiKeyId: null, oauthTokenId: row.id, actor: "mcp" };
}

export function oauthRoutes(store: Store, env: GatewayEnv) {
  const app = new Hono();
  const metadataHeaders = { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" };

  // RFC 9728. Served at the root form and the path-suffixed form for the resource https://host/mcp.
  const resourceMetadata = (c: Context) => c.json({
    resource: resourceFor(c, env),
    authorization_servers: [publicBase(c, env)],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
    resource_name: "Urumi MCP gateway",
  }, 200, metadataHeaders);
  app.get("/.well-known/oauth-protected-resource", resourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", resourceMetadata);

  // RFC 8414.
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const base = publicBase(c, env);
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    }, 200, metadataHeaders);
  });

  // RFC 7591, public clients only. Deprecated in the newest spec draft in favour of Client ID Metadata
  // Documents but still what Claude Code, Cursor and MCP Inspector use today.
  app.post("/oauth/register", async (c) => {
    if (!(await store.consumeToken(`oauth-register:${clientIp(c.req.raw)}`, 10))) return c.json({ error: "slow_down" }, 429);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(validRedirectUri)) return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be https, http loopback, or a private-use scheme" }, 400);
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") return c.json({ error: "invalid_client_metadata", error_description: "only token_endpoint_auth_method none is supported" }, 400);
    const clientId = rand("urumi_c_").slice(0, 40);
    const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : "MCP client";
    await store.upsertOAuthClient({ clientId, name, redirectUris: uris as string[], kind: "dcr" });
    return c.json({ client_id: clientId, client_name: name, redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", client_id_issued_at: Math.floor(Date.now() / 1000) }, 201);
  });

  async function resolveClient(clientId: string): Promise<Omit<OAuthClient, "createdAt"> | string> {
    if (clientId.startsWith("https://")) {
      const loaded = await loadCimdClient(clientId, env);
      if (typeof loaded !== "string") await store.upsertOAuthClient(loaded);
      return loaded;
    }
    return (await store.getOAuthClient(clientId)) ?? "unknown client_id";
  }

  app.get("/oauth/authorize", async (c) => {
    const q = c.req.query();
    const clientId = q.client_id ?? "";
    const client = clientId ? await resolveClient(clientId) : "client_id is required";
    if (typeof client === "string") return page("Cannot authorize", `<h1>Cannot authorize</h1><p>${esc(client)}</p>`, 400);
    // Until the redirect_uri is proven to belong to the client, errors are shown here and never redirected.
    if (!q.redirect_uri || !redirectMatches(client.redirectUris, q.redirect_uri)) return page("Cannot authorize", "<h1>Cannot authorize</h1><p>The redirect URI does not match the client's registration.</p>", 400);
    const redirectUri = q.redirect_uri;
    const fail = (error: string, description: string) => redirectWith(redirectUri, { error, error_description: description, state: q.state ?? "", iss: publicBase(c, env) });
    if (q.response_type !== "code") return fail("unsupported_response_type", "response_type must be code");
    if (!q.code_challenge || q.code_challenge_method !== "S256") return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
    const canonical = resourceFor(c, env);
    if (q.resource && q.resource.replace(/\/$/, "") !== canonical) return fail("invalid_target", `resource must be ${canonical}`);

    const user = await userFromCookie(c.req.raw, store, env);
    if (!user) {
      const here = new URL(c.req.url);
      return new Response(null, { status: 302, headers: { location: `/login?next=${encodeURIComponent(here.pathname + here.search)}` } });
    }

    const params: AuthParams = { client_id: client.clientId, redirect_uri: redirectUri, code_challenge: q.code_challenge, state: q.state ?? "", resource: canonical };
    const exp = Date.now() + CODE_SECONDS * 1000;
    const sig = await sign(params, user.id, exp, env.sessionSecret);
    const target = new URL(redirectUri);
    const origin = client.kind === "cimd" ? new URL(client.clientId).host : target.protocol === "http:" || target.protocol === "https:" ? target.host : target.protocol;
    const hidden = Object.entries({ ...params, exp: String(exp), sig }).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("");
    return page("Authorize access", `<h1>Authorize <em>${esc(client.name)}</em>?</h1>
<p>This application (<code>${esc(origin)}</code>) is asking to use the Urumi gateway's tools as <strong>${esc(user.username)}</strong>.</p>
<p>It can call any tool you are permitted to call. Every call is recorded in the audit log under your name. You can revoke access from the dashboard.</p>
<form method="post" action="/oauth/authorize">${hidden}<button class="allow" name="decision" value="allow">Allow</button><button class="deny" name="decision" value="deny">Deny</button></form>`);
  });

  app.post("/oauth/authorize", async (c) => {
    const user = await userFromCookie(c.req.raw, store, env);
    if (!user) return page("Sign in required", "<h1>Sign in required</h1><p>Your session expired. Start again from the application.</p>", 401);
    const f = await c.req.parseBody() as Record<string, string>;
    const params: AuthParams = { client_id: f.client_id ?? "", redirect_uri: f.redirect_uri ?? "", code_challenge: f.code_challenge ?? "", state: f.state ?? "", resource: f.resource ?? "" };
    const exp = Number(f.exp);
    const good = exp > Date.now() && safeEqual(f.sig ?? "", await sign(params, user.id, exp, env.sessionSecret));
    if (!good) return page("Request expired", "<h1>Request expired</h1><p>Start again from the application.</p>", 400);
    const client = await store.getOAuthClient(params.client_id);
    if (!client || !redirectMatches(client.redirectUris, params.redirect_uri)) return page("Cannot authorize", "<h1>Cannot authorize</h1>", 400);
    const iss = publicBase(c, env);
    if (f.decision !== "allow") return redirectWith(params.redirect_uri, { error: "access_denied", state: params.state, iss });
    const code = rand("umc_");
    await store.insertOAuthCode({ codeHash: await sha256Hex(code), clientId: client.clientId, userId: user.id, redirectUri: params.redirect_uri, codeChallenge: params.code_challenge, resource: params.resource, familyId: crypto.randomUUID(), expiresAt: nowPlus(CODE_SECONDS) });
    return redirectWith(params.redirect_uri, { code, state: params.state, iss });
  });

  const tokenError = (c: Context, error: string, description: string, status = 400) => c.json({ error, error_description: description }, status as 400, { "cache-control": "no-store", pragma: "no-cache" });

  async function issuePair(c: Context, input: { familyId: string; clientId: string; userId: string; resource: string }) {
    const access = rand("umo_");
    const refresh = rand("umr_");
    await store.insertOAuthToken({ id: crypto.randomUUID(), tokenHash: await sha256Hex(access), kind: "access", expiresAt: nowPlus(ACCESS_SECONDS), ...input });
    await store.insertOAuthToken({ id: crypto.randomUUID(), tokenHash: await sha256Hex(refresh), kind: "refresh", expiresAt: nowPlus(REFRESH_SECONDS), ...input });
    return c.json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: SCOPE }, 200, { "cache-control": "no-store", pragma: "no-cache" });
  }

  app.post("/oauth/token", async (c) => {
    if (!(await store.consumeToken(`oauth-token:${clientIp(c.req.raw)}`, 60))) return tokenError(c, "slow_down", "too many requests", 429);
    const contentType = c.req.header("content-type") ?? "";
    const f = (contentType.includes("json") ? await c.req.json().catch(() => ({})) : await c.req.parseBody().catch(() => ({}))) as Record<string, string>;

    if (f.grant_type === "authorization_code") {
      const consumed = await store.consumeOAuthCode(await sha256Hex(f.code ?? ""));
      if (consumed.status === "replayed") {
        await store.revokeOAuthFamily(consumed.familyId); // a code used twice means it leaked: undo what the first use issued
        return tokenError(c, "invalid_grant", "authorization code already used");
      }
      if (consumed.status !== "ok") return tokenError(c, "invalid_grant", "invalid or expired code");
      const code = consumed.code;
      if (f.client_id !== code.clientId || f.redirect_uri !== code.redirectUri) return tokenError(c, "invalid_grant", "client_id or redirect_uri does not match the authorization request");
      if (f.resource && f.resource.replace(/\/$/, "") !== code.resource) return tokenError(c, "invalid_target", "resource does not match the authorization request");
      const verifier = f.code_verifier ?? "";
      const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
      if (verifier.length < 43 || verifier.length > 128 || !safeEqual(challenge, code.codeChallenge)) return tokenError(c, "invalid_grant", "PKCE verification failed");
      return issuePair(c, { familyId: code.familyId, clientId: code.clientId, userId: code.userId, resource: code.resource });
    }

    if (f.grant_type === "refresh_token") {
      const row = await store.findOAuthToken(await sha256Hex(f.refresh_token ?? ""));
      if (!row || row.kind !== "refresh" || Date.parse(row.expiresAt) < Date.now() || (f.client_id && f.client_id !== row.clientId)) return tokenError(c, "invalid_grant", "invalid refresh token");
      // Rotation: a refresh token works once. If it was already used (or revoked), someone is replaying it.
      if (!(await store.revokeOAuthToken(row.id))) {
        await store.revokeOAuthFamily(row.familyId);
        return tokenError(c, "invalid_grant", "refresh token reuse detected, the grant was revoked");
      }
      const user = await store.getUser(row.userId);
      if (!user || user.disabledAt) return tokenError(c, "invalid_grant", "user is disabled");
      return issuePair(c, { familyId: row.familyId, clientId: row.clientId, userId: row.userId, resource: row.resource });
    }
    return tokenError(c, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  });

  // RFC 7009: revoking a token revokes its whole grant. Always 200 so a caller cannot probe for tokens.
  app.post("/oauth/revoke", async (c) => {
    const f = await c.req.parseBody().catch(() => ({})) as Record<string, string>;
    const row = f.token ? await store.findOAuthToken(await sha256Hex(f.token)) : null;
    if (row) await store.revokeOAuthFamily(row.familyId);
    return c.body(null, 200);
  });

  // The dashboard lists and revokes the apps the signed-in user has authorised.
  app.get("/api/oauth/grants", async (c) => c.json({ grants: await store.listOAuthGrants(c.get("user").id) }));
  app.delete("/api/oauth/grants/:familyId", async (c) => {
    const user = c.get("user");
    const owned = (await store.listOAuthGrants(user.id)).some((grant) => grant.familyId === c.req.param("familyId"));
    if (!owned) return c.json({ error: "not found" }, 404);
    await store.revokeOAuthFamily(c.req.param("familyId"));
    return c.json({ ok: true });
  });

  return app;
}
