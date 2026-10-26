# Code walkthrough

The order a reviewer will ask: store, store's MCP server, shared adapter, gateway, provisioner, dashboard, charts, scripts. For each part: what it is for, the functions that matter, how data moves, and what breaks without it. Then three end-to-end traces.

Layout of the repo:

```
apps/woocommerce-mcp   our MCP server for WooCommerce (5 tools)
apps/utility-mcp       tiny MCP server: get_current_time, echo
apps/policy-mcp        tiny MCP server: get_return_policy, list_shipping_options
apps/mcp-http          shared "stateless Streamable HTTP" server adapter (Hono)
apps/gateway           MCP gateway, auth, audit, permissions, OAuth, chat, dashboard API
apps/provisioner       creates and deletes stores and hosted MCP servers
apps/dashboard         React SPA
packages/mcp-names     slug and tool-name rules
packages/obs           JSON logs, Prometheus metrics, W3C trace context
deploy/helm/urumi            platform chart (one release, local and prod values)
deploy/helm/urumi-store      one release per provisioned store
deploy/helm/urumi-hosted-mcp one release per hosted MCP server
scripts/               dev-up.sh (bring up k3d), e2e.ts (definition of done), smoke scripts
docs/                  ADRs, experiments, log, system design, threat model, these notes
```

---

## 1. The store (WordPress, WooCommerce, MariaDB)

**Responsibility.** A real storefront with checkout (cash on delivery) and an admin, on persistent disks.

**Where.** `deploy/helm/urumi/templates/mariadb.yaml` (StatefulSet, PVC from `volumeClaimTemplates`), `wordpress.yaml` (Deployment, PVC `wordpress`, startup/readiness/liveness probes), `bootstrap.yaml` with `files/bootstrap.sh` and `files/setup.php` (Job), `ingress.yaml` (host `shop.local`).

**How it starts.** The `store-bootstrap` Job runs the `wordpress:cli` image against the same PVC: waits for the database, `wp core install`, pretty permalinks, installs and activates WooCommerce, writes a mu-plugin, then `setup.php` turns off coming-soon mode, enables guest checkout and cash on delivery, creates an "Everywhere" shipping zone with a zero-cost flat rate, inserts the REST API key from a Secret directly into `wp_woocommerce_api_keys`, and seeds a sample product. It is rerunnable.

**Gotchas recorded on the cluster** ([docs/log.md](../log.md) 2026-10-14, [ADR 0004](../adr/0004-woocommerce-on-official-images.md)): WooCommerce accepts consumer-key basic auth only when `is_ssl()` is true, so the config marks `/wp-json/wc/` requests as HTTPS and the mu-plugin clears the flag afterwards so permalinks stay `http://`; the WP-CLI image's `www-data` is uid 82 while Apache's is 33, so the Job runs as root and `chown`s `wp-content` to 33.

**If removed.** There is nothing for the MCP server to talk to.

---

## 2. The WooCommerce MCP server (`apps/woocommerce-mcp/src/index.ts`)

**Responsibility.** Turn five MCP tools into WooCommerce REST calls. Written by us, as required; no existing WooCommerce MCP server or plugin is installed, and WooCommerce's own built-in MCP preview is deliberately not enabled.

**Key functions.**

- `wc(path, init)`: the only place that talks to the store. It is a span (`woocommerce.http`) when a trace is active, and the inner `wcRequest` does the `fetch` to `WC_BASE_URL` (`http://wordpress.store.svc.cluster.local`) with HTTP Basic auth from `WC_CONSUMER_KEY` and `WC_CONSUMER_SECRET`, a 5 second timeout, `redirect: "manual"`, and a `traceparent` header taken from `currentTrace()` so the store call joins the gateway's trace. Network failures get `code = upstream_timeout` or `upstream_unreachable`.
- `mapWc(fn)`: turns results into MCP tool results. 401 and 403 become a tool error ("store rejected the MCP server credential"), 404 becomes "not found". Timeout and unreachable errors are *rethrown* so the adapter reports a JSON-RPC error and the gateway can mark the upstream unreachable.
- `timezone()`: reads the store timezone once an hour from `wc/v3/system_status` and puts it into the `list_orders` description. The model uses it to turn "today" into a date range.
- `slimProduct`, `slimOrder`: return only the fields a model needs (and no billing address beyond first name).
- Tools: `list_products` (search, page), `create_product` (name, `regular_price` as a string; published and visible), `list_orders` (after, before, status list defaulting to pending, processing, on-hold, completed so a cash-on-delivery order shows), `get_order`, `update_order_status` (enum of statuses). Read tools carry `readOnlyHint: true`; `update_order_status` carries `destructiveHint: true`. The gateway's default permission rule depends on those annotations.
- Readiness: `ready` is answered from a background check (`checkStore`, every 10 s, treated as fresh for 45 s), not from a live WordPress call. A probe that called WordPress inside the handler timed out under load, the pods went NotReady and the gateway lost the store ([experiment 0003](../experiments/0003-probe-timeouts-under-load.md)). When WordPress is really down the check fails, the pod goes unready within seconds and leaves its Service, so the gateway sees the upstream as unreachable rather than hanging.

