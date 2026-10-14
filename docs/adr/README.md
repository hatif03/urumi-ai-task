# Architecture decision records

Numbered, one decision per file. The format is the Nygard record (status, context, decision, consequences) plus the options we weighed and an outcome line we update after the decision is exercised.

New records go at the next number. Superseded records stay in this list.

| ID | Title | Status | Outcome |
| --- | --- | --- | --- |
| [0001](0001-documentation-records.md) | Keep ADRs, experiments, and an engineering log from day one | accepted | Record set created; no implementation evidence yet |
| [0002](0002-bun-runtime-and-workspaces.md) | Use Bun as the package manager and the runtime | accepted | experiment 0001; cluster images are `oven/bun:1.2.19-alpine` |
| [0003](0003-stateless-mcp-and-tool-names.md) | Stateless Streamable HTTP and prefixed tool names | accepted | nine prefixed tools on the cluster; disable hides utility |
| [0004](0004-woocommerce-on-official-images.md) | WooCommerce on official images, reached over REST | accepted | order 11 survived a WordPress pod delete; MCP is ClusterIP only |
| [0005](0005-one-helm-chart-two-value-files.md) | One Helm chart, k3d locally, k3s on a VPS | accepted | local release installed; prod values render, not installed on a second cluster |
| [0006](0006-gateway-auth-and-credentials.md) | Hashed API keys, encrypted upstream secrets, no token passthrough | accepted | revoked key 401; chat 503 without an LLM key |
| [0007](0007-scale-and-observe-from-the-first-deploy.md) | Two replicas, rate limits, metrics, and traces in the core | accepted | two gateway pods; metrics include `tool_calls_total` |
| [0008](0008-dev-tooling-and-skills.md) | Dev CLIs and shared Cursor/Claude skills | accepted | Helm 4.3.0 and k3d 5.9.0 installed; skills copied into the repo; cluster not created |
