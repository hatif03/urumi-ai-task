# Round 1 completion plan

Written 2026-10-20 after auditing the repo against the Round 1 brief. `plan.md` is the original build plan for the core. This file is the plan for everything that is still missing or weak: the audit findings, the bonus, the stand-out items, the documentation, and the interview study set. Each decision below becomes an ADR in `docs/adr/` in the same change that builds it (rule from ADR 0001).

## 1. Where the repo stands

The core path was built and run on k3d on 2026-10-14 (see `docs/log.md`). It has: Bun and Hono services, a Helm chart with local and prod values, WooCommerce on official images, a self-written WooCommerce MCP server with five tools, two extra upstreams (`utility`, `policy`), a stateless gateway with prefixed tool names, hashed API keys, AES-GCM upstream credentials, an audit log, a chat agent, two replicas, Prometheus, Grafana and Tempo, and 13 passing unit tests.

### Brief requirement coverage

| Brief item | State | Gap |
| --- | --- | --- |
| Store on k8s, PVs, Ingress, probes, limits, Secrets | Done | TLS value exists but the Ingress does not use it |
| WooCommerce MCP, 5 tools, private | Done | `create_product` has no `status`/`sale_price`; no pagination metadata |
| Gateway: add/edit/disable/remove, collisions, timeouts | Mostly | Dashboard has no **edit**; no credential rotation UI |
| Three upstreams | Done | `utility` and `policy` are toy servers |
| Roles, hashed keys, revoke | Mostly | Admin cannot see or revoke another member's keys; members cannot be re-enabled; no password change |
| Audit log "who, which server and tool, when, how long, outcome" | **Broken in the UI** | API returns user ids only, the table omits user and duration, filters run after `limit 100`, `from`/`to` are ignored |
| Chat agent | Done | System prompt hardcodes tool names; no history; no per-user limit |
| Bonus: multi-store provisioning | Not started | Everything |
| Tool permissions | Stub (`policyAllows()` returns allowed) | Everything |
| OAuth | Not started | Everything |
| Many tools | Not started | Everything |
| Hosted MCP servers | Not started | Everything |
| VPS / TLS | Values file only | No TLS wiring, no cert-manager, no VPS runbook |
| Upgrade and rollback | One sentence in README | Procedure, evidence, `helm test` |
| Threat model | Draft, controls partly unproven | New controls and demonstrations |

### Defects found in the existing code

These are fixed in phase 1 before any new feature, because every new feature sits on them.

1. `ssrf.ts`: `address.startsWith("ff")` is applied to hostnames, so `ffmpeg.example.com` is rejected as multicast. IPv4-mapped IPv6 (`::ffff:169.254.169.254`) is not recognised. The DNS answer is checked and then discarded, so the connection re-resolves (DNS rebinding window). `pinnedFetchUrl` exists and is unused.
2. `postgres.ts` `listAudit`: `limit` is applied in SQL and the user, server and outcome filters in JavaScript afterwards, so a filtered page can be empty while matching rows exist. `from` and `to` are accepted by the API and ignored.
3. `app.ts` `tools` hook: on `tools/call` for a name that is not in the catalog it fabricates a definition (`"upstream tool"`) so the call reaches the router. It works, but it hides "unknown tool" behind the router and calls `catalog()` (a fan-out) on every request including `ping`.
4. The `/mcp` endpoint does not validate `Origin`. The Streamable HTTP spec requires it to stop DNS-rebinding attacks from a browser on the same machine.
5. `migrate.ts` is a list of `create table if not exists` statements, duplicated by the Drizzle schema. Nothing records which migration ran, so a column change cannot be applied to an existing database.
6. Login has no throttle. An admin can disable their own account. There is no password change.
7. Chat: `SYSTEM` names `utility__get_current_time` and `woocommerce__list_orders`. With several stores the prompt is wrong and with a renamed server it is dead text.
8. `ToolRouter.catalog()` drops a duplicate public name silently. Slugs are unique, so it cannot happen today, but it hides a bug if it ever does.

## 2. Principles

- Every new capability is reachable only through the gateway. Upstream credentials never reach the browser or a client.
- One mechanism per job. Policy is checked in one place (the router) and both `/mcp` and chat go through it.
- Idempotent and resumable: every long operation is a state machine whose steps can be repeated.
- Smallest implementation that meets the brief, with a `ponytail:` comment where a known ceiling is accepted.
- A claim in `docs/threat-model.md` or `docs/system-design.md` needs a demonstration line (test, script or cluster output). No demonstration, no claim.
- Docs are written with the code, not after.