**Why REST** (not WP-CLI exec): REST is WooCommerce's documented integration; exec would need pod-exec RBAC and tie each call to a shell ([ADR 0004](../adr/0004-woocommerce-on-official-images.md)).

**Data flow.** Gateway POST `/mcp` → adapter → handler → `wc()` → WordPress → MariaDB, and back.

**If removed.** The gateway still works with the other upstreams; there are no store tools.

---

## 3. The shared adapter (`apps/mcp-http/src/adapter.ts`)

**Responsibility.** One small stateless MCP server implementation reused by all four servers.

**Key function.** `createMcpApp(options)` returns a Hono app with `/healthz`, `/readyz`, `/metrics`, `GET|DELETE /mcp` (405) and `POST /mcp`.

`POST /mcp` order: check `mcp-protocol-version` against `2025-11-25` and `2025-06-18` (400 otherwise) → parse JSON (reject arrays) → optional `authorize` hook (the gateway uses it for auth and Origin checks) → notifications get 202 with no body → `initialize` answered directly → `ping`, `resources/list`, `prompts/list` answered empty → `tools/list` (paged 50) → `tools/call` (find tool, validate arguments with Zod or a small JSON Schema checker, run the handler inside an `mcp.tool <name>` span, record metrics, map exceptions to JSON-RPC errors using `error.code` and `error.rpcCode`) → anything else goes to the official SDK's transport as a fallback.

`listen(app)` starts two `Bun.serve` listeners: the app on 8080 and `/metrics` only on 9090, so metrics are not on the Ingress path. It also handles SIGTERM.

Why hand-written dispatch for the main methods: it avoids building an `McpServer` and a transport per request, which matters when the gateway builds its tool list per request. `adapter.test.ts` covers the wire behaviour.

**If removed.** Four services lose their MCP endpoint.

---

## 4. The gateway

### 4.1 Entry and composition (`apps/gateway/src/index.ts`, `app.ts`)

`index.ts` reads the environment (`DATABASE_URL`, `SESSION_SECRET`, `CREDENTIAL_KEY` are required), builds the Postgres store and the `ToolRouter`, starts the HTTP server and a 15 second timer that calls `router.probeOwned()`.

`createGatewayApp` (`app.ts`) stacks, in order: health routes, security headers, an Origin check on non-GET `/api` calls, public account routes (login, logout), a session check on `/api/*`, then account, member, server, admin and provisioning routes, chat, OAuth routes, the internal routes, and finally the MCP app. The routes live in `routes/`.

### 4.2 Authentication helpers (`auth.ts`)

`userFromCookie` (signed session cookie, then load the user and reject if disabled), `callerFromApiKey` (prefix lookup, SHA-256, `safeEqual`), `bearerToken`, `clientIp` (trusts `X-Real-IP`, which ingress-nginx sets), `originAllowed` (no Origin is fine; a present Origin must equal the request host or `ALLOWED_ORIGINS`), `publicBase` (the public URL from `PUBLIC_BASE_URL` or forwarded headers, used for OAuth identifiers).

**If removed.** No one can be identified.

### 4.3 The MCP endpoint (`mcp.ts`)

`mcpApp` wires the adapter to the router.

- `authorize`: checks Origin (403), then `authenticateMcp` (API key first, then OAuth token). Both resolvers return the user's role, so the user is not loaded a second time, and `last_used_at` on a key is written at most once a minute. On failure it writes an `unauthorized` audit row with no user and answers 401 with `WWW-Authenticate: Bearer resource_metadata=...`.
- `tools` hook: for `?surface=search` returns the three meta-tools; for `tools/list` returns the caller's permitted catalog; for `tools/call` returns one definition for the requested name so there is no catalog fan-out on the hot path. The router decides unknown tool, denied, and so on.
- `callThrough`: calls `router.call` and converts a failure into an error carrying `code` and `rpcCode` so the adapter answers with the right JSON-RPC code.
- `searchSurface`: `search_tools`, `describe_tool`, `call_tool` (section 4.8).

### 4.4 The router (`router.ts`), the heart

`ToolRouter` holds the upstream clients and does everything between "a caller wants tool X" and "an upstream answered".

