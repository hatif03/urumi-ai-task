# Requirements coverage

Every line of the Round 1 brief, where it is met, and how it was checked. "Live" means it ran on the AWS k3s deployment described in [vps-deploy.md](vps-deploy.md) ([evidence](evidence/vps-aws-deployment-2026-10-26.txt), [e2e run](evidence/e2e-vps-aws-2026-10-26.txt)); "local" means it ran on k3d ([evidence folder](evidence/)).

## Mandatory

| Requirement | Status | Where / evidence |
| --- | --- | --- |
| Runs on local Kubernetes | Done | k3d, `scripts/dev-up.sh`, README "Local setup" |
| Deployable to a VPS with the same charts, config changes only | Done, live | `values-prod.yaml` + `scripts/vps-bootstrap.sh`; AWS EC2 k3s run, 65 checks pass |
| Helm only, local/prod via values files | Done | `deploy/helm/urumi`, `values-local.yaml`, `values-prod.yaml` (ADR 0005) |
| Everything in the cluster (store, DB, MCP server, gateway, dashboard) | Done | `docs/system-design.md` |
| Persistent storage for DB and WordPress | Done | PVCs on `local-path`; `helm.sh/resource-policy: keep` |
| Storefront and dashboard through Ingress, stable URLs, local domain approach documented | Done | README, `docs/vps-deploy.md` (hosts file locally, `*.localhost` for stores) |
| Readiness/liveness probes, requests and limits on every workload | Done | chart templates; `helm test` |
| No hardcoded secrets; Kubernetes Secrets | Done | `scripts/lib/secrets.sh` generates them; `deploy/secrets/` is ignored; scanned before commit |
| WooCommerce MCP server written by us, Streamable HTTP | Done | `apps/woocommerce-mcp`; tools: list/create product, list/get order, update order status (and more) |
| MCP server not reachable from outside the cluster | Done | `ClusterIP` + NetworkPolicy admits only the gateway; `scripts/security-check.ts` |
| Documented how it talks to the store and why | Done | ADR 0004 (REST API with a scoped key) |
| Gateway: add/edit/disable/remove upstreams with an optional static credential | Done | dashboard Servers page, `docs/api.md` |
| One MCP endpoint, aggregated list, routed calls | Done | `apps/gateway/src/router.ts`, `docs/mcp-internals.md` |
| Tool name collisions handled with a documented scheme | Done | `<server>__<tool>` namespacing, `packages/mcp-names`, ADR 0003 |
| Slow or dead upstream does not break others; timeouts and clear errors | Done | per-call timeout, `upstream_unreachable`; e2e "kill an upstream pod" (live) |
| Upstream credentials never reach the browser or clients | Done | AES-GCM at rest, never returned by the API; e2e "a member never receives an upstream URL" |
| At least three upstream servers | Done | WooCommerce, utility, policy (plus per-store and hosted ones) |
| Two roles; per-user API keys, revocable, hashed | Done | admin/member; SHA-256 key hashes; e2e revoke test |
| Audit log with user, server, tool, time, duration, outcome, visible in dashboard | Done | Audit page; e2e "Audit" section |
| Chat agent calling tools through the gateway, shows tools called, acts as the logged-in user | Done in code and tests | `apps/gateway/src/chat.ts`; tested with a fake LLM. **Not run against a real LLM yet**, see below |
| LLM key handled as a secret | Done | `gateway-llm` Kubernetes Secret, never in source or values files |
| Definition of done flow with two users | Done, live | `scripts/e2e.ts` (65 checks) on the AWS deployment |

## Bonus: multi-store provisioning

All of it: create/delete from the dashboard, several in parallel, a namespace per store with its own database, Secrets, volumes and Ingress host, automatic MCP registration with store-named tools, clean teardown, NetworkPolicy isolation, ResourceQuota and LimitRange, a per-user cap, a provisioning timeout, and recovery after a provisioner restart (`scripts/recovery-check.ts`). Live: two stores created in parallel on the VPS, orders compared across them, one deleted with its tools, namespace, volumes and registration gone.

## Other ways to stand out

| Item | Status | Where |
| --- | --- | --- |
| 1. Production-like VPS deployment, documented values, TLS with cert-manager | Done, live | AWS EC2 + k3s + Let's Encrypt; [vps-deploy.md](vps-deploy.md) |
| 2. Tool permissions (hidden and rejected) | Done | ADR 0010, `policy.ts`, Permissions page |
| 3. OAuth on the gateway | Done | ADR 0012, `oauth.ts`, `scripts/oauth-demo.ts` |
| 4. Handling many tools | Done | ADR 0017, `search.ts` (`search_tools`, `describe_tool`, `call_tool`) |
| 5. Hosted MCP servers from an image | Done, live | ADR 0016, `urumi-hosted-mcp` chart |
| 6. Security hardening: SSRF, least-privilege RBAC, default-deny, non-root, encrypted credentials | Done | ADR 0011, 0015; `docs/threat-model.md`, `docs/security-test-log.md` |
| 7. Scaling: several gateway replicas, rate limits | Done | ADR 0022; load test, HPA 2 to 4 (local) |
| 8. Observability: metrics, failure reasons | Done | Prometheus, Grafana, Tempo, alert rules; ADR 0020 |
| 9. Upgrades and rollback | Done | ADR 0021, `docs/runbook-upgrade-rollback.md`, `scripts/rollback-rehearsal.sh` |

## Deliverables

| Deliverable | Status |
| --- | --- |
| README with local setup, VPS setup, placing an order, connecting an external client, using chat | Done |
| Source for dashboard, backend/gateway, WooCommerce MCP server, chat agent | Done |
| Helm charts and local/prod values | Done |
| System design and trade-offs note | `docs/system-design.md` |
| Threat model note | `docs/threat-model.md` |
| List of bonus and stand-out items | This file and README |
| **Demo video** | **Not done: you record it** (script in [demo-script.md](demo-script.md)) |
| **Form submission** | **Not done: you submit it** (https://forms.gle/nftwgyNeenSDmiRb6) |

## What is still open

1. **A live chat run with a real LLM.** The tool loop is tested with a fake model, and everything it calls is proven live, but the brief says the chat agent must work in the demo. Put a key in the `gateway-llm` Secret (any OpenAI-compatible provider works; the README lists free tiers), then run the chat steps of [demo-script.md](demo-script.md).
2. **Demo video and form.** Yours to record and submit.
3. **A real domain.** The live deployment uses `sslip.io` names that resolve to the instance's Elastic IP. The certificates are real Let's Encrypt certificates, but the names are not ones you own. Pointing a real domain at it is a values change only.
4. **Known limits** (stated rather than hidden): one laptop node cannot show throughput scaling; one single-node VPS has no node-failure tolerance; the alert rules have no receiver; images were copied to the node rather than pulled from a registry.
