# System design

Living note for the submission. The build plan is `plan.md`. The reasons are the ADRs. When the running cluster differs from this file, this file is updated in that change and the log records why.

Status: the k3d cluster `urumi` is running the full chart. Shop and dashboard respond on port 80. Evidence is in the log entry for 2026-10-14 and in the ADR outcomes.

## Shape

Four layers on one Helm chart.

1. **Store.** One WordPress and WooCommerce site and a MariaDB database, persistent volumes, cash on delivery. [ADR 0004](adr/0004-woocommerce-on-official-images.md).
2. **WooCommerce MCP server.** Our process, Streamable HTTP, five tools, ClusterIP only, REST to `wc/v3`. [ADR 0003](adr/0003-stateless-mcp-and-tool-names.md), [ADR 0004](adr/0004-woocommerce-on-official-images.md).
3. **Gateway.** An MCP server at `/mcp` and the dashboard API. It is the only caller of upstream MCP servers. [ADR 0003](adr/0003-stateless-mcp-and-tool-names.md), [ADR 0006](adr/0006-gateway-auth-and-credentials.md).
4. **Chat.** Tool loop in the gateway, acting as the logged-in user, showing the tools it called. [ADR 0006](adr/0006-gateway-auth-and-credentials.md).

Two more MCP servers, `utility` and `policy`, are seeded so a prompt can use two upstreams and so one pod can be killed without destroying the store. [ADR 0003](adr/0003-stateless-mcp-and-tool-names.md).

Public Ingress hosts are the storefront and the dashboard (`/`, `/api`, `/mcp`). Metrics, the collector, and the MCP servers are not on the Ingress.

## Aggregation and failure

- Public tool names are `{serverSlug}__{toolName}`. The gateway strips the prefix and calls that upstream.
- `tools/list` fans out in parallel. A server that misses the 3 second deadline is omitted and marked Unreachable. Other servers are still returned.
- A disabled server is not contacted. Its tools disappear for the chat agent and for external clients.
- Creates and order-status updates are not retried. Reads may retry once on a dropped connection.
- Two gateway replicas can each serve any POST. Upstream status and the tool cache live in Postgres. [ADR 0007](adr/0007-scale-and-observe-from-the-first-deploy.md).

## Runtime and deploy

Bun workspace, Hono on `Bun.serve`, images from `oven/bun`. [ADR 0002](adr/0002-bun-runtime-and-workspaces.md).

One chart, `values-local.yaml` for k3d and `values-prod.yaml` for k3s. Differences are hosts, images, disk size, resources, replica maximums, and secret material. [ADR 0005](adr/0005-one-helm-chart-two-value-files.md).

## Observability

JSON logs, `/metrics` on port 9090, trace id on the audit row and on `traceparent`, Prometheus, Grafana, Tempo, collector. [ADR 0007](adr/0007-scale-and-observe-from-the-first-deploy.md).

## What the cluster changed

WooCommerce 11 accepts consumer-key basic auth only when `is_ssl()` is true. In-cluster calls are HTTP, so WordPress marks `/wp-json/wc/` as HTTPS for that check. When `WP_HOME` is `http://`, a mu-plugin clears the flag after authentication so permalinks stay on the public scheme. The WordPress CLI image runs as Alpine www-data (uid 82) and cannot write files owned by Debian www-data (uid 33), so the bootstrap Job runs as root and chowns `wp-content` back to 33. MCP `structuredContent` has to be an object, so list tools wrap arrays as `{ items: [...] }` and leave the text content as the JSON array.

## Production values

Filled in from `values-prod.yaml`. The same chart renders with that file. The values that change are the shop and dashboard hostnames (`shop.example.com`, `dashboard.example.com`), image repositories (a registry path and `IfNotPresent` instead of local names and `Never`), PVC sizes (10Gi for the store and Postgres, 10Gi Prometheus, 5Gi Tempo), the WordPress and gateway limits, and the HPA maximum (4 instead of 2). Secrets are still referenced by name and created on the machine, not in the chart. TLS stays off.

## Evidence

| Claim | Where it was shown | When |
| --- | --- | --- |
| | Not run yet | |
