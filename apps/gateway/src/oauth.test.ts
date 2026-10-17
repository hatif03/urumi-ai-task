import { afterAll, describe, expect, test } from "bun:test";
import { addUser, gatewayFor, listenUpstream, loginCookie } from "./testkit.ts";
import { parseClientMetadata, redirectMatches, validRedirectUri } from "./oauth.ts";

const HOST = "gw.test";
const BASE = `http://${HOST}`;
const stops: Array<{ stop: (force?: boolean) => void }> = [];
afterAll(() => stops.forEach((s) => s.stop(true)));

const b64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes as Uint8Array).toString("base64url");
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

async function setup() {
  const upstream = await listenUpstream("utility");
  stops.push(upstream.server);
  const ctx = await gatewayFor([{ slug: "utility", url: upstream.url }]);
  const req = (path: string, init: RequestInit = {}) => ctx.app.request(path, { ...init, headers: { host: HOST, "x-real-ip": "10.1.1.1", ...(init.headers ?? {}) } });
  const register = async (redirect = "http://127.0.0.1:7777/callback") => {
    const response = await req("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test Client", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) });
    return (await response.json()) as { client_id: string };
  };
  // Runs the browser half: sign in, open the authorize URL, press Allow. Returns the redirect target.
  const authorize = async (clientId: string, challenge: string, opts: { redirect?: string; username?: string; state?: string; resource?: string; decision?: string } = {}) => {
    const redirect = opts.redirect ?? "http://127.0.0.1:7777/callback";
    const { cookie } = await loginCookie({ request: (p, i) => req(p, i) }, opts.username ?? "ada");
    const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: opts.state ?? "xyz", resource: opts.resource ?? `${BASE}/mcp` });
    const consent = await req(`/oauth/authorize?${query}`, { headers: { cookie } });
    if (consent.status !== 200) return { consent, location: consent.headers.get("location") };
    const html = await consent.text();
    const fields = Object.fromEntries([...html.matchAll(/name="(\w+)" value="([^"]*)"/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, "&")]));
    const decision = await req("/oauth/authorize", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE }, body: new URLSearchParams({ ...fields, decision: opts.decision ?? "allow" }) });
    return { consent, location: decision.headers.get("location"), cookie, html };
  };
  const token = async (body: Record<string, string>) => {
    const response = await req("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const callMcp = (bearer: string) => req("/mcp", { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  return { ...ctx, req, register, authorize, token, callMcp };
}

async function fullGrant(ctx: Awaited<ReturnType<typeof setup>>) {
  const client = await ctx.register();
  const { verifier, challenge } = await pkce();
  const { location } = await ctx.authorize(client.client_id, challenge);
  const redirect = new URL(location!);
  const exchanged = await ctx.token({ grant_type: "authorization_code", code: redirect.searchParams.get("code")!, code_verifier: verifier, client_id: client.client_id, redirect_uri: "http://127.0.0.1:7777/callback", resource: `${BASE}/mcp` });
  return { client, verifier, challenge, redirect, exchanged };
}

describe("oauth discovery", () => {
  test("a 401 points at the resource metadata, which points at this server", async () => {
    const ctx = await setup();
    const denied = await ctx.callMcp("nope");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
    const resource = await (await ctx.req("/.well-known/oauth-protected-resource")).json() as Record<string, any>;
    expect(resource).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    const server = await (await ctx.req("/.well-known/oauth-authorization-server")).json() as Record<string, any>;
    expect(server).toMatchObject({ issuer: BASE, code_challenge_methods_supported: ["S256"], token_endpoint: `${BASE}/oauth/token`, authorization_response_iss_parameter_supported: true });
  });
});

describe("authorization code flow with PKCE", () => {
  test("register, sign in, consent, exchange, call a tool as the user", async () => {
    const ctx = await setup();
    const { redirect, exchanged } = await fullGrant(ctx);
    expect(redirect.searchParams.get("state")).toBe("xyz");
    expect(redirect.searchParams.get("iss")).toBe(BASE);
    expect(exchanged.status).toBe(200);
    expect(exchanged.body).toMatchObject({ token_type: "Bearer", scope: "mcp" });
    expect(exchanged.body.access_token).toStartWith("umo_");
    const listed = await ctx.callMcp(exchanged.body.access_token);
    expect(listed.status).toBe(200);
    const call = await ctx.req("/mcp", { method: "POST", headers: { authorization: `Bearer ${exchanged.body.access_token}`, "content-type": "application/json", accept: "application/json", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "utility__echo", arguments: { message: "via oauth" } } }) });
    expect(JSON.stringify(await call.json())).toContain("via oauth");
    expect(ctx.store.audits.find((a) => a.toolName === "echo")).toMatchObject({ userId: ctx.admin.id, actor: "mcp", outcome: "success" });
  });

  test("tokens are stored hashed, never in clear", async () => {
    const ctx = await setup();
    const { exchanged } = await fullGrant(ctx);
    const stored = JSON.stringify(ctx.store.oauthTokens) + JSON.stringify(ctx.store.oauthCodes);
    expect(stored).not.toContain(exchanged.body.access_token);
    expect(stored).not.toContain(exchanged.body.refresh_token);
  });

  test("the authorize step needs a signed-in user and sends an anonymous browser to the login page", async () => {
    const ctx = await setup();
    const client = await ctx.register();
    const { challenge } = await pkce();
    const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "http://127.0.0.1:7777/callback", code_challenge: challenge, code_challenge_method: "S256" });
    const response = await ctx.req(`/oauth/authorize?${query}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toStartWith("/login?next=%2Foauth%2Fauthorize%3F");
  });

  test("a wrong code_verifier fails, and so does reusing a code (which also revokes what it issued)", async () => {
    const ctx = await setup();
    const client = await ctx.register();
    const { verifier, challenge } = await pkce();
    const { location } = await ctx.authorize(client.client_id, challenge);
    const code = new URL(location!).searchParams.get("code")!;
    const common = { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: "http://127.0.0.1:7777/callback" };
    const wrong = await ctx.token({ ...common, code, code_verifier: "x".repeat(50) });
    expect(wrong.body.error).toBe("invalid_grant");
    // the failed attempt consumed the code: an attacker who guessed wrong cannot retry with the right one
    const retry = await ctx.token({ ...common, code, code_verifier: verifier });
    expect(retry.status).toBe(400);

    const second = await ctx.authorize(client.client_id, challenge);
    const code2 = new URL(second.location!).searchParams.get("code")!;
    const first = await ctx.token({ ...common, code: code2, code_verifier: verifier });
    expect(first.status).toBe(200);
    const replay = await ctx.token({ ...common, code: code2, code_verifier: verifier });
    expect(replay.body.error).toBe("invalid_grant");
    expect((await ctx.callMcp(first.body.access_token)).status).toBe(401);
  });

  test("PKCE is mandatory, and the redirect URI is never trusted before it is matched", async () => {
    const ctx = await setup();
    const client = await ctx.register();
    const { cookie } = await loginCookie({ request: (p, i) => ctx.req(p, i) }, "ada");
    const noPkce = await ctx.req(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "http://127.0.0.1:7777/callback" })}`, { headers: { cookie } });
    expect(noPkce.status).toBe(302);
    expect(new URL(noPkce.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const wrongRedirect = await ctx.req(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://evil.example/cb", code_challenge: "c", code_challenge_method: "S256" })}`, { headers: { cookie } });
    expect(wrongRedirect.status).toBe(400); // an error page, not a redirect to the attacker
    const plain = await ctx.req(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "http://127.0.0.1:7777/callback", code_challenge: "c", code_challenge_method: "plain" })}`, { headers: { cookie } });
    expect(new URL(plain.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });

  test("a loopback redirect may change port; nothing else may change", async () => {
    const ctx = await setup();
    const client = await ctx.register("http://127.0.0.1:7777/callback");
    const { challenge } = await pkce();
    const moved = await ctx.authorize(client.client_id, challenge, { redirect: "http://127.0.0.1:51234/callback" });
    expect(moved.location).toStartWith("http://127.0.0.1:51234/callback?code=");
    const otherPath = await ctx.authorize(client.client_id, challenge, { redirect: "http://127.0.0.1:51234/other" });
    expect(otherPath.consent.status).toBe(400);
  });

  test("a resource for another server is refused", async () => {
    const ctx = await setup();
    const client = await ctx.register();
    const { challenge } = await pkce();
    const result = await ctx.authorize(client.client_id, challenge, { resource: "https://other.example/mcp" });
    expect(new URL(result.location!).searchParams.get("error")).toBe("invalid_target");
  });

  test("denying consent returns access_denied and no code exists", async () => {
    const ctx = await setup();
    const client = await ctx.register();
    const { challenge } = await pkce();
    const result = await ctx.authorize(client.client_id, challenge, { decision: "deny" });
    const url = new URL(result.location!);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("code")).toBeNull();
    expect(ctx.store.oauthCodes.length).toBe(0);
  });

  test("the consent form cannot be edited: changing the redirect breaks the signature", async () => {
    const ctx = await setup();
    const client = await ctx.register();
    const { challenge } = await pkce();
    const { cookie, html } = await ctx.authorize(client.client_id, challenge);
    const fields = Object.fromEntries([...html!.matchAll(/name="(\w+)" value="([^"]*)"/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, "&")]));
    const forged = await ctx.req("/oauth/authorize", { method: "POST", headers: { cookie: cookie!, "content-type": "application/x-www-form-urlencoded", origin: BASE }, body: new URLSearchParams({ ...fields, redirect_uri: "http://127.0.0.1:1/steal", decision: "allow" }) });
    expect(forged.status).toBe(400);
  });
});

describe("tokens after issue", () => {
  test("refresh rotates, and reusing an old refresh token revokes the whole grant", async () => {
    const ctx = await setup();
    const { client, exchanged } = await fullGrant(ctx);
    const rotated = await ctx.token({ grant_type: "refresh_token", refresh_token: exchanged.body.refresh_token, client_id: client.client_id });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(exchanged.body.refresh_token);
    expect((await ctx.callMcp(rotated.body.access_token)).status).toBe(200);
    const reuse = await ctx.token({ grant_type: "refresh_token", refresh_token: exchanged.body.refresh_token, client_id: client.client_id });
    expect(reuse.body.error).toBe("invalid_grant");
    expect((await ctx.callMcp(rotated.body.access_token)).status).toBe(401);
    expect((await ctx.token({ grant_type: "refresh_token", refresh_token: rotated.body.refresh_token, client_id: client.client_id })).status).toBe(400);
  });

  test("an expired access token, a token for another audience, and a disabled user are all rejected", async () => {
    const ctx = await setup();
    const { exchanged } = await fullGrant(ctx);
    const access = ctx.store.oauthTokens.find((t) => t.kind === "access")!;
    expect((await ctx.callMcp(exchanged.body.access_token)).status).toBe(200);
    access.resource = "https://other.example/mcp";
    expect((await ctx.callMcp(exchanged.body.access_token)).status).toBe(401);
    access.resource = `${BASE}/mcp`;
    access.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect((await ctx.callMcp(exchanged.body.access_token)).status).toBe(401);
    access.expiresAt = new Date(Date.now() + 60_000).toISOString();
    await ctx.store.setUserDisabled(ctx.admin.id, true);
    expect((await ctx.callMcp(exchanged.body.access_token)).status).toBe(401);
  });

  test("a user can list and revoke the apps they authorised, and nobody else's", async () => {
    const ctx = await setup();
    const { exchanged } = await fullGrant(ctx);
    const { cookie } = await loginCookie({ request: (p, i) => ctx.req(p, i) }, "ada");
    const grants = (await (await ctx.req("/api/oauth/grants", { headers: { cookie } })).json() as { grants: Array<{ familyId: string; clientName: string }> }).grants;
    expect(grants.length).toBe(1);
    expect(grants[0]!.clientName).toBe("Test Client");
    await addUser(ctx.store, "mallory", "member");
    const other = await loginCookie({ request: (p, i) => ctx.req(p, i) }, "mallory");
    const stolen = await ctx.req(`/api/oauth/grants/${grants[0]!.familyId}`, { method: "DELETE", headers: { cookie: other.cookie } });
    expect(stolen.status).toBe(404);
    expect((await ctx.callMcp(exchanged.body.access_token)).status).toBe(200);
    expect((await ctx.req(`/api/oauth/grants/${grants[0]!.familyId}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    expect((await ctx.callMcp(exchanged.body.access_token)).status).toBe(401);
  });

  test("RFC 7009 revoke kills the grant and always answers 200", async () => {
    const ctx = await setup();
    const { exchanged } = await fullGrant(ctx);
    const revoke = (token: string) => ctx.req("/oauth/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
    expect((await revoke("not-a-token")).status).toBe(200);
    expect((await revoke(exchanged.body.refresh_token)).status).toBe(200);
    expect((await ctx.callMcp(exchanged.body.access_token)).status).toBe(401);
  });
});

