# Trade-offs cheat sheet

One page to hold every decision, what else you considered, why you chose it and what it costs. Read the "known limitations" list last and out loud: name these yourself before an interviewer does.

## Decisions

| # | Decision | Alternatives considered | Why chosen | Cost accepted | ADR |
| --- | --- | --- | --- | --- | --- |
| 1 | Keep ADRs, experiments and a log from day one | Write the design note at the end | Rejected options and reversals are lost otherwise; interview questions are about "why" | Discipline: every decision costs a file | [0001](../adr/0001-documentation-records.md) |
| 2 | Bun for installs and runtime; Hono on `Bun.serve`; image pinned to `oven/bun:1.4.3-alpine` | pnpm plus Node 22; Bun for installs only | One toolchain; the MCP SDK tests the Bun path; argon2id built in | Node-only libraries need checking; manual tracing; Bun 1.2.19 crashed under load, so the version is a decision (update note in the ADR) | [0002](../adr/0002-bun-runtime-and-workspaces.md) |
| 3 | Stateless Streamable HTTP, one JSON object per POST; `{slug}__{tool}` names | Stateful sessions with sticky routing; a `server` argument on every tool; flat names | Any replica answers any request; works with any client; names stable | No server-initiated messages; names longer | [0003](../adr/0003-stateless-mcp-and-tool-names.md) |
| 4 | Official WordPress and MariaDB images, own templates, WP-CLI bootstrap Job; MCP calls `wc/v3` REST | Bitnami chart; WP-CLI via exec from the MCP server | Bitnami's public catalog changed; REST is the documented API; no exec RBAC | Official images start as root; one writer per volume | [0004](../adr/0004-woocommerce-on-official-images.md) |
| 5 | One chart, two values files; k3d locally, k3s on a VPS; ingress-nginx on both | kind; Traefik; separate charts per environment | `local-path` StorageClass on both; same `ingressClassName`; differences are values only | Traefik must be disabled; stayed on Ingress, not Gateway API; Helm 3 on the VPS needed namespace ownership labels that Helm 4 locally did not | [0005](../adr/0005-one-helm-chart-two-value-files.md) |
| 6 | Hashed API keys, AES-GCM upstream secrets, no token passthrough, chat calls the same router | Forward the caller's token; plaintext upstream secrets | Standard split of caller auth and upstream auth; SQL dump alone cannot call upstreams | Upstream sees one identity; one key at a time, rotated with `CREDENTIAL_KEY_PREVIOUS` and `rekey.ts`, no key id | [0006](../adr/0006-gateway-auth-and-credentials.md) |
| 7 | Two replicas, shared rate limit and probe lease, Prometheus, Grafana, Tempo from day one | One replica, logs only, metrics later | A second replica is only correct with shared state; metrics show it | Heavier laptop footprint; one HTTP POST per span, no sampling; the first in-memory rate-limit shortcut was wrong and was removed | [0007](../adr/0007-scale-and-observe-from-the-first-deploy.md) |
| 8 | Install project skills for both Cursor and Claude Code; write a repo skill with boundaries | Generic skills only | Agents follow the same stack rules (no built-in WooCommerce MCP, ingress-nginx, Bun) | Skill copies in the repo | [0008](../adr/0008-dev-tooling-and-skills.md) |
| 9 | Ordered migrations in code, advisory lock, one `throttle` table, schema-diff test | `create table if not exists` forever; drizzle-kit | Replicas can start together; drift is caught by a test; one token-bucket SQL | No down migrations; rollback relies on additive changes | [0009](../adr/0009-versioned-migrations-and-shared-throttle.md) |
| 10 | Tool grants: most specific rule wins; members read-only by default using `readOnlyHint` | Hard-coded admin-only tool names; a policy language (Cedar, OPA) | Default needs no configuration; rules are readable; enforced on call, not just list | Unannotated third-party tools hidden from members; annotations are trusted | [0010](../adr/0010-tool-permissions.md) |
| 11 | SSRF: validate URL and every address, pin http connections, refuse redirects, deny private egress by NetworkPolicy | Name deny list only; check then connect separately | Closes the DNS-rebinding window for http; the network layer holds when pinning cannot (https) | https relies on the network policy; needs a policy-enforcing CNI | [0011](../adr/0011-ssrf-resolve-and-pin.md) |
| 12 | OAuth 2.1 built into the gateway: PKCE S256, audience-bound opaque tokens, DCR and Client ID Metadata Documents, refresh rotation | External IdP (Keycloak, Auth0); API keys only | Dashboard already authenticates; revocation is a row update; spec-aligned | One scope; no remembered consent; DB read per request; DCR is deprecated in the newest draft | [0012](../adr/0012-oauth-authorization-server.md) |
| 13 | Separate provisioner driving Helm from a Postgres state machine | Provision inside the gateway; an operator with a CRD | Gateway holds no cluster rights; durable, resumable, testable with fake ports | Stores not visible as Kubernetes objects; `failed` is final until retried | [0013](../adr/0013-provisioner-reconciler.md) |
| 14 | One store is one release of the `urumi-store` chart; Secrets created first | Loop over stores in the platform chart; render manifests in the provisioner | Reviewed definition of a store; Helm is retry and teardown; passwords stay out of release values | Two sets of store templates can drift | [0014](../adr/0014-store-chart.md) |
| 15 | Provisioner RBAC: narrow ClusterRole, per-namespace RoleBinding it creates, `bind` limited to one role, admission policy | `cluster-admin`; one broad ClusterRole | No cluster-wide Secret access; it cannot grant itself rights in `kube-system` | Can still delete any namespace by RBAC; the code only deletes labelled ones | [0015](../adr/0015-provisioner-rbac-and-admission.md) |
| 16 | Hosted MCP servers in one locked-down namespace, one release each, registry allowlist, secret env straight to a Secret | Run in `platform`; a namespace per server | Quota, default-deny and Pod Security `restricted` apply once; clean delete | No egress at all; runs as uid 1000; no image signature check | [0016](../adr/0016-hosted-mcp-servers.md) |
| 17 | Search surface of three tools, BM25 ranking, one execution path | Truncate the list; embeddings | Few tokens for the model; same permissions, limits and audit; no extra service | Two or three calls per task; synonyms missed | [0017](../adr/0017-tool-search-surface.md) |
| 18 | TLS by cert-manager behind the same chart; HTTP-01 per host, wildcard DNS-01 documented | TLS outside the cluster; wildcard only | Differences stay in values; each store asks for its own certificate | Let's Encrypt rate limits at many stores; default-deny needed an `allow-acme-http01-solver` policy (found on AWS); self-signed proves wiring, not browser trust | [0018](../adr/0018-tls-and-vps-strategy.md) |
| 19 | Audit: one row per call, joined to the user, filtered in SQL, paged by id | Filter in application code after paging; log files | Correct filters and "who" in the UI; cheap keyset paging | Kept forever, no retention job; arguments are not logged | [0019](../adr/0019-audit-log-shape.md) |
| 20 | Alert rules in Prometheus; a classified reason with every failure | Logs only; Alertmanager from the start | Admin sees why an upstream is down without reading logs | No Alertmanager: alerts page nobody; regex classification | [0020](../adr/0020-alerts-and-failure-reasons.md) |
| 21 | Upgrade with `helm upgrade`, roll back with `helm rollback`, additive migrations | Blue-green with a second release | Simple and recorded in revision history | Rollback does not undo data; plugin upgrades are forward-only | [0021](../adr/0021-upgrade-and-rollback.md) |
| 22 | Per-replica admission control (24 in flight, `overloaded` beyond); batched span export; no `replicas` on Deployments that have an HPA | Raise limits and probe timeouts only; a queue in front of the router; keep `replicas` in the chart | Keeps a busy pod alive instead of restarting it; fast error the client can act on; avoids the Helm 4 server-side apply conflict with the autoscaler | Fixed ceiling per replica; a few percent of calls shed at 40 callers; first install starts at one replica; one laptop node cannot show throughput scaling | [0022](../adr/0022-admission-control-and-autoscaler-ownership.md) |

