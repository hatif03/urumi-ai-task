# Engineering log

Append-only. New entries go at the top. Each entry says what changed, why, and links to the ADR or experiment. Outcome belongs in the linked record once there is evidence; this file is the timeline.

## 2026-10-14 — Core path running on k3d

Installed the chart on cluster `urumi` (k3s 1.35.5, ingress-nginx). `shop.local` serves the WooCommerce storefront and `dashboard.local` serves the dashboard. MariaDB, WordPress, Postgres, two gateway replicas, both utility replicas, both policy replicas, both WooCommerce MCP replicas, and the observability pods reached Ready.

Why: this is the definition-of-done path. Multi-store provisioning is still not started.

What the running system changed:

- `bun.lock` was missing after the first install because `bunfig.toml` had `frozenLockfile` before a lockfile existed. A one-time install with saving enabled wrote it, and Docker builds use that file.
- WooCommerce 11 basic auth runs only when `is_ssl()` is true. The WordPress config marks `/wp-json/wc/` as HTTPS, and `wp-content/mu-plugins/urumi-http-basic.php` clears that after authentication when `WP_HOME` is `http://`, so permalinks stay on `http://shop.local`. Recorded in ADR 0004.
- The CLI image's www-data is uid 82. The Apache image owns files as uid 33. The bootstrap Job runs as root and chowns `wp-content` to 33. The first attempt failed with "Could not create directory" until that change.
- `policy.json` had unquoted keys, so Bun could not parse it. It is JSON now.
- List-tool `structuredContent` must be an object. Arrays are wrapped as `{ items: [...] }`. A protocol error no longer marks the upstream unreachable; connection failures still do.

Evidence: order 11, status processing, total 12.00, was still in the database after the WordPress pod was deleted. Gateway `tools/list` returned the nine prefixed tools. `woocommerce__list_products` returned Urumi Sample Mug. `woocommerce__create_product` returned a permalink. `woocommerce__list_orders` included the processing order. Disabling utility removed `utility__*` and the server was enabled again. A revoked key got 401. Chat returned 503 with no LLM key. `/metrics` includes `tool_calls_total`. Deleting one gateway pod left `/readyz` at 200. An unlabeled pod was denied by NetworkPolicy; the gateway pod got HTTP 200. `helm template -f values-prod.yaml` renders `shop.example.com` and `maxReplicas: 4`. That file is not installed on a second cluster.

## 2026-10-14 — Core services and chart written

Added the Bun workspace, `packages/mcp-names`, `packages/obs`, the stateless MCP adapter, the WooCommerce, utility, and policy servers, the gateway (Postgres schema, hashed keys, prefixed tools, audit, chat), the React dashboard, and the Helm chart with `values-local.yaml` and `values-prod.yaml`.

Why: this is the definition-of-done path in `plan.md`. Bonus multi-store work stays unstarted.

Evidence: `bun test` passed the protocol, prefix, timeout, revoked-key, and SSRF cases. curl against a local Bun process returned `2025-06-18` as one JSON object ([experiment 0001](experiments/0001-bun-initialize.md)). `helm lint` passed. The cluster smoke script has not been run yet.

## 2026-10-14 — CLIs and shared skills installed

Installed Helm 4.3.0 and k3d 5.9.0 with winget. Bun, kubectl, and Docker were already on the machine. Docker's engine was not running, so no k3d cluster was created. Host WP-CLI was not installed because PHP is not installed and the bootstrap Job uses the `wordpress:cli` image.

Installed project skills for both Cursor and Claude Code: WordPress `wp-wpcli-and-ops`, `wp-rest-api`, and `wp-abilities-api`; Vercel `vercel-react-best-practices`; `kubernetes-helm`; `bun-hono-integration`. Wrote `urumi-stack` in this repo so agents do not enable WooCommerce's built-in MCP and do not replace ingress-nginx with the Gateway API. The official adapter stays documentation: [AI tools](https://developer.woocommerce.com/docs/getting-started/ai/), [MCP integration](https://developer.woocommerce.com/docs/features/mcp/), [llms-full.txt](https://developer.woocommerce.com/docs/llms-full.txt).

Why: those are the tools the chart and the store bootstrap need, and both agents should read the same skills. Recorded in ADR 0008 and `docs/tooling.md`.

Outcome: binaries installed. Skill copy locations are `.agents/skills/` and `.claude/skills/`. A new terminal is required before `helm` and `k3d` are on `PATH`.

## 2026-10-14 — Documentation record set opened

Created `docs/README.md`, ADRs 0001–0007, the experiment template, this log, and the first drafts of the system design and threat model.

Why: decisions were accumulating in `plan.md` only. The submission documents describe the finished system; they do not keep rejected options, later reversals, or trial results. ADR 0001 is the rule for keeping those from here on.

Outcome: the files exist. Nothing has been deployed, so every implementation ADR is still "not yet built."

## 2026-10-14 — Bun, and scale and observability moved into the core

The plan's first draft specified a pnpm workspace on Node 22, one gateway replica, and Prometheus as a stand-out. Before any code, that changed.

- Bun is the package manager and the runtime (`oven/bun`, `bun.lock`, Hono on `Bun.serve`, Drizzle on `Bun.sql`). The MCP SDK v2 tests this path. Recorded in ADR 0002.
- The gateway, dashboard, and MCP servers start at two replicas, with a shared probe lease, a per-key rate limit, Prometheus, Grafana, Tempo, and trace ids on the audit log. Recorded in ADR 0007, which supersedes the one-replica plan.

Why: speed, reliability, scalability, and observability are requirements of the first deploy, and the SDK already runs on Bun. No experiment has been run yet. The first one should be a Bun `initialize` round trip on the pinned version, as ADR 0002 notes.

Outcome: plan and ADRs agree. The cluster has not confirmed the laptop can schedule the extra pods. If it cannot, that becomes an experiment rather than a silent drop back to one replica.

## 2026-10-14 — Initial design from the internship brief

Read the Round 1 brief and wrote `plan.md`. The design that is still in force, now copied into ADRs so the plan is not the only copy:

- Stateless Streamable HTTP gateway, tool names `{slug}__{tool}`, three in-cluster upstreams (ADR 0003).
- Official WordPress and MariaDB images, WooCommerce over `wc/v3`, MCP server private to the gateway (ADR 0004).
- One Helm chart, k3d locally, k3s on a VPS, ingress-nginx, values files for the environment split (ADR 0005).
- Hashed member API keys, AES-GCM upstream secrets, client tokens not forwarded, chat calls the same router as MCP (ADR 0006).

Why: the brief requires those behaviors, and the gateway products we compared (Kuadrant, Microsoft MCP Gateway, Cloudflare portals, Kong, Docker MCP Gateway) already use prefixing, stateless or session-aware routing, and a hard split between caller auth and upstream auth. We took the stateless and prefix parts.

Outcome: accepted as the build plan. Verification waits on the cluster smoke script and the two-user demo.
