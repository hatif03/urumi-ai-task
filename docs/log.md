# Engineering log

Append-only. New entries go at the top. Each entry says what changed, why, and links to the ADR or experiment. Outcome belongs in the linked record once there is evidence; this file is the timeline.

## 2026-10-20 — Round 1 completion: audit, fixes, every stand-out, the bonus, verified on k3d

Plan: [plan-round1-completion.md](plan-round1-completion.md). Decisions: ADRs 0009 to 0021. Trials: experiments 0002 to 0005.

**Audit of the first build** found defects before any new feature: the audit log API returned user ids, the UI omitted user and duration, filters ran after `limit 100` and `from`/`to` were ignored; the SSRF check rejected names starting with `ff`, missed IPv4-mapped IPv6 and threw away the DNS answer; `/mcp` had no `Origin` check; migrations were `create table if not exists` with nothing recorded; login had no throttle and an admin could demote the last admin; the gateway's NetworkPolicy blocked all internet egress, which would also have blocked the LLM API and any external MCP server an admin adds; TLS values existed but the Ingress ignored them. All fixed (ADR 0009, 0011, 0019).

**Built:** tool permissions (ADR 0010); the OAuth 2.1 authorization server with PKCE, protected resource metadata, dynamic registration and Client ID Metadata Documents, refresh rotation with reuse detection (ADR 0012); the three-tool search surface and the chat switch above 20 tools (ADR 0017); the provisioner with Helm, a state machine and recovery, the per-store chart, quotas, NetworkPolicies, RBAC and an admission policy (ADR 0013, 0014, 0015); hosted MCP servers (ADR 0016); TLS through cert-manager and a VPS bootstrap (ADR 0018); alert rules and classified failure reasons (ADR 0020); `helm test`, rolling-update settings and the upgrade runbook (ADR 0021); a rewritten dashboard; trace propagation from gateway to MCP server to WooCommerce; key rotation (`rekey.ts`); a 1 MB result cap; per-user limits on chat tool calls.

**Found by running it, then fixed:**
- The WooCommerce MCP readiness probe called WordPress inside the probe and failed at the one-second default under load; pods went NotReady and the gateway lost the store ([experiment 0003](experiments/0003-probe-timeouts-under-load.md)). Grafana was in a restart loop for six days for a similar reason (migrations outlast the liveness window); it got a startup probe.
- The in-memory rate-limit shortcut admitted ~20 calls a second whatever the limit ([experiment 0004](experiments/0004-rate-limit-shortcut.md)); removed.
- A store deleted before its namespace existed hung in `deleting`, because Helm was run in a namespace the provisioner has no rights in; delete now skips Helm when there is no namespace of its own and rebinds the role first when there is (found by the end-to-end run, two regression tests).
- Bun SQL stored a stringified JSON parameter as a JSON string ([experiment 0002](experiments/0002-bun-sql-json-parameters.md)).
- The dashboard's slug helper built an invalid regular expression for stores (an empty separator) and the error boundary stayed stuck on later pages. Found by driving the real UI in a headless browser (`scripts/ui-check.ts`), which also showed the first version of that check passed because it matched navigation text; it now checks each page's own `h1`.
- Documentation drift caught by the study-material review: trace ids were logged but not propagated; the README promised PVC retention that only MariaDB had. Trace propagation was built (W3C `traceparent` through the gateway, the MCP adapter and the WooCommerce call, with spans exported to Tempo); platform PVCs now carry `helm.sh/resource-policy: keep`.

**The load test found the worst bug of the day.** 40 concurrent callers collapsed the gateway to 2 calls a second with 31% to 47% failures while the node sat at 8% CPU. Admission control, batched spans, fewer database round trips and two race fixes (a tool-cache refresh that briefly answered "unknown tool"; a stampede of upstream connections on a cold replica) were all real improvements but did not cure it. The cause was in `%LOCALAPPDATA%\Temp\wsl-crashes`: about 18 GB of core dumps from `/usr/local/bin/bun`. Bun 1.2.19 was crashing inside the pod (`panic: index out of bounds`), the same panic that was breaking database-backed test runs, and the dumps filled the disk until a source file was truncated mid-write (restored from the conversation, nothing lost). The project had pinned 1.2.19; the images now use `oven/bun:1.4.3-alpine` and the same suites pass repeatedly. After that the same load completed 3508 calls at 58 a second with 99.46% success, no restarts, and the HPA took the gateway from 2 to 4 replicas ([experiment 0006](experiments/0006-gateway-collapse-under-load.md), [ADR 0022](adr/0022-admission-control-and-autoscaler-ownership.md)). Also: the chart set `replicas` on Deployments that have an HPA, which conflicts under Helm 4's server-side apply; the autoscaler now owns the count.

**Evidence:** [docs/evidence/e2e-2026-10-20.txt](evidence/e2e-2026-10-20.txt) is the definition of done with two users, then two stores created in parallel, orders compared, one store deleted with its tools, namespace and volumes gone, then a hosted MCP server deployed from an image and removed (65 checks, ALL PASSED, 398 s, on the final images). [oauth-demo](evidence/oauth-demo-2026-10-20.txt) is the full PKCE flow against the cluster. Unit and integration: gateway, MCP adapter, names, Postgres and provisioner suites. `helm test urumi -n platform` succeeds.

Recorded later the same day: security checks, recovery, load, rollback and TLS rehearsals are in [security-test-log.md](security-test-log.md) and `docs/evidence/`.

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