If an ADR above has an outcome line you plan to quote, open it first: it names what was run and what was not.

## The live deployment (AWS)

- **URL pattern.** With the Elastic IP written with dashes as `<a-b-c-d>`: dashboard `https://dashboard.<a-b-c-d>.sslip.io`, storefront `https://shop.<a-b-c-d>.sslip.io`, stores `https://<slug>.stores.<a-b-c-d>.sslip.io`. The 2026-10-26 run used `13-207-8-182` (so `https://dashboard.13-207-8-182.sslip.io`). Treat the URLs as dead unless you know the instance is still up.
- **What it is.** EC2 t3.large, Ubuntu 24.04, k3s v1.36.5, `ap-south-1`, a 60 GiB gp3 disk and an Elastic IP; real Let's Encrypt certificates for the dashboard and shop (and a certificate per store); installed with `scripts/vps-bootstrap.sh` and `values-prod.yaml`; images copied into containerd with `docker save | ssh | k3s ctr images import`, no registry.
- **The e2e run on it.** `scripts/e2e.ts` over HTTPS passed 65 of 65 checks: the definition of done with two users, two stores in parallel, a hosted server, killing an upstream pod. The output file ends `ALL PASSED in 175s` ([e2e-vps-aws-2026-10-26.txt](../evidence/e2e-vps-aws-2026-10-26.txt)); the cluster state, certificates and issuer are in [vps-aws-deployment-2026-10-26.txt](../evidence/vps-aws-deployment-2026-10-26.txt).
- **What the real host changed**: cert-manager's solver pod blocked by default-deny (new `allow-acme-http01-solver` policy in both charts), CRLF line endings (`.gitattributes eol=lf`), `unzip` for Bun's installer, Helm 3 not adopting pre-created namespaces (the bootstrap labels and annotates them).
- **Commands and costs.** [docs/vps-deploy.md](../vps-deploy.md) ("The AWS run, step by step"): about 0.083 USD an hour; teardown is terminate, release the Elastic IP, delete the security group and key pair. The brief-to-evidence map is [docs/requirements-coverage.md](../requirements-coverage.md).

