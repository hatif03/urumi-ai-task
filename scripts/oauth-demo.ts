#!/usr/bin/env bun
// The MCP authorization flow end to end, as an MCP client would run it, with the browser played by a script:
//   401 + resource_metadata -> protected resource metadata -> authorization server metadata -> dynamic client
//   registration -> sign in -> consent -> code -> token (PKCE S256, resource indicator) -> call a tool ->
//   refresh rotation -> refresh reuse detection -> revoke.
//   bun scripts/oauth-demo.ts            ENTRY / DASHBOARD_HOST / ADMIN_PASSWORD as in e2e.ts
import { readFileSync } from "node:fs";

const ENTRY = process.env.ENTRY ?? "http://127.0.0.1";
const HOST = process.env.DASHBOARD_HOST ?? "dashboard.local";
const BASE = process.env.PUBLIC_BASE ?? `http://${HOST}`;
const env = Object.fromEntries((() => { try { return readFileSync("deploy/secrets/generated.env", "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)); } catch { return []; } })());
const PASSWORD = process.env.ADMIN_PASSWORD ?? env.ADMIN_PASSWORD;

let failures = 0;
const check = (ok: boolean, name: string, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const req = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("host", HOST);
  return fetch(path.startsWith("http") ? path.replace(BASE, ENTRY) : `${ENTRY}${path}`, { ...init, headers, redirect: "manual" });
};
const form = (data: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data) });
const mcp = (token: string, method: string, params?: unknown) => req("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });

// 1. An anonymous call is refused and says where to start.
const anonymous = await mcp("none", "tools/list");
const challenge = anonymous.headers.get("www-authenticate") ?? "";
const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? "";
check(anonymous.status === 401 && !!metadataUrl, "an unauthenticated call is 401 with a resource_metadata pointer", challenge);

// 2. Discovery.
const resource = await (await req(metadataUrl)).json() as { resource: string; authorization_servers: string[] };
check(resource.resource === `${BASE}/mcp` && resource.authorization_servers[0] === BASE, "protected resource metadata names the MCP URL and its authorization server", JSON.stringify(resource));
const server = await (await req(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json() as Record<string, any>;
check(server.code_challenge_methods_supported?.includes("S256") && !server.code_challenge_methods_supported.includes("plain"), "the server advertises PKCE S256 only");
check(server.client_id_metadata_document_supported === true && !!server.registration_endpoint, "client metadata documents and dynamic registration are both offered");

// 3. Register a public client.
const redirectUri = "http://127.0.0.1:8765/callback";
const registered = await (await req(server.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "oauth-demo script", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }) })).json() as { client_id: string };
check(!!registered.client_id, "dynamic client registration", registered.client_id);

// 4. The browser half: sign in, open the authorization URL, press Allow.
const login = await req("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "ada", password: PASSWORD }) });
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const challengeValue = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
const state = crypto.randomUUID();
const query = new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: redirectUri, code_challenge: challengeValue, code_challenge_method: "S256", state, resource: resource.resource });
const anonymousAuthorize = await req(`/oauth/authorize?${query}`);
check(anonymousAuthorize.status === 302 && (anonymousAuthorize.headers.get("location") ?? "").startsWith("/login?next="), "without a session the authorize step sends the browser to the login page");
const consent = await req(`/oauth/authorize?${query}`, { headers: { cookie } });
const html = await consent.text();
check(consent.status === 200 && html.includes("Authorize") && html.includes("oauth-demo script"), "a signed-in user sees a consent page naming the client");
const fields = Object.fromEntries([...html.matchAll(/name="(\w+)" value="([^"]*)"/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, "&")]));
const decision = await req("/oauth/authorize", { ...form({ ...fields, decision: "allow" }), headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE } });
const back = new URL(decision.headers.get("location") ?? "http://invalid/");
check(back.origin + back.pathname === redirectUri && back.searchParams.get("state") === state && back.searchParams.get("iss") === BASE, "allow redirects to the client with the state and the issuer (RFC 9207)");
const code = back.searchParams.get("code") ?? "";

// 5. Token exchange: PKCE must verify, and a wrong verifier must not.
const wrong = await (await req("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: "x".repeat(60), client_id: registered.client_id, redirect_uri: redirectUri, resource: resource.resource }))).json() as any;
check(wrong.error === "invalid_grant", "a wrong code_verifier is refused", wrong.error_description);
const again = await req(`/oauth/authorize?${query}`, { headers: { cookie } });
const fields2 = Object.fromEntries([...(await again.text()).matchAll(/name="(\w+)" value="([^"]*)"/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, "&")]));
const second = await req("/oauth/authorize", { ...form({ ...fields2, decision: "allow" }), headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE } });
const code2 = new URL(second.headers.get("location")!).searchParams.get("code")!;
const tokens = await (await req("/oauth/token", form({ grant_type: "authorization_code", code: code2, code_verifier: verifier, client_id: registered.client_id, redirect_uri: redirectUri, resource: resource.resource }))).json() as any;
check(tokens.token_type === "Bearer" && String(tokens.access_token).startsWith("umo_") && !!tokens.refresh_token, "the correct verifier yields an access and a refresh token", `expires_in ${tokens.expires_in}`);
const replay = await (await req("/oauth/token", form({ grant_type: "authorization_code", code: code2, code_verifier: verifier, client_id: registered.client_id, redirect_uri: redirectUri }))).json() as any;
check(replay.error === "invalid_grant", "an authorization code cannot be used twice");
check((await mcp(tokens.access_token, "tools/list")).status === 401, "...and using it revoked the tokens it had issued (code replay means the code leaked)");

// 6. Use a fresh grant.
const third = await req("/oauth/authorize", { ...form({ ...fields2, decision: "allow" }), headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE } });
const code3 = new URL(third.headers.get("location")!).searchParams.get("code")!;
const grant = await (await req("/oauth/token", form({ grant_type: "authorization_code", code: code3, code_verifier: verifier, client_id: registered.client_id, redirect_uri: redirectUri }))).json() as any;
const listed = await (await mcp(grant.access_token, "tools/list")).json() as any;
check((listed.result?.tools ?? []).some((t: { name: string }) => t.name === "woocommerce__list_orders"), "the access token lists the same tools an API key does", `${listed.result?.tools?.length} tools`);
const echoed = await (await mcp(grant.access_token, "tools/call", { name: "utility__echo", arguments: { message: "hello over oauth" } })).json() as any;
check(JSON.stringify(echoed).includes("hello over oauth"), "and calls a tool as the user who consented");

// 7. Refresh rotation and reuse detection.
const refreshed = await (await req("/oauth/token", form({ grant_type: "refresh_token", refresh_token: grant.refresh_token, client_id: registered.client_id }))).json() as any;
check(!!refreshed.access_token && refreshed.refresh_token !== grant.refresh_token, "a refresh token yields a new pair and is itself replaced");
const reuse = await (await req("/oauth/token", form({ grant_type: "refresh_token", refresh_token: grant.refresh_token, client_id: registered.client_id }))).json() as any;
check(reuse.error === "invalid_grant", "reusing the old refresh token is refused");
check((await mcp(refreshed.access_token, "tools/list")).status === 401, "...and the whole grant is revoked, including the newer token");

// 8. Wrong audience and revoke.
const fresh = await (async () => {
  const r = await req("/oauth/authorize", { ...form({ ...fields2, decision: "allow" }), headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE } });
  const c = new URL(r.headers.get("location")!).searchParams.get("code")!;
  return (await (await req("/oauth/token", form({ grant_type: "authorization_code", code: c, code_verifier: verifier, client_id: registered.client_id, redirect_uri: redirectUri }))).json()) as any;
})();
check((await mcp(fresh.access_token, "tools/list")).status === 200, "a new grant works");
await req("/oauth/revoke", form({ token: fresh.refresh_token }));
check((await mcp(fresh.access_token, "tools/list")).status === 401, "POST /oauth/revoke ends the grant");
const wrongResource = await req(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: redirectUri, code_challenge: challengeValue, code_challenge_method: "S256", resource: "https://other.example/mcp" })}`, { headers: { cookie } });
check((wrongResource.headers.get("location") ?? "").includes("error=invalid_target"), "asking for a token for another resource is refused");

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
process.exit(failures);
