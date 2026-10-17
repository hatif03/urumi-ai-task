# 0012. OAuth for the gateway: built-in authorization server, opaque tokens, PKCE, audience-bound

- Status: accepted
- Date: 2026-10-20
- Outcome: `oauth.test.ts` (18 tests) runs the full flow with PKCE against the gateway: discovery documents, registration, sign-in redirect, consent, code exchange, a tool call as the user, refresh rotation and reuse detection, code replay revoking what it issued, audience mismatch, expiry, a disabled user, grant listing and revocation. A run with a real client is recorded in `docs/log.md` if one was done.

## Context

The MCP authorization spec expects a remote server to be an OAuth 2.1 resource server, publish protected resource metadata (RFC 9728), and accept only tokens issued for it (RFC 8707). Clients such as Claude Code, Cursor and MCP Inspector can then connect with a browser login and no pasted key. The brief lists this as a stand-out and asks that it complement, not replace, API keys.

## Options

1. A hosted identity provider (Keycloak, Auth0) in front of the gateway.
2. An authorization server inside the gateway that reuses the dashboard login.
3. Leave API keys only.

## Decision

Option 2.
- Discovery: `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` (RFC 8414). A 401 from `/mcp` carries `WWW-Authenticate: Bearer resource_metadata="..."`.
- Client identity: dynamic registration (RFC 7591, public clients only; redirect URIs must be https, loopback http, or a private-use scheme) and Client ID Metadata Documents (the client_id is an https URL; the document is fetched through the SSRF resolver). The newest spec draft prefers metadata documents and marks registration deprecated; current clients still use registration, so both exist.
- `/oauth/authorize`: PKCE `S256` required, `resource` must equal `<public base>/mcp`, the user must hold a dashboard session (an anonymous browser is sent to `/login?next=...`), the consent form is bound to the user by an HMAC over every parameter, an exact redirect URI match is required (a loopback redirect may change port), the response carries `iss` (RFC 9207).
- `/oauth/token`: authorization code with PKCE, and refresh token with rotation. Reusing a rotated refresh token or a used code revokes the whole grant (the family).
- Tokens are opaque (`umo_...`, refresh `umr_...`), stored as SHA-256, valid one hour (refresh thirty days), and accepted by `/mcp` only if issued for that exact resource URL. `/mcp` takes API keys and OAuth tokens through one function, so permissions, rate limits and audit are identical.

## Why

An external provider adds a service to run and a second user database, and the dashboard already authenticates people. Opaque hashed tokens make revocation one row update and keep validation inside the process; JWTs would need a revocation list to do the same. Audience binding and "never forward the token" are the spec's answer to the confused deputy problem. A signed consent form removes the need for a separate CSRF store.

## Consequences

- One more table set (`oauth_clients`, `oauth_codes`, `oauth_tokens`) and a short HTML consent page rendered by the gateway.
- The public base URL must be stable: it is the issuer and the token audience. `PUBLIC_BASE_URL` pins it; otherwise it is derived from forwarded headers, which is only safe behind the ingress.
- There is a single `mcp` scope. Per-tool scoping is the permission table, not OAuth scopes.
- No client secrets, no confidential clients, no OpenID Connect.