## Known limitations and honest gaps

Say these before you are asked. Each is something you can explain and has a fix.

1. **Postgres is a single pod.** If it dies, logins, MCP auth and listing stop. Fix: managed or replicated Postgres.
2. **The store and hosted MCP servers have no authentication of their own.** They trust a NetworkPolicy that admits only `app=gateway` in `platform`. Fix: a per-upstream bearer token (the gateway already supports one).
3. **Annotations are trusted.** A server that claims `readOnlyHint: true` on a write tool lets members call it. An explicit deny overrides it.
4. **https upstreams are not pinned against DNS races.** The egress NetworkPolicy is the backstop, and it needs a CNI that enforces policies.
5. **One encryption key at a time, no key id.** Rotation is manual: set `CREDENTIAL_KEY_PREVIOUS`, deploy, run `rekey.ts` ([docs/runbook-upgrade-rollback.md](../runbook-upgrade-rollback.md)). The old key must stay configured until the re-encrypt has run.
6. **Tracing is minimal.** Trace context is propagated (gateway, MCP adapter, WooCommerce call; proved against Tempo in `docs/evidence/trace-check-2026-10-20.txt`); spans are exported in batches (one request a second), there is no sampling, WordPress emits no spans, only those paths are instrumented, and spans still queued when a pod dies are lost.
7. **Alerts go nowhere.** No Alertmanager.
8. **Kubernetes Secrets are not encrypted at rest** by anything in this repo. Protection is RBAC.
9. **PVC retention is uneven by design.** The platform's WordPress and Postgres PVCs carry `helm.sh/resource-policy: keep` and MariaDB's claim survives through the StatefulSet; Prometheus and Tempo claims are deleted on uninstall. A provisioned store is deleted with its volumes on purpose.
10. **`local-path` volumes are node-local.** Fine on one VPS; not durable across nodes.
11. **Per-process lock around tool-cache refresh.** Two replicas can refresh the same server at once. Wasteful, not wrong.
12. **Audit rows are kept forever**, and arguments are not recorded.
13. **A failed store stays failed until retried.** A failing `helm` step is not automatically retried.
14. **The compare-and-set in the provisioner checks status, not phase.** The heartbeat abort narrows the window for a stale worker; it does not eliminate it.
15. **OAuth is a minimal profile**: one scope, consent every time, no confidential clients, a database read per request.
16. **Two sets of store templates** (platform `store` namespace and `urumi-store`) can drift.
17. **The real run has limits.** It ran on AWS on 2026-10-26 (65 of 65 checks) with `sslip.io` hostnames, which are not a domain you own; images were copied into containerd and not pulled from a registry; it is one node; the chat model is a free-tier open-weight model on Groq, so its answers vary; and the instance may be torn down, so the URLs may be dead. Do not present those as production-grade.
18. **Result size is capped at 1 MB at the gateway** (`MAX_RESULT_BYTES`), a fixed number; a legitimate large result is refused with "result too large".
19. **Recovery takes at least the lease time.** `docs/evidence/recovery-check-2026-10-20.txt` shows a provisioner killed during a Helm install and during a delete, both finishing correctly; the replacement pod resumes only after the dead pod's 60 second lease expires. A shorter lease would resume faster and raise the chance of two workers overlapping on a slow step. The state machine is also covered by `apps/provisioner/src/provisioner.test.ts`.
20. **The admission ceiling is fixed and per replica.** 24 calls in flight per replica (48 to 96 across 2 to 4 replicas); beyond it callers get `overloaded` and must retry. The load test shed 0.54%. A global or adaptive limit is the next step.
21. **One laptop node cannot show throughput scaling.** The load test shows the HPA scaling 2 to 4 with no restarts and 99.46% success, not throughput growing with replicas.
22. **The MCP client library is a large part of per-call CPU** (15 ms against 5.5 ms for a raw request). A direct JSON-RPC path for stateless upstreams would roughly halve it; it was not done because upstreams that need a session rely on the library.
23. **The Bun 1.2.19 crash was solved by upgrading, not diagnosed.** The root cause inside Bun is unknown to me; the evidence is the crash dumps, the reproduced panic, and clean runs on 1.4.3 (107 of 107 tests twice, then the load run). If a regression appears, the suites, the load test and the end-to-end run are the guards.