- `catalog()`: all enabled servers, in parallel, each through `toolsFor`. A server that fails returns nothing, never an exception, so one dead upstream cannot break listing. Public names are `joinToolName(slug, tool)`; descriptions are prefixed `[slug]`.
- `catalogFor(caller)`: `catalog()` minus tools the caller may not use (`decide`). Both `/mcp tools/list` and chat use this.
- `toolsFor(server, force)`: serves the Postgres tool cache if it is under 30 s old and the server is not unreachable; otherwise takes a per-process lock, `listTools` with a 3 s timeout, `replaceTools` (one transaction, so a call between the delete and the insert can never see an empty cache), sets status `connected` or `unreachable` with an explained reason. Tool names containing `__` are skipped and reported. Descriptions are cleaned (`cleanDescription`); annotations are kept.
- `call(caller, publicName, args, traceId)`: **admission check first**: at most `MAX_INFLIGHT_CALLS` (default 24) calls in flight per replica; beyond that it answers at once with JSON-RPC `-32005` "overloaded", counted in `calls_shed_total`, with `calls_inflight` as a gauge ([ADR 0022](../adr/0022-admission-control-and-autoscaler-ownership.md)). Then: split the name (`splitToolName`) → find the server → refuse if disabled → rate limit (API keys use `key:<id>`, OAuth callers `oauth:<user>`, the chat actor `chat-call:<user>`; each is one atomic upsert in Postgres, there is no in-memory shortcut) → `findTool` (one tool-cache read; it refreshes the cache if the name is unknown) → `decide` permission → `invoke` with an 8 s timeout → refuse a result over `MAX_RESULT_BYTES` (1 MB) with an error result "result too large" → classify the outcome. Every path ends in `finish`, which writes the audit row, records metrics and logs. `create_product` and `update_order_status` are never retried; other calls retry once on a dropped connection. `invoke` runs the upstream call inside a `gateway.call_upstream` span, so the trace continues to the upstream.
- `withClient` / `clientFor`: warm client cache per upstream (60 s idle); concurrent calls on a cold replica share one connect attempt (the `connecting` map) instead of each opening a connection. On a new connection it runs `resolveUpstream` (SSRF), builds headers from scratch with the decrypted credential (bearer or named header; `decryptSecret` tries `CREDENTIAL_KEY`, then `CREDENTIAL_KEY_PREVIOUS`), uses `redirect: "error"` and `pinnedFetch` (which also sends `traceparent`). Inbound `Authorization` is never copied.
- `explainFailure`: turns an error into one short sentence with a label (`dns`, `connection refused`, `timeout`, `tls`, `upstream rejected the credential`, ...). Bun's "Unable to connect" is mapped to `connection refused`. It is what the dashboard shows as the reason an upstream is unreachable.
- `probeOwned` / `claimProbe`: every 15 s each replica tries to claim each upstream with a conditional update on `last_checked_at` (stale after 10 s); only the winner probes. Status is in Postgres, so every replica agrees.

Known limit: `withServerLock` in `postgres.ts` is a promise chain in one process, not a distributed lock. Two replicas can refresh the same server's tool cache at the same moment. The result is the same rows written twice; it is wasteful, not wrong.

**If removed.** There is no gateway.

### 4.5 Permissions (`policy.ts`)

`decide(subject, target, grants)` is a pure function. Matching grants are scored: a user rule beats a role rule; a tool rule beats a server rule beats a global rule; at equal score `deny` beats `allow`. With no match: admins are allowed; members are allowed only when the upstream annotated the tool `readOnlyHint: true`; an unannotated tool counts as a write. There is no guessing from names such as `list_`. Grants are rows in `tool_grants`, managed in `routes/admin.ts` and the Permissions page. `policy.test.ts` is the decision table. Enforcement is in `router.call` (reject and audit as `denied`, JSON-RPC code `-32003`) and in the catalog (hidden). Hiding alone is not a control; the call check is.

### 4.6 OAuth (`oauth.ts`)

See [01-concepts.md](01-concepts.md) section 3 for the sequence. Code map: `oauthRoutes` has discovery, `/oauth/register`, `/oauth/authorize` (GET consent, POST decision), `/oauth/token`, `/oauth/revoke`, and the dashboard-facing `/api/oauth/grants`. Helpers: `validRedirectUri`, `redirectMatches`, `parseClientMetadata`, `loadCimdClient`, `callerFromOAuthToken`. Persistence: `oauth_clients`, `oauth_codes`, `oauth_tokens` (migration 5). Tests: `oauth.test.ts` (18 cases including replay, rotation reuse, audience, disabled user).

### 4.7 SSRF (`ssrf.ts`), crypto (`crypto.ts`)

