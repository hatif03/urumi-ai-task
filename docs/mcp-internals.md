# MCP internals

How a tool call travels, and what the gateway does at each hop. Code references are to `apps/gateway/src` unless noted.

## The path of one call

`tools/call woocommerce__list_orders` from an external client:

1. **Ingress.** ingress-nginx routes `dashboard.local/mcp` to the `gateway` Service (port 8080). `/api`, `/oauth` and `/.well-known` go to the same Service; everything else goes to the dashboard. The upstream MCP servers have no Ingress.
2. **HTTP adapter** (`apps/mcp-http/src/adapter.ts`, shared by every MCP server we write). One POST is one JSON-RPC message. A batch (JSON array) is refused with 400, because the 2025-06-18 transport removed batching. A bad `mcp-protocol-version` header is 400. Notifications get 202. `GET` and `DELETE` are 405: nothing here streams server-initiated messages, so there is nothing to keep open.
3. **Authenticate** (`mcp.ts` `authorize`). A browser `Origin` that is not the request's own host is refused (DNS-rebinding defence). The bearer token is tried as an API key (`auth.ts` `callerFromApiKey`: prefix lookup, SHA-256, constant-time compare, user not disabled) and then as an OAuth access token (`oauth.ts` `callerFromOAuthToken`: hash lookup, not revoked, not expired, audience equals `<base>/mcp`, user not disabled). A failure writes an `unauthorized` audit row and returns 401 with the `resource_metadata` challenge.
4. **Resolve** (`router.ts` `call`). `splitToolName` cuts at the first `__` into `(slug, tool)`. The server row is loaded by slug. Unknown name or server: `-32602`. Disabled server: `server_disabled`.
5. **Rate limit.** One token from the caller's bucket in Postgres (`key:<id>` or `oauth:<userId>`, default 60 per minute), with a one-second in-memory shadow for calls clearly inside the budget so a burst does not hit the database each time. Empty bucket: `rate_limited`, audited as `denied`.
6. **Known tool?** The cached tool list (Postgres, 30 seconds) is checked; a miss refreshes it once. Still unknown: `-32602`.
7. **Permission** (`policy.ts` `decide`). The caller's role and user id are matched against `tool_grants` and the tool's annotations. Denied: `-32003`, audited `denied`.
8. **Upstream client** (`clientFor`). A warm MCP `Client` per upstream is kept for 60 seconds idle. A cold one runs `resolveUpstream` (SSRF check, DNS), decrypts the stored credential, builds the headers (`Authorization: Bearer` or the named header; the caller's own `Authorization` and `Cookie` are never forwarded), and connects through `pinnedFetch`. Redirects are an error.
9. **Call with a deadline.** `callTool` races an 8 second timer. Creates and status updates are not retried; reads are retried once on a dropped connection with a fresh client.
10. **WooCommerce MCP server** (`apps/woocommerce-mcp/src/index.ts`). It validates the arguments against the tool's zod schema, calls `GET /wp-json/wc/v3/orders?...` with the consumer key over HTTP basic auth, trims the response, and returns text plus `structuredContent`.
11. **Answer.** The router writes the audit row (user, key, actor, server, tool, duration, outcome, trace id), updates metrics, and returns the upstream result unchanged to the client.

The chat agent skips steps 1 to 3: `chat.ts` calls `router.call` in the same process with the session user's id, so steps 4 to 11 are identical and the audit actor is `chat`.

## Names and collisions

A public tool name is `{slug}__{upstreamName}`. The slug is lowercase words joined by single underscores, fixed when the server is registered. The first `__` is the separator, so an upstream tool whose own name contains `__` cannot be exposed unambiguously and is skipped (the server's status detail says how many). Two servers that both export `list_orders` become `store_alpha__list_orders` and `store_beta__list_orders`. The router strips the prefix before calling the upstream. The description is prefixed with `[slug]` so a model sees which server a tool belongs to.

## Listing

`tools/list` loads the enabled servers and asks each for its tools **in parallel**, each with a 3 second deadline (`LIST_TIMEOUT_MS`), through a Postgres cache so two replicas and many clients do not each hit every upstream. A server that misses the deadline contributes nothing and is marked unreachable; the others are returned. The list is then filtered by `decide()` for the caller. A background probe on every replica, with a lease in `last_checked_at`, refreshes status every 15 seconds so the dashboard is current even when nobody calls a tool.

## Failure matrix

| Situation | What the caller sees | Status of the server | Audit outcome |
| --- | --- | --- | --- |
| upstream pod gone, connection refused | `-32000`, `upstream_unreachable` | `unreachable`, `connection refused: ...` | `unreachable` |
| upstream accepts but never answers | `-32000`, `upstream_timeout` after 8 s (3 s for a list) | `unreachable`, `timeout: ...` | `timeout` |
| upstream returns a tool-level error | normal result with `isError: true` | unchanged | `error` |
| upstream protocol error | `-32000`, `upstream_error` | unchanged | `error` |
| server disabled by an admin | `-32000`, `server_disabled`; its tools are absent from lists | `disabled` | `error` |
| URL points somewhere blocked | the server cannot connect; the reason says `blocked by SSRF policy` | `unreachable` | `unreachable` |
| tool hidden by permissions | `-32003`, `denied` | unchanged | `denied` |
| caller over the rate limit | `-32000`, `rate_limited` | unchanged | `denied` |
| bad or revoked key, expired or wrong-audience token | HTTP 401 | n/a | `unauthorized` |

One slow or dead upstream never delays a call to another: every call has its own deadline and its own connection, and `tools/list` does not wait past 3 seconds for anyone.

## Why stateless

The gateway keeps no per-client session. Each POST carries the bearer token and stands alone, so any replica can answer any request, a replica can be replaced mid-conversation, and a horizontal pod autoscaler can add replicas without a session-affinity rule. What the gateway does keep per replica (the warm upstream clients, a one-second rate-limit shadow) is a cache; losing it costs a reconnect. State that must agree across replicas (tool cache, server status, rate-limit buckets, the probe lease, audit) is in Postgres.

## Tool descriptions are untrusted

A tool description is text a third party wrote that ends up in a model's context. The gateway strips control and bidirectional-override characters and caps the length (`cleanDescription`), tags every description with its server, tells the chat model to treat tool text as data, and keeps the permission check outside the model: a model that is talked into calling a write tool still gets `denied` if the user may not. It does not claim that prevents a persuaded model from misusing tools the user is allowed to call.