Closed since the first draft of these notes (so do not list them as gaps): trace propagation, key rotation, the chat per-call rate limit, PVC keep for WordPress and Postgres, Grafana's restart loop, the result size cap, the in-memory rate-limit shortcut, the recovery check (recorded as passing), and the gateway collapse under load (a Bun 1.2.19 crash, fixed by moving to 1.4.3, [experiment 0006](../experiments/0006-gateway-collapse-under-load.md)).

## Demo day checklist

Do this the evening before and again an hour before. Everything here assumes Windows with Docker Desktop, as used for development.

**Start**

1. Start Docker Desktop and wait for the engine. `docker info` must work.
2. Cluster up: `k3d cluster list` shows `urumi`. If `kubectl` times out, the kubeconfig may point at `host.docker.internal`; fix with `kubectl config set-cluster k3d-urumi --server=https://127.0.0.1:<port>` where the port is from `docker port k3d-urumi-serverlb 6443/tcp`. `scripts/dev-up.sh` does this on every run.
3. Hosts file: `127.0.0.1 shop.local dashboard.local`. New stores use `*.localhost` and need nothing.
4. `kubectl get pods -A` all Running or Completed. Grafana now has a startup probe; if anything still crash-loops, decide whether to show it.
5. LLM key: `kubectl -n platform get secret gateway-llm -o jsonpath='{.data.api-key}' | base64 -d | wc -c` should be non-zero, or the chat will answer 503. Set `LLM_API_KEY`, `LLM_PROVIDER`, `LLM_MODEL` before `scripts/dev-up.sh` or update the Secret and restart the gateway.
6. Admin login: user `ada`, password in `deploy/secrets/generated.env` (`ADMIN_PASSWORD`). Create user B (member) and a key for each user in advance.

**Open before the call**

- If the AWS instance is still up, open its dashboard and a store URL in separate tabs (pattern above) so you can show real certificates. Otherwise say it was torn down and open `docs/evidence/vps-aws-deployment-2026-10-26.txt`.
- Browser tabs: `http://shop.local`, WooCommerce admin at `http://shop.local/wp-admin` (user `admin`, password `WP_ADMIN_PASSWORD` in the same env file), `http://dashboard.local` as user A, a private window as user B.
- MCP Inspector (`npx @modelcontextprotocol/inspector`) pointed at `http://dashboard.local/mcp` with user B's key.
- A terminal in the repo with these ready: `kubectl get pods,svc,ingress,pvc,networkpolicy -A`, `kubectl get ns`, `helm history urumi -n platform`, `kubectl -n platform get deploy`.
- This repo's docs open: [02-walkthrough.md](02-walkthrough.md) (the three traces), the 2026-10-20 entry of [docs/log.md](../log.md) and `docs/experiments/` (your "what broke" stories, [03](03-interview-questions.md) section 16), and `docs/evidence/`.

