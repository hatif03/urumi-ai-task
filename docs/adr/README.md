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
| [0009](0009-versioned-migrations-and-shared-throttle.md) | Versioned migrations, one throttle table | accepted | migrations run twice and concurrently in a test; schema drift test |
| [0010](0010-tool-permissions.md) | Tool permissions: most specific rule wins, read-only default for members | accepted | decision table and gateway tests; e2e on the cluster |
| [0011](0011-ssrf-resolve-and-pin.md) | SSRF: validate, resolve, pin, and deny at the network | accepted | ssrf tests; cluster probes in the security log |
| [0012](0012-oauth-authorization-server.md) | OAuth for the gateway: built-in server, opaque tokens, PKCE, audience-bound | accepted | 18 tests; scripted flow on the cluster |
| [0013](0013-provisioner-reconciler.md) | A separate provisioner driving Helm through a database state machine | accepted | 26 tests with crash injection; two stores on the cluster |
| [0014](0014-store-chart.md) | The per-store chart | accepted | installed and torn down on k3d |
| [0015](0015-provisioner-rbac-and-admission.md) | Provisioner RBAC: per-namespace grants and an admission policy | accepted | impersonation checks on the cluster |
| [0016](0016-hosted-mcp-servers.md) | Hosted MCP servers in a restricted namespace | accepted | tests; deploy and delete on the cluster |
| [0017](0017-tool-search-surface.md) | Many tools: a three-tool search surface | accepted | 300-tool test; e2e |
| [0018](0018-tls-and-vps-strategy.md) | TLS and the VPS: cert-manager, values-only differences | accepted | rendered; TLS rehearsal on k3d; real VPS not run |
| [0019](0019-audit-log-shape.md) | Audit log: joined user, SQL filters, keyset paging | accepted | Postgres tests; e2e |
| [0020](0020-alerts-and-failure-reasons.md) | Alerts, and a reason with every failure | accepted | rules loaded; reason strings tested |
| [0021](0021-upgrade-and-rollback.md) | Upgrades and rollback with Helm | accepted | atomic rollback rehearsal recorded |
| [0022](0022-admission-control-and-autoscaler-ownership.md) | Admission control, batched spans, and the autoscaler owns replicas | accepted | load run showed the cascade this prevents; evidence file |
