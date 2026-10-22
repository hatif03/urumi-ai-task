# 0006. Hashed API keys, encrypted upstream secrets, no token passthrough

- Status: accepted
- Date: 2026-10-14
- Outcome: A live `umk_` key listed and called tools; after revoke the same key got 401. Chat with a session cookie returned 503 while `/mcp` kept working, because `gateway-llm` has an empty API key. The unit test still checks that the outbound `Authorization` header is the upstream secret. Gateway containers run as uid 1000.

## Context

Admins register upstream MCP servers and their credentials. Members use one gateway URL and their own key. Members must never see upstream credentials. Keys are revocable and stored hashed. Every tool call is audited under the acting user. The chat agent acts as the logged-in user. The threat model has to explain shared upstream credentials and why client tokens are not forwarded.

## Options

1. Forward the caller's `Authorization` header upstream.
2. Store upstream secrets in plaintext in Postgres and rely on Kubernetes disk encryption only.
3. The gateway authenticates the caller, then calls upstream with a credential only the gateway can decrypt. API keys are hashed. Dashboard sessions are a separate cookie.

## Decision

Option 3.

- API keys are `umk_` plus 32 random bytes. The database stores a prefix and the SHA-256 of the full token. The plaintext is shown once.
- Dashboard login is an httpOnly session cookie. `/mcp` accepts `Authorization: Bearer` only, not the cookie.
- Upstream secrets are AES-256-GCM under a key that lives in a Kubernetes Secret, not in the database. The admin API returns `credential_set`, never the secret.
- Outbound calls strip inbound `Authorization` and `Cookie`, then set the stored bearer or header.
- Roles are `admin` and `member`. Audit rows record user, key, actor (`chat` or `mcp`), server, tool, time, duration, outcome, and trace id. The audit UI is admin-only.
- Chat uses the Vercel AI SDK in the gateway process and calls the same router, so the audit user is the session user.
- Admin-supplied URLs are checked for SSRF before connect: no metadata addresses, no link-local, private addresses only for `*.svc.cluster.local` other than the Kubernetes API service. Redirects are not followed. The connection uses the address that passed the check.

## Why

This is the split Kong, Azure API Management, and Cloudflare portals use: the client authenticates to the gateway, and the gateway authenticates upstream with its own secret. Hashing keys matches the usual show-once token design (Stripe-style prefix, OWASP guidance to store a hash). Encrypting the upstream column means a SQL dump is not enough to call WooCommerce. The WooCommerce consumer key itself stays only in the WooCommerce MCP server; the gateway's seeded row for that server has credential type `none`.

## Consequences

- WooCommerce cannot tell team members apart. Attribution exists in the audit log. Any authenticated user can call any enabled tool until per-role grants exist. That limit is stated in the threat model.
- OAuth 2.1 as specified for remote MCP is a later addition on the same endpoint. The definition of done tests key issue and revoke.
- A revoked key fails the next request and writes an `unauthorized` audit row.

## Update 2026-10-20

OAuth 2.1 was added on the same endpoint ([ADR 0012](0012-oauth-authorization-server.md)); API keys are unchanged. Per-role tool grants now exist ([ADR 0010](0010-tool-permissions.md)), so "any authenticated user may call any enabled tool" is no longer true: members default to read-only tools. `CREDENTIAL_KEY` rotation is supported (`CREDENTIAL_KEY_PREVIOUS` and `rekey.ts`).