## 3. Phases

Each phase ends with `bun test` green, `helm lint` and `helm template` green for both values files, and the docs for that phase written. Cluster verification runs whenever Docker is available.

### Phase 0. Baseline and plan (this file)

Run tests and lint, record the baseline, list defects (above). Done when this file exists.

### Phase 1. Fix the core

| Item | Change |
| --- | --- |
| Migrations | `schema_migrations(version, applied_at)`; ordered list in `migrate.ts`; the current statements become migration 1; new tables arrive as 2..n. Drizzle schema stays as the typed query layer and a test fails if a table in the schema is missing after `migrate()` |
| Audit | One SQL query with `left join users`, filters (`user`, `server`, `tool`, `outcome`, `from`, `to`), keyset pagination (`before_id`), and a `username` column. Dashboard shows who, server, tool, outcome, duration, time and trace id |
| SSRF | Only apply the address-literal rules to IP literals. Normalise IPv4-mapped IPv6. Resolve once, check every answer, then connect to the checked address through a custom `fetch` handed to the MCP client transport (Host/SNI preserved). Unit tests for each class |
| `/mcp` hardening | `Origin` allowlist, `tools/call` resolved by the router (unknown tool = JSON-RPC `-32602`), catalog fan-out only for `tools/list`, `WWW-Authenticate` with `resource_metadata` (needed in phase 5) |
| Accounts | Login throttle (per username and per IP, token bucket in Postgres), password change, cannot disable or demote the last admin, re-enable member, admin can list and revoke any member's keys |
| Dashboard | Edit server (name, URL, credential rotate), tool list with descriptions per server, status reason, audit table, confirm dialogs, basic responsive CSS. No UI library. Keep React + react-router |
| Chat | System prompt without names (generic), per-user rate limit, tool-call trace shows server, tool, duration and result summary, messages kept in `sessionStorage` |
| Ingress / TLS | `ingress.tls.enabled` actually adds `tls:` blocks and the cert-manager annotation; `ClusterIssuer` template behind `certManager.enabled`; `COOKIE_SECURE` follows |
| Namespaces | Pod Security `baseline` enforce and `restricted` warn labels on `platform`; `baseline` on stores |

### Phase 2. Tool permissions (stand-out 2)

Data: `tool_grants(id, subject_type 'role'|'user', subject, server_slug, tool_pattern, effect 'allow'|'deny', created_at)`. Pattern is an exact tool name or `*`.

Rule: most specific wins, `deny` beats `allow` at equal specificity, admin has an implicit allow-all that only an explicit user-level deny overrides, and the default for a member with no matching rule is the seeded policy (read tools allowed, write tools denied). "Read" is the upstream's own `readOnlyHint` annotation. There is no name-based guess: an unannotated tool counts as a write, the MCP default (as built, ADR 0010).

Enforcement in `ToolRouter`: `catalog(caller)` filters (hidden from `tools/list` and chat) and `call()` rejects with outcome `denied` and an audit row. One function, `decide(caller, server, tool)`, used by both. Dashboard page "Permissions" with a server × tool × role matrix. Seed: member may not call `woocommerce__create_product` or `woocommerce__update_order_status`.

Done when: a member does not see `create_product`; a direct `tools/call` returns `denied` and appears in audit; an admin still succeeds; a per-user allow lets one member create products.

### Phase 3. Many tools (stand-out 4)

A second tool surface of three meta-tools, `search_tools(query, limit)`, `describe_tool(name)`, `call_tool(name, arguments)`. Served at `/mcp?surface=search` (a query parameter; there is no per-key toggle) and used automatically by chat when the permitted catalog exceeds `CHAT_DIRECT_TOOL_LIMIT` (default 20). Search is BM25 over name, description and parameter names, computed in memory from the cached catalog. No embeddings (a model call per search is cost and a new dependency for a catalog of hundreds). `call_tool` goes through the same `decide` and `call` path, so permissions, audit and rate limits are unchanged and the audit row names the real tool.

Done when: a catalog of 300 synthetic tools (a test fixture upstream) is searchable, `call_tool` runs the right one, a denied tool is not found by search, and the model context holds three tool definitions plus results.

### Phase 4. Security hardening (stand-out 6)