**The flow, in order** (the brief's definition of done)

1. Storefront: add a product to the cart, check out with cash on delivery, show the order in WooCommerce admin.
2. As user A in chat: "create a product named X priced 15"; open the storefront and show it. Place an order by hand; ask "what orders came in today?".
3. As user B in Inspector: list tools (note `create_product` is hidden for a member), ask the same orders question, run one prompt that needs two upstreams (orders plus the time or policy tool).
4. Revoke user B's key in the dashboard; the next call returns 401.
5. Disable one upstream; its tools disappear in chat and in Inspector.
6. Take an upstream down and show Unreachable with the reason while the others work: `kubectl -n platform scale deploy/policy-mcp --replicas=0`, wait for the next probe (up to 15 s) or press Probe, then restore with `--replicas=2`. Deleting the pods instead is faster to type but the Deployment replaces them within seconds, so the dead window is short.
7. Audit page: every call, attributed to the right user, with duration.
8. Bonus: create two stores from the Stores page, ask chat to compare today's orders, delete one, show its tools gone (`tools/list`), `kubectl get ns` and `kubectl get pv`.
9. Security: show `kubectl auth can-i create secrets -n kube-system --as system:serviceaccount:platform:provisioner` (should be no), a blocked probe pod between stores, and an SSRF attempt (add a server with `http://169.254.169.254/`) rejected in the dashboard.

Before recording or sitting the call, run `helm test urumi -n platform` and `bun scripts/e2e.ts` (add `STORES=1` for the two-store test and `HOSTED=1` for a hosted server). They print PASS or FAIL per line and give you the baseline; the 2026-10-20 outputs are in `docs/evidence/`. The step-by-step script is [docs/demo-script.md](../demo-script.md).

**If something fails**

| Symptom | First check | Fallback |
| --- | --- | --- |
| `kubectl` hangs | Docker engine, then the kubeconfig server address (above) | Re-run `bash scripts/dev-up.sh` with `SKIP_BUILD=1` |
| Dashboard 404 or blank | `kubectl -n platform get pods`; dashboard and gateway Ready | `kubectl -n platform rollout restart deploy/dashboard deploy/gateway` |
| Chat returns 503 | LLM key empty | Show Inspector instead and say chat needs a key |
| Chat loops or errors | Model quality or quota | Show the tool trace and the audit rows; the brief grades the loop |
| A store stays `provisioning` | Stores page reason; `kubectl -n store-<slug> get pods`; provisioner logs | Delete it from the page and create another; explain the timeout and retry |
| Store tools missing in chat | Server list shows the store as Unreachable? gateway egress policy for `store-*`? | Probe the server from the dashboard; read the reason text |
| Order not visible | The bootstrap Job completed? WooCommerce admin shows it? | Place another order with cash on delivery |
| Port 80 busy | Another process or Traefik | Stop it; k3d needs 80 |
| `*.localhost` does not resolve | Browser vs curl differences | Add a hosts line for that store |

**Disk space.** If Docker or WSL crashes, core dumps can fill the disk (`%LOCALAPPDATA%\Temp\wsl-crashes`; about 18 GB accumulated during the Bun crash). Check free space before the demo and delete old dumps.

**Evidence you can open on the call:** `docs/evidence/` (e2e, hosted e2e, OAuth, security, trace, recovery, load, rollback, TLS, UI), [docs/security-test-log.md](../security-test-log.md), [docs/vps-deploy.md](../vps-deploy.md), [docs/runbook-upgrade-rollback.md](../runbook-upgrade-rollback.md), [docs/demo-script.md](../demo-script.md).

**Do not claim** anything you did not see: an OAuth login with a specific named client, or numbers other than those in `docs/evidence/`, unless you ran it.