`resolveUpstream(url, allowlist)` validates and resolves, returning the URL and the checked address. `pinnedFetch` uses it for http upstreams. `isBlockedIp` uses Node's `BlockList` for IPv4 and IPv6 ranges and unwraps IPv4-in-IPv6. `crypto.ts`: `hashPassword`/`verifyPassword` (argon2id), `sha256Hex`, `safeEqual`, `createApiToken`, `encryptSecret`/`decryptSecret` (AES-256-GCM, stored as JSON `{iv, tag, ciphertext}`; `decryptSecret` tries `CREDENTIAL_KEY`, then `CREDENTIAL_KEY_PREVIOUS`), `signSession`/`readSession`/`hmac`. `rekey.ts` re-encrypts every stored upstream credential under the current key after a rotation (run it in the gateway pod; see [docs/runbook-upgrade-rollback.md](../runbook-upgrade-rollback.md)). `pinnedFetch` also copies `traceparent` from `currentTrace()` onto the outgoing request.

### 4.8 Search surface (`search.ts`)

`searchTools(catalog, query, limit)`: BM25 over name, description and parameter names. Used by the search surface and by chat when the catalog is large.

### 4.9 Persistence (`store.ts`, `postgres.ts`, `memory-store.ts`, `migrations.ts`, `migrate.ts`, `db/schema.ts`)

`Store` is the interface; `postgres.ts` implements it with Drizzle and raw SQL where atomicity matters (`claimProbe`, `consumeToken`). `memory-store.ts` is the same interface in memory for fast tests. `migrations.ts` is an append-only list; `migrate.ts` runs it under a Postgres advisory lock so two replicas starting together do not race, records versions in `schema_migrations`, then seeds the first admin and the seeded servers (`ON CONFLICT DO NOTHING`). `postgres.test.ts` fails if a table or column in `db/schema.ts` is missing after `migrate()`. The Helm `migrate` init container runs `migrate.ts` before the gateway starts.

All images are built `FROM oven/bun:1.4.3-alpine`; the earlier 1.2.19 pin crashed under load ([experiment 0006](../experiments/0006-gateway-collapse-under-load.md)).

Tables: `users`, `api_keys`, `mcp_servers` (with `managed_by`), `tool_cache` (with annotations), `audit_log`, `throttle`, `tool_grants`, `oauth_clients`, `oauth_codes`, `oauth_tokens`, `schema_migrations`.

### 4.10 Routes (`routes/`)