SSRF (phase 1), plus: default-deny egress for `platform` with explicit allows (already there; extended to the provisioner), non-root and read-only root filesystem for every Bun container, dropped capabilities, `seccompProfile: RuntimeDefault`, secrets rotation procedure for `CREDENTIAL_KEY` (key id on each ciphertext, re-encrypt command), response size caps on upstream results, a tool-description sanitizer that strips control characters and caps length before they reach a model, and a written test log (`docs/security-test-log.md`) with the exact commands and output.

### Phase 5. OAuth for the gateway (stand-out 3)

Implement the MCP authorization spec (2025-11-25) on the gateway as authorization server and resource server, opaque tokens, API keys unchanged.

- `GET /.well-known/oauth-protected-resource` (RFC 9728) and `GET /.well-known/oauth-authorization-server` (RFC 8414).
- `POST /oauth/register` dynamic client registration (RFC 7591), public clients only, redirect URIs must be `https`, `http://localhost`/`127.0.0.1` loopback, or a custom scheme registered at creation.
- `GET /oauth/authorize` requires the dashboard session (redirect to login), shows a consent page in the dashboard, PKCE `S256` mandatory, `resource` parameter (RFC 8707) must equal the gateway MCP URL.
- `POST /oauth/token` for `authorization_code` and `refresh_token` (rotation), tokens `umo_...` stored as SHA-256, audience-bound to the MCP URL.
- `/mcp` accepts `umk_` keys and `umo_` tokens through one `callerFromBearer`.
- Tables: `oauth_clients`, `oauth_codes` (short-lived, single use), `oauth_tokens` (access and refresh, `revoked_at`, `expires_at`).

Done when: MCP Inspector (or a scripted PKCE client in `scripts/oauth-demo.ts`) completes the browser flow, calls a tool, and the audit row shows the user. Token passthrough remains forbidden: no OAuth token is ever forwarded upstream.

### Phase 6. Multi-store provisioning (bonus)

New service `apps/provisioner` (Bun, one Deployment; per-row leases with `for update skip locked` make a second replica safe, so production values run two) and a new chart `deploy/helm/urumi-store` (one store = WordPress, MariaDB, bootstrap Job, WooCommerce MCP server, Ingress, ResourceQuota, LimitRange, NetworkPolicies).

Why a separate service: it is the only workload with Kubernetes API rights. The gateway, which parses untrusted upstream output, never holds them.

Why Helm: the brief allows Helm or the API. A chart gives one reviewed definition of a store, `helm upgrade --install` is the retry mechanism, `helm uninstall` is the teardown, and `helm get values` is the audit of what was applied. The `helm` binary is copied into the provisioner image; reads of cluster state use the Kubernetes REST API with the service-account token.

State (provisioner-owned table `stores` in the platform Postgres): `id uuid`, `owner_id uuid`, `name`, `slug` (unique, `^[a-z][a-z0-9]{2,15}$`), `namespace` (`store-<slug>`), `host`, `status` (`provisioning|ready|failed|deleting`), `phase` (`namespace|release|ready-wait|register|done`), `reason`, `attempt`, `deadline_at`, `lease_owner`, `lease_until`, `created_at`, `updated_at`. Unique `(owner_id, name)` makes create idempotent. The per-user cap (`MAX_STORES_PER_USER`, default 3) is enforced in the same transaction as the insert.

Reconciler loop (every 3 seconds): claim one row with `for update skip locked` and a lease, run the next phase, write progress, release. Each phase is safe to repeat:

1. `namespace`: create `store-<slug>` with labels `urumi.io/managed=true`, `urumi.io/store=<slug>`; create the RoleBinding that gives the provisioner's service account the `urumi-store-admin` ClusterRole in that namespace only; create the generated Secrets (DB passwords, WP admin, WooCommerce consumer key and secret) if missing.
2. `release`: if `helm status` shows `pending-*` or `failed` (a killed process), `helm uninstall` it first; then `helm upgrade --install --wait --timeout <remaining>`.
3. `ready-wait`: poll Deployments and the bootstrap Job.
4. `register`: upsert the MCP server `store_<slug>` in the gateway through its internal API (service token, only reachable from the provisioner pod).
5. `done`: status `ready`.

Timeout: `deadline_at = created_at + PROVISION_TIMEOUT` (default 10 minutes). Past it the row becomes `failed` with the last phase and the failing resource in `reason`. A failed store can be retried (`attempt + 1`, new deadline) or deleted. A provisioner restart changes nothing: the next tick resumes from `phase`.