describe("client identity rules", () => {
  test("redirect URI validation", () => {
    for (const ok of ["https://app.example/cb", "http://localhost:3000/cb", "http://127.0.0.1/cb", "http://[::1]:9/cb", "cursor://anysphere.cursor-retrieval/oauth/callback"]) expect(validRedirectUri(ok)).toBe(true);
    for (const bad of ["http://example.com/cb", "javascript:alert(1)", "data:text/html,x", "https://app.example/cb#frag", "https://u:p@app.example/cb", "not a url", "file:///etc/passwd", ""]) expect(validRedirectUri(bad)).toBe(false);
    expect(redirectMatches(["http://127.0.0.1:1/cb"], "http://127.0.0.1:2/cb")).toBe(true);
    expect(redirectMatches(["https://a.example/cb"], "https://a.example:444/cb")).toBe(false);
  });

  test("dynamic registration refuses confidential clients and bad redirect URIs", async () => {
    const ctx = await setup();
    const post = (body: unknown) => ctx.req("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ redirect_uris: ["http://evil.example/cb"] })).status).toBe(400);
    expect((await post({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  test("a client metadata document must name itself and a valid redirect list", () => {
    const id = "https://app.example/oauth/client.json";
    expect(parseClientMetadata({ client_id: id, client_name: "App", redirect_uris: ["https://app.example/cb"] }, id)).toMatchObject({ clientId: id, name: "App", kind: "cimd" });
    expect(typeof parseClientMetadata({ client_id: "https://other.example/x", redirect_uris: ["https://app.example/cb"] }, id)).toBe("string");
    expect(typeof parseClientMetadata({ client_id: id, redirect_uris: ["http://evil.example/cb"] }, id)).toBe("string");
    expect(typeof parseClientMetadata({ client_id: id, redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "client_secret_post" }, id)).toBe("string");
  });

  test("a metadata-document client_id pointing at the metadata service is refused before any fetch", async () => {
    const ctx = await setup();
    const { challenge } = await pkce();
    const { cookie } = await loginCookie({ request: (p, i) => ctx.req(p, i) }, "ada");
    const query = new URLSearchParams({ response_type: "code", client_id: "https://169.254.169.254/latest/meta-data/x", redirect_uri: "https://a.example/cb", code_challenge: challenge, code_challenge_method: "S256" });
    expect((await ctx.req(`/oauth/authorize?${query}`, { headers: { cookie } })).status).toBe(400);
  });
});
