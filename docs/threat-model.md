# Threat model

Living note for the submission. Controls come from [ADR 0004](adr/0004-woocommerce-on-official-images.md), [ADR 0006](adr/0006-gateway-auth-and-credentials.md), and [ADR 0005](adr/0005-one-helm-chart-two-value-files.md). Each answer has a demonstration line from the unit tests or the k3d cluster.

## Shared upstream credentials

The WooCommerce consumer key is a store-wide read/write key held by the WooCommerce MCP server. A member never sees it. A member who can call `woocommerce__create_product` or `woocommerce__update_order_status` still acts with that key's full power. The gateway is the policy point, and in the core every authenticated user may call every enabled tool. The audit log is what makes that visible. Per-role tool grants would narrow it; they are not in the core.

Demonstration: a gateway `tools/call` to `woocommerce__list_products` returned the sample mug. The consumer key stays in the WooCommerce MCP pod environment. The gateway audit row is the attribution. A member never receives that key from `/api`.

## Why client tokens are not passed through

A member API key authenticates the caller to the gateway. Upstream calls use the credential stored for that server, after inbound `Authorization` and `Cookie` are stripped. WooCommerce therefore cannot tell members apart. Attribution is the audit row. Forwarding the client token would either fail at the store or invite a later change that passes whatever the client sent straight through.

Demonstration: the gateway unit test records an outbound `Authorization: Bearer upstream-secret` and rejects a header that contains the caller's `umk_` token. On the cluster, revoking the `umk_` key made the next `tools/list` return 401.

## Untrusted upstreams

Tool descriptions and tool results are text an upstream controls. A malicious description can try to steer the model into calling another tool with data from the conversation. Admins are the only role that can register a server. SSRF checks reject metadata and arbitrary private addresses. The chat prompt treats descriptions and results as data. The audit row records which server provided the tool. Upstream pods have no Kubernetes role and no path to Postgres.

This does not claim the system prompt stops a model from following a poisoned description. It claims the server cannot reach the node's metadata service or another store's database, and that the call is attributed.

Demonstration: `apps/gateway/src/ssrf.test.ts` rejects `169.254.169.254`, `127.0.0.1`, and `kubernetes.default.svc.cluster.local`, and allows `woocommerce-mcp.store.svc.cluster.local`. On the cluster, a pod labeled `app=netcheck` could not open `woocommerce-mcp.store.svc.cluster.local:8080`. The gateway pod got HTTP 200 from the same URL.

## What one member can do to another

Members share the store, so one member's product or order update is visible to the other. Members cannot read each other's API keys, cannot use each other's sessions, and cannot open the audit log. An admin can disable a member and revoke a key. A member cannot register an upstream.

Demonstration: disabling the utility server removed `utility__*` from `tools/list` for the same key that could still see WooCommerce and policy tools. Revoking that key returned 401. Audit is admin-only in the API.

## Other controls

| Control | Record | Demonstration |
| --- | --- | --- |
| API keys stored as a prefix plus SHA-256, shown once, revocable | ADR 0006 | unit test: a revoked key returns 401 and writes an `unauthorized` audit row |
| Upstream secrets AES-GCM, key outside the database | ADR 0006 | implemented; the unit test decrypts the stored bearer before the upstream call |
| MCP servers have no Ingress; NetworkPolicy allows the gateway only | ADR 0004, ADR 0005 | gateway pod HTTP 200; unlabeled pod denied |
| WordPress and MariaDB images start as root; our Bun images run as uid 1000 | ADR 0004 | `kubectl exec` on the gateway printed `uid=1000(bun)` |
| Dashboard cookie is httpOnly and is not accepted on `/mcp` | ADR 0006 | `/mcp` reads only `Authorization: Bearer`; cookie auth is the `/api` session |