Delete: status `deleting`; unregister from the gateway first (tools vanish immediately), `helm uninstall`, delete the namespace (PVCs go with it; the store StorageClass uses `reclaimPolicy: Delete`, and the check lists PVs afterwards), delete the row. Every step is idempotent, so a crash mid-delete converges.

Isolation: per-namespace default-deny; allows are WordPress ← ingress-nginx and ← its own MCP pod, MariaDB ← its own WordPress and bootstrap, MCP ← pods in `platform` labelled `app=gateway`, MCP → its own WordPress, DNS. No policy admits traffic from another `store-*` namespace. Demonstration: a pod in `store-a` cannot open `mariadb.store-b:3306` or `wordpress.store-b:80`; a pod in `store-b` can open its own.

Guardrails per namespace (chart values): `ResourceQuota` (pods 10, requests 1 CPU / 1Gi, limits 2 CPU / 2Gi, PVC 3, storage 6Gi) and `LimitRange` (default request 50m/128Mi, default limit 500m/512Mi). The numbers come from measuring one idle store.

Least-privilege RBAC for the provisioner, in three layers:
- ClusterRole `urumi-provisioner`: `namespaces` create/get/list/delete; `rolebindings` create; `clusterroles` `bind` with `resourceNames: [urumi-store-admin]`.
- ClusterRole `urumi-store-admin`: only the namespaced kinds a store chart uses.
- A `ValidatingAdmissionPolicy` that denies RoleBinding creation by the provisioner outside a namespace labelled `urumi.io/managed=true`. The provisioner cannot patch a namespace, so it cannot label `kube-system` to get around it.

Hosted store hostnames: `<slug>.shop.localhost` locally (browsers and curl resolve `*.localhost` to loopback with no hosts-file entry per store) and `<slug>.<stores.baseDomain>` in production (wildcard DNS). WordPress `WP_HOME` is set from it.

Dashboard: Stores page with the table (name, status, phase, URL, created, reason), create form, delete with confirm, polling. Chat test: "compare today's orders in store alpha and store beta" uses `store_alpha__list_orders` and `store_beta__list_orders`.

### Phase 7. Hosted MCP servers (stand-out 5)

Admin adds a server by image instead of URL. Reuses the provisioner: a small chart `deploy/helm/urumi-hosted-mcp` (Deployment, Service, Secret for env/credentials, ResourceQuota is shared at namespace level, per-server NetworkPolicy) installed in the namespace `mcp-hosted`. Rules: image reference must match an admin-configured registry allowlist, no `latest`, no privileged anything, non-root, read-only root filesystem, no egress except DNS and, optionally, an admin-listed host, CPU/memory limits from a fixed small/medium/large choice. The gateway registers the ClusterIP URL; delete removes workload, Secret, policy and registration. Table `hosted_servers(id, server_id, image, size, release, status, reason, ...)`.

Done when: adding the repo's own `utility-mcp` image as a hosted server yields working `hosted_utility__*` tools, killing its pod shows Unreachable, and delete leaves nothing in `mcp-hosted`.

### Phase 8. Scale, observability, upgrades, VPS

- Scaling: a load script (`scripts/loadtest.ts`) drives tool calls while HPA scales the gateway 2 to 4; records success rate and p95 before and after. Per-key rate limit stays. Document why MCP sessions survive replica changes (no sessions).
- Observability: Prometheus alert rules (`UpstreamDown`, `ToolErrorRatioHigh`, `GatewayLatencyP95High`, `StoreProvisioningFailed`) in the Prometheus ConfigMap, `store_provision_duration_seconds` and `stores_by_status` metrics, a "Why" field: the status detail stores the classified reason (`dns`, `refused`, `timeout`, `tls`, `auth`, `protocol`).
- Upgrades: `docs/runbook-upgrade-rollback.md` for the gateway, the MCP servers, and a store (including the plugin migration caveat and PVC snapshots), a `helm test` hook that runs the smoke script, and a recorded rollback of a deliberately broken gateway image with the audit log intact.
- VPS: `docs/vps-deploy.md` and `scripts/vps-bootstrap.sh` (k3s with Traefik disabled, ingress-nginx, cert-manager, secrets, `helm upgrade --install -f values-prod.yaml`) plus an itemised list of every value that changes. I have no VPS, so this is verified by rendering `values-prod.yaml`, by running the same chart on k3d with the production-shaped values (TLS issuer `selfSigned`), and by a checklist the candidate runs once on a real node. The docs will say exactly that.