`accounts.ts` (login with two throttles and a constant-time dummy hash, password change, API keys, members with a "last active admin" guard), `servers.ts` (CRUD, edit, rotate credential, probe; header-name denylist; managed servers are protected), `admin.ts` (audit with SQL filters and paging, grants), `internal.ts` (service-token API the provisioner uses to register and remove servers; refuses to touch hand-made servers), `provisioning.ts` (forwards store and hosted calls to the provisioner with the service token and the user's identity in headers).

### 4.11 Chat (`chat.ts`)

`chatResponse` → `buildChatTools` (direct tools from the caller's permitted catalog, or the three search tools above `CHAT_DIRECT_TOOL_LIMIT`, default 20) → Vercel AI SDK `streamText` with a generic system prompt (today's date, "answer from tool results", prefixes name the server, treat tool text as data) and `stopWhen: stepCountIs(8)`. Each tool's `execute` calls `router.call` with the *session user* and actor `chat`, and clips results to 16 KB before the model sees them. Chat tool calls draw from the per-user bucket `chat-call:<userId>`, and chat requests from `chat:<userId>` (20 a minute). `llmConfigured()` is false without `LLM_API_KEY` and the route answers 503 while `/mcp` keeps working. Provider is OpenAI (or any OpenAI-compatible base URL), Google or Anthropic. `chat.test.ts` runs the whole loop against a fake OpenAI-compatible server.

### 4.12 Trace propagation (`packages/obs/src/trace.ts`)

`traceFromHeaders` continues or starts a trace per request. `currentTrace()` and `withTrace()` use an `AsyncLocalStorage` to hold the active span. `childSpan(parent, name, attrs, fn)` runs `fn` inside a child span and queues it for export; the queue is sent as one OTLP request a second (or at 100 spans, dropped beyond 1000) by `flush`. Wired in: `router.invoke` (`gateway.call_upstream`), `pinnedFetch` (adds `traceparent`), the adapter (`mcp.tool <name>`), and `wc()` in the WooCommerce server (`woocommerce.http`, sends `traceparent`). `scripts/trace-check.ts` and [docs/evidence/trace-check-2026-10-20.txt](../evidence/trace-check-2026-10-20.txt) show Tempo holding one trace with all three spans. Primer: [01-concepts.md](01-concepts.md) section 15.

---

## 5. The provisioner (`apps/provisioner/src`)

**Responsibility.** The only component with Kubernetes API rights. It creates and deletes stores and hosted MCP servers as resumable state machines.

- `index.ts`: reads config, runs migrations (`db.ts`), builds the real `Kube`, `Helm`, `Gateway`, starts one `Worker` for stores and one for hosted servers, a 1 s timer that starts up to `PROVISION_CONCURRENCY` (3) ticks, and the HTTP API on 8080 plus metrics on 9090.
- `ports.ts`: the three interfaces (`Helm`, `Kube`, `Gateway`). Tests replace them with the fakes in `fakes.ts`.
- `db.ts`: tables `stores` and `hosted_servers`; `claim` (`FOR UPDATE SKIP LOCKED` plus lease), `heartbeat`, `release`, `advance` (compare-and-set on status), `setReason`.
- `worker.ts`: `Worker.tick` claims a row and `run` loops through phases. `Retry` keeps the phase and delays; `Fail` ends in `failed` (or keeps retrying a delete); a deadline check runs before each step; a 5 s heartbeat renews the lease and aborts the running step if the row changed.
- `stores.ts`: the API logic (`createStore`, `listStores`, `retryStore`, `deleteStore`; slug rules; advisory lock for the per-user cap) and `storeSteps()`: namespace, secrets, release, register; unregister, uninstall, namespace, drain, forget. A namespace that exists without our label is never adopted or deleted. `deleting:uninstall` skips Helm when the namespace does not exist or is not ours, and calls `ensureRoleBinding` first otherwise.
- `hosted.ts`: image validation (explicit tag or digest, no `latest`, allowlisted prefix), env validation (name pattern, reserved names), sizes small/medium/large, secret env written straight to a Kubernetes Secret and never to Postgres, `hostedSteps()`.
- `kube.ts`: a small REST client (get/create/delete namespace, create RoleBinding, get/create/delete Secret, list PVs, pod problems) using the pod's service-account token. Treats 409 on create and 404 on delete as success.
- `helm.ts`: spawns the `helm` binary. Values go through a 0600 temp file. `status`, `upgradeInstall` (`--wait --wait-for-jobs --timeout`), `uninstall` (not-found is success).
- `gateway.ts`: calls the gateway's `/internal/servers/:slug` with the shared token; a 4xx is permanent (`permanent: true`), anything else retried.
- `api.ts`: `/v1/stores`, `/v1/hosted`; requires the service token and identity headers; members only see their own stores; hosted is admin only.

Tests: `provisioner.test.ts` (needs `TEST_DATABASE_URL`) covers the happy path, three stores at once, two workers never taking the same row, idempotent create, the per-user cap under parallel creates, a restart in each phase, a step error, a deadline, a failed helm install and retry, a foreign namespace, ordered teardown, delete during install, a stuck namespace, hosted validation and the HTTP API.

**If removed.** The core still runs; the bonus and hosted servers go away.

---

## 6. The dashboard (`apps/dashboard/src`)

React 19 and react-router 7; plain CSS; no UI library. `api.ts` is one typed `request()` helper plus one function per endpoint (a 401 sends the browser to `/login`). `ui.tsx` has `usePoll` (interval that pauses on hidden tabs and aborts stale requests), `Modal` (native `<dialog>`), `Pill`, `CopyButton`, `ErrorBoundary`. Pages are in `pages/`: Login (`?next=`), Servers, Stores, Hosted, Chat, Keys (API keys and connected OAuth apps), Members, Permissions, Audit, Account. Admin pages are lazy chunks. Full note: [docs/dashboard.md](../dashboard.md). The gateway enforces every rule again; the UI redirects are convenience.

---

## 7. The charts

**`deploy/helm/urumi` (platform, release `urumi` in `platform`).** Templates: `namespaces.yaml` (store, platform, mcp-hosted with Pod Security labels; hosted quota and limit range), `postgres.yaml`, `gateway.yaml` (init container `migrate`, env from Secrets, probes, non-root), `dashboard.yaml`, `mcp.yaml` (the three MCP servers, two replicas each), `mariadb.yaml`, `wordpress.yaml` and `postgres.yaml` (their PVCs carry `helm.sh/resource-policy: keep`), `bootstrap.yaml`, `ingress.yaml` (shop host; dashboard host with `/oauth`, `/.well-known`, `/api`, `/mcp` to the gateway and `/` to the dashboard; TLS blocks when enabled), `networkpolicy.yaml` (including `allow-acme-http01-solver`, which lets ingress-nginx reach cert-manager's solver pod), `hpa.yaml` (PDB and HPA per workload), `observability.yaml` (Prometheus with alert rules, Grafana, Tempo, OpenTelemetry collector), `provisioner.yaml` (ServiceAccount, the two ClusterRoles, the RoleBinding in `mcp-hosted`, the ValidatingAdmissionPolicy and its binding, Deployment, Service), `cert-manager.yaml` (ClusterIssuer: self-signed CA or ACME). `values.yaml` has defaults; `values-local.yaml` and `values-prod.yaml` are the only environment differences. `_helpers.tpl` has `urumi.bunSecurity`. The gateway, dashboard and MCP Deployments set no `replicas` (the HPA owns the count; `minReplicas` is `replicas.*` from values) and use `maxUnavailable: 0, maxSurge: 1`. `tests/smoke.yaml` is the `helm test` pod. Grafana has a startup probe (36 attempts, 5 s apart) because its migrations outlast the default liveness window ([experiment 0003](../experiments/0003-probe-timeouts-under-load.md)). `skeletonOnly` installs a placeholder nginx so ingress can be proven before the images exist.

**`deploy/helm/urumi-store`.** One store: PVCs, MariaDB, WordPress, bootstrap Job, MCP server (1 replica), Ingress, ResourceQuota `store-quota`, LimitRange `store-limits`, NetworkPolicies. It reads three Secrets the provisioner creates first. [ADR 0014](../adr/0014-store-chart.md).

**`deploy/helm/urumi-hosted-mcp`.** One hosted server: Deployment (non-root, read-only filesystem, no service-account token, no service links, TCP probes), Service `mcp-<slug>`, NetworkPolicy admitting only the gateway and allowing only DNS out.

---

## 8. Scripts

- `scripts/dev-up.sh`: create the k3d cluster, install ingress-nginx, generate Secrets once into `deploy/secrets/generated.env` (gitignored, helpers in `scripts/lib/secrets.sh`), prove ingress with the placeholder, build and import the six images, `helm upgrade --install`, restart rebuilt deployments. `SKIP_BUILD=1` and `ONLY=gateway,dashboard` shorten reruns.
- `scripts/e2e.ts`: the definition of done over HTTP with two users. `STORE_HOST_SUFFIX` and `HOSTED_IMAGE` let it target a real host (for example `stores.<domain>` and an image already on the node). On the AWS deployment it passed 65 of 65 checks ([docs/evidence/e2e-vps-aws-2026-10-26.txt](../evidence/e2e-vps-aws-2026-10-26.txt)). `STORES=1` adds the multi-store test (two stores in parallel, compare orders, delete one, check its tools, namespace and volumes are gone); `HOSTED=1` adds a hosted MCP server. Prints PASS or FAIL per line. Output: `docs/evidence/e2e-*.txt`.
- `scripts/oauth-demo.ts`: the full OAuth 2.1 PKCE flow against the cluster, including refresh rotation, reuse detection and revocation (`docs/evidence/oauth-demo-*.txt`).
- `scripts/security-check.ts`: tries the security claims against the live cluster (SSRF targets, permissions, credential storage, cross-store isolation when `STORE_A` and `STORE_B` are set).
- `scripts/trace-check.ts`: makes a call and asks Tempo for the trace (`docs/evidence/trace-check-*.txt`).
- `scripts/recovery-check.ts`: kills the provisioner during a Helm install and during a delete and checks the store completes with one namespace, one release and one set of credentials. The run recorded in `docs/evidence/recovery-check-2026-10-20.txt` killed the provisioner pod mid-Helm-install (the store still completed, with one namespace, one release lineage and one set of credentials) and mid-delete (the delete finished and the namespace, volumes and registration were gone). The provisioner pod is replaced in seconds, but the dead pod's 60 second lease must expire before the new pod resumes the row, so recovery takes a little over a minute.
- `scripts/ui-check.ts`: drives the real dashboard in headless Edge or Chrome with `puppeteer-core`, checks each page's own heading and that nothing logs a console error; screenshots in `docs/evidence/ui/`.
- `scripts/loadtest.ts`: drives tool calls through the gateway while the HPA scales (raise `gateway.ratePerMinute` for the run). The recorded run: 40 workers for 60 s through the ingress, 3508 calls, 58 a second, 99.46% success, no pod restarts, HPA 2 to 4 ([docs/evidence/loadtest-2026-10-20.txt](../evidence/loadtest-2026-10-20.txt), [ADR 0022](../adr/0022-admission-control-and-autoscaler-ownership.md)).
- `scripts/rollback-rehearsal.sh`: upgrades to a gateway image that dies on start and checks Helm reverts, old pods keep serving (150 of 150 probe answers during the failed rollout), the audit log is intact and `helm test` passes (`docs/evidence/rollback-rehearsal-*.txt`; the history shows revision 12 failed, then revision 13 "Rollback to 11").
- `scripts/tls-rehearsal.sh`: upgrades with the production TLS values and a self-signed issuer (`urumi-local-ca`), checks cert-manager issues the certificates, the OAuth resource identifier is https and the session cookie is `Secure`, then restores the local values (`docs/evidence/tls-rehearsal-*.txt`).
- `scripts/vps-bootstrap.sh`: turns a fresh Ubuntu VPS into a running install: installs `unzip` (Bun's installer needs it), k3s with Traefik disabled, Helm, ingress-nginx and cert-manager, generates the Secrets into `/root/urumi-secrets.env` (mode 600) and creates the Kubernetes Secrets, labels and annotates the pre-created `platform` and `store` namespaces so Helm 3 can adopt them, runs `helm upgrade --install --atomic --wait` with `values-prod.yaml` and overrides, then `helm test`. `.gitattributes` forces LF line endings because a Windows-made archive broke the script. It ran for real on AWS on 2026-10-26 (`docs/evidence/vps-aws-deployment-2026-10-26.txt`); runbook and the exact AWS commands: [docs/vps-deploy.md](../vps-deploy.md).
- `scripts/seed-check.sh`, `scripts/gateway-smoke.ts`: older smoke checks.
---

# Three end-to-end traces

## Trace A. User A asks the chat agent "what orders came in today?"

1. **Browser** (Chat page) `POST /api/chat` with the session cookie.
2. **ingress-nginx** matches host `dashboard.local`, path `/api`, forwards to Service `gateway:8080`.
3. **Gateway `app.ts`**: Origin check, `userFromCookie` loads user A, then `store.consumeToken("chat:<A>", 20)`. If no `LLM_API_KEY`, 503.
4. **`chat.ts` `buildChatTools`** calls `router.catalogFor(A)`: `catalog()` fans out to every enabled upstream (cache hit if under 30 s), then `decide` filters by A's role and grants. Under 20 tools, they become AI SDK tools.
5. **AI SDK `streamText`** sends the system prompt (today's date, rules) and tools to the LLM. The model returns a tool call `woocommerce__list_orders` with `after` and `before`, using the timezone written in that tool's description.
6. **`execute`** calls `router.call({userId: A, role, apiKeyId: null, actor: "chat"}, name, args, traceId)`.
7. **`router.call`**: admission check (under 24 calls in flight on this replica, otherwise `overloaded`), split name, server found and enabled, rate limit (the chat actor draws from `chat-call:<A>`), tool known, `decide` allows (A is admin), then `invoke`.
8. **`clientFor`**: warm client or new connection; `resolveUpstream("http://woocommerce-mcp.store.svc.cluster.local:8080/mcp")` allows the in-cluster name; headers built fresh. The call runs inside a `gateway.call_upstream` span and `pinnedFetch` adds `traceparent`, so the trace continues into the WooCommerce MCP server.
9. **Network**: the gateway's egress policy allows `woocommerce-mcp` in `store`; the MCP pod's ingress policy allows `app=gateway` in `platform`.
10. **WooCommerce MCP** adapter validates the arguments, runs the `list_orders` handler inside an `mcp.tool list_orders` span, which calls `wc("/wp-json/wc/v3/orders?...")` (a `woocommerce.http` span, with `traceparent`) with Basic auth to `wordpress:80`, which reads MariaDB. `slimOrder` shapes the rows.
11. **Back in the router**: `finish` inserts an audit row (user A, actor `chat`, server `woocommerce`, tool `list_orders`, duration, outcome `success`, trace id), increments `tool_calls_total`, observes `tool_call_duration_seconds`.
12. **`router.call`** has already refused any result over 1 MB. **`execute`** clips the result to 16 KB; the model reads it and writes the answer; `toUIMessageStreamResponse` streams SSE events back through ingress (proxy buffering is off for that path).
13. **Dashboard** parses `tool-input-available` and `tool-output-available`, shows the trace (server, tool, arguments, result) and the answer.

Where it can fail, and what the user sees: LLM key missing (503, message), upstream timeout (tool result `{error, code}`, model explains), tool denied (same shape), chat rate limit (429).

## Trace B. User B from an external client: API key, then OAuth

**By API key.**

1. Client sends `POST /mcp` with `Authorization: Bearer umk_...` and `initialize`.
2. Ingress sends `/mcp` to the gateway. The adapter checks the protocol header and parses.
3. `authorize` in `mcp.ts`: `originAllowed` (native clients send no Origin), `authenticateMcp` → `callerFromApiKey` (prefix lookup among live keys, SHA-256, `safeEqual`, user not disabled) → caller stored in a `WeakMap` keyed by the request; `touchApiKey`.
4. `initialize` is answered by the adapter. `tools/list` calls the `tools` hook → `router.catalogFor(B)` → B (a member) sees read-only tools plus any granted ones, `create_product` hidden.
5. `tools/call woocommerce__list_orders`: hook returns one tool definition → `callThrough` → `router.call` with `apiKeyId` set → rate-limit bucket `key:<id>` (60 per minute) → same path as steps 7-11 of trace A, with actor `mcp`. The audit row names user B.
6. Second upstream in one prompt: a call to `utility__get_current_time` goes through the same `call`, to `utility-mcp` in `platform`.
7. **Revoke**: user B (or an admin) `DELETE /api/api-keys/:id` sets `revoked_at`. The next request finds no live key for the prefix, so `authorize` writes an `unauthorized` audit row (no user, because the key did not resolve) and answers 401. This is a test in `router.test.ts`.

**By OAuth.**

1. Client calls `/mcp` without a token → 401 with `resource_metadata`.
2. Client fetches `/.well-known/oauth-protected-resource`, then `/.well-known/oauth-authorization-server`.
3. Client registers (`POST /oauth/register`) or uses a metadata-document `client_id`.
4. Browser opens `/oauth/authorize?...&code_challenge=...&resource=https://<host>/mcp`. No session → `/login?next=...` → dashboard login → back to authorize → consent page → Allow.
5. Redirect to the client with `code`, `state`, `iss`. Client `POST /oauth/token` with `code_verifier`. Gateway verifies PKCE, marks the code used, returns `umo_` access and `umr_` refresh tokens.
6. Client calls `/mcp` with the access token. `callerFromOAuthToken` checks hash, kind, expiry, revocation, `resource`, user. Router path is identical; rate bucket `oauth:<user>`.
7. Later `grant_type=refresh_token` rotates; replaying an old refresh token revokes the family.

## Trace C. Create a store from the dashboard, then delete it

**Create.**

1. **Stores page** `POST /api/stores {"name":"Alpha"}`. The gateway authenticates the session and `provisioning.ts` forwards to `http://provisioner:8080/v1/stores` with the service token and the user's id, name and role in headers.
2. **Provisioner `createStore`**: slug `alpha`; advisory lock on the owner; an existing slug owned by the same user returns that store (idempotent), owned by someone else is 409; more than 3 non-deleting stores is 429; otherwise insert `status=provisioning, phase=namespace, deadline_at=now+10 min`. Response 201.
3. **Dashboard** polls `GET /api/stores` every 3 s.
4. **Worker** (1 s timer) `claim`s the row (`FOR UPDATE SKIP LOCKED`, 60 s lease) and runs the steps:
   - `namespace`: create `store-alpha` with `urumi.io/managed=true`, `urumi.io/store=alpha`, Pod Security labels; create the RoleBinding granting `urumi-store-admin` in that namespace (the admission policy allows it because of the label).
   - `secrets`: create `store-db`, `store-admin`, `store-wc-api` with random values if absent.
   - `release`: `helm status`; if a half-installed release exists, uninstall it; `helm upgrade --install store-alpha /charts/urumi-store -n store-alpha -f values.json --wait --wait-for-jobs --timeout ...`. Helm creates PVCs, MariaDB, WordPress, the bootstrap Job, the MCP server, the Ingress for `alpha.shop.localhost`, the quota, the limit range, and the NetworkPolicies. A failure here becomes `failed` with helm's message and the pods that are not ready.
   - `register`: `PUT /internal/servers/store_alpha` on the gateway with the internal token. The gateway checks the URL (`woocommerce-mcp.store-alpha.svc.cluster.local` is an allowed in-cluster name), stores the server with `managed_by=store`, drops any warm client, probes it and returns the measured status. Not `connected` yet means `Retry` in 3 s.
   - `ready`: status `ready`, `ready_at` set.
5. **Result**: the gateway catalog now contains `store_alpha__list_orders` and friends. Calls travel gateway → (egress allowed to namespaces labelled `urumi.io/managed`) → `woocommerce-mcp` in `store-alpha` (ingress allowed from the gateway) → that store's WordPress and MariaDB.
6. **Isolation**: no policy in any `store-*` namespace admits another namespace, so `store-alpha`'s pods cannot reach `store-beta`'s database. Evidence for this check is in [ADR 0014](../adr/0014-store-chart.md) and [docs/log.md](../log.md).

**Delete.**

1. `DELETE /api/stores/:id` → provisioner `deleteStore` sets `status=deleting, phase=unregister` (only owner or admin).
2. If an install is running, its heartbeat sees the status change within 5 s and aborts `helm`.
3. `unregister`: gateway `DELETE /internal/servers/store_alpha` removes the row and drops the client, so the tools disappear from chat and external clients at once.
4. `uninstall`: if the namespace exists and carries this store's label, re-create the role binding (a crash can leave a namespace Helm cannot read) and run `helm uninstall`; if there is no namespace of its own, skip Helm, because the provisioner holds no rights in a namespace it does not own. (Found by the end-to-end run: a store deleted before its namespace existed hung in `deleting`; two regression tests cover it.)
5. `namespace`: delete `store-alpha` (only if its label says it is ours).
6. `drain`: wait until the namespace and every PV bound inside it are gone (`Retry` every 4 s, reason shown).
7. `forget`: delete the row. A delete that cannot finish stays `deleting` with the reason.