### Phase 9. Documentation

Written alongside each phase, then consolidated in phase 9:

| File | Content |
| --- | --- |
| `docs/adr/0009...00NN` | One ADR per decision in this plan, each with options, decision, why, consequences, and an outcome line updated with evidence |
| `docs/data-model.md` | Every table, column, type, constraint, index, with the reason for each type choice, plus an ER diagram (mermaid) |
| `docs/api.md` | Every HTTP route, auth, request and response shapes, error codes |
| `docs/mcp-internals.md` | The path of one tool call, name scheme, timeouts, caching, failure matrix |
| `docs/system-design.md`, `docs/threat-model.md` | Updated to the finished system, evidence table filled |
| `docs/runbook-upgrade-rollback.md`, `docs/vps-deploy.md`, `docs/security-test-log.md` | Procedures with recorded output |
| `docs/demo-script.md` | Definition-of-done flow, minute by minute, with the commands and the two users |
| `README.md` | Local, VPS, order, MCP client, chat, bonus list with paths |
| `docs/log.md` | Append-only entries per phase |

### Phase 10. Interview study material

`docs/study/` (not part of the submission claim, written for the candidate):

- `00-start-here.md`: how to use the set and a 7-day plan.
- `01-concepts.md`: plain-language primers (MCP, JSON-RPC, Streamable HTTP, OAuth 2.1 + PKCE, Kubernetes objects used here, Helm, NetworkPolicy, RBAC, reconcile loops, SSRF, hashing vs encryption, token bucket), each tied to the file where this repo uses it.
- `02-walkthrough.md`: the code, file by file, in the order a reviewer will ask.
- `03-interview-questions.md`: 80+ likely questions with model answers that cite the code, grouped by the demo-video sections in the brief, including "what would you do differently" and "what breaks at 10x".
- `04-tradeoffs-cheatsheet.md`: one page, decision / alternative / why / cost.
- `resources.md`: verified videos, blogs, specs, by topic (being researched in parallel, only links that were actually fetched).

## 4. Order and dependencies

```
0 plan → 1 fix core → 2 permissions → 3 many tools → 4 hardening → 5 OAuth
                                   ↘ 6 multi-store (needs 1 SSRF/migrations) → 7 hosted MCP (reuses 6)
                                   8 scale/obs/upgrade/VPS (needs 6 for alerts) → 9 docs → 10 study
```

Phases 2, 3 and 5 only touch the gateway and dashboard; 6 and 7 add a service and two charts. Work stays in that order so the core is never broken for the bonus.

## 5. Test strategy

- Unit and in-process integration (`bun test`): SSRF classes, migrations idempotent, audit query, permission decision table, search ranking, OAuth PKCE and redirect-URI rules, rate limiter, reconciler state machine against a fake Kubernetes/Helm runner (restart in every phase, assert convergence).
- Cluster (`scripts/e2e.ts`, k3d): the definition-of-done list in order with two users, then the bonus test (two stores, compare orders, delete one, verify tools gone and namespace and PVs gone), then the isolation checks.
- Each cluster run is recorded in the ADR outcome line and `docs/log.md`.

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Laptop cannot hold three stores plus the platform | Store requests are small; stores run one replica; the first knob is observability retention, then store count, recorded as an experiment |
| Helm interrupted mid-install leaves `pending-install` | Reconciler detects and uninstalls before retry |
| RBAC `bind` escalation | Admission policy restricts where the provisioner can bind |
| `*.localhost` not resolving in some tools | Documented fallback: hosts-file lines per store, or `nip.io` |
| VPS unavailable | Render and k3d-with-prod-shaped-values proof; real-node checklist for the candidate |
| Scope | Order above; the core is never held hostage to the bonus |

## 7. Status at the end of the build (2026-10-20)

Everything in sections 3 and 4 was built except where a later ADR says otherwise. Differences from the plan as written: no name-prefix fallback for read tools and no per-key search toggle (above); the provisioner uses row leases instead of a leader lease; the "key id on each ciphertext" idea became `CREDENTIAL_PREVIOUS` plus `rekey.ts` (ADR 0009 area, runbook); the tool-description sanitiser, a result size cap and per-user chat call limits were added after the first end-to-end run; a real VPS deployment was not possible from this environment and is a documented checklist plus a TLS rehearsal on k3d. The evidence is in `docs/log.md` and `docs/evidence/`.
