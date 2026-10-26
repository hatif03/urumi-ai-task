# Urumi

A WooCommerce hosting platform with a team MCP gateway on Kubernetes. An admin connects MCP servers once; every team member then uses all of them through one MCP endpoint and through a chat agent in the dashboard. One Helm chart runs locally on k3d and, with `values-prod.yaml`, on a k3s VPS.

```
 browser ──► dashboard ─┐                                        ┌──► WooCommerce MCP ──► WordPress + MariaDB   (store)
 MCP client ─ /mcp ─────┼──► gateway (MCP server + MCP client) ──┼──► utility MCP, policy MCP
 chat agent (in gateway)┘            │                           ├──► per-store MCP ──► its own WordPress + MariaDB   (bonus)
                                     │ internal API              └──► hosted MCP image                               (stand-out)
                                  provisioner ──► Helm, Kubernetes API (namespace per store)
```

## Live deployment

The system is running on a k3s server on AWS (EC2 in `ap-south-1`) behind real Let's Encrypt certificates. Try it:

| What | Where |
| --- | --- |
| Dashboard (servers, stores, chat, keys, audit) | https://dashboard.13-207-8-182.sslip.io |
| Storefront (WooCommerce) | https://shop.13-207-8-182.sslip.io |
| Gateway MCP endpoint (for Claude Code, Cursor, Inspector) | https://dashboard.13-207-8-182.sslip.io/mcp |
| Stores you create in the dashboard | `https://<slug>.stores.13-207-8-182.sslip.io` |

| Account | Role | Username | Password |
| --- | --- | --- | --- |
| Reviewer | admin: manage servers, members, permissions, stores, hosted servers; sees the audit log | `reviewer` | `S2FGnPOMGyOGy9ouQy` |
| Teammate | member: uses the tools its role allows, own API keys, chat | `teammate` | `wEJYd4MQpSPIbgdMhm` |

What to try: sign in as `teammate`, open **API keys**, create a key, then connect an MCP client with only the URL and that key (`claude mcp add --transport http urumi https://dashboard.13-207-8-182.sslip.io/mcp --header "Authorization: Bearer umk_..."`); open **Chat** and ask for today's orders; place an order on the storefront (guest checkout, cash on delivery). As `reviewer`, open **Servers**, **Stores**, **Permissions** and **Audit** to see the same calls attributed to each user. The WordPress admin of the demo store is not published here; the order list is visible through the chat and the MCP tools, and the credential is available on request.

These two accounts exist for the review only. The server is a small single node that may be switched off after the review (the cost is about 2 USD a day), and the accounts and the `sslip.io` names go with it. The repository is public, so treat these passwords as public and disposable.

![Architecture](docs/architecture.svg)

**Status:** everything in the brief is built and was run end to end on a real k3s server on AWS behind Let's Encrypt certificates (65 of 65 checks, [evidence](docs/evidence/e2e-vps-aws-2026-10-26.txt)). [requirements-coverage.md](docs/requirements-coverage.md) maps each line of the brief to the code and the evidence. Demo: [docs/demo-narration.md](docs/demo-narration.md) is the script of the video; [docs/demo/urumi-demo.mp4](docs/demo/urumi-demo.mp4) is the video itself (about 20 minutes, 43 MB, synthetic narrator voice) (how it was made: [Demo video](#demo-video)).

Read next: [requirements coverage](docs/requirements-coverage.md) · [system design and tradeoffs](docs/system-design.md) · [threat model](docs/threat-model.md) · [MCP internals](docs/mcp-internals.md) · [data model](docs/data-model.md) · [API](docs/api.md) · [decisions (ADRs)](docs/adr/README.md) · [VPS deploy](docs/vps-deploy.md) · [upgrade and rollback](docs/runbook-upgrade-rollback.md) · [demo script](docs/demo-script.md) · [security test log](docs/security-test-log.md).

## What is where

| Brief item | Where |
| --- | --- |
| Store on Kubernetes (WordPress, WooCommerce, MariaDB, persistent volumes, Ingress, probes, limits, Secrets) | `deploy/helm/urumi/templates/{mariadb,wordpress,bootstrap,ingress}.yaml`, `files/` |
| WooCommerce MCP server (list/create products, list/get orders, update order status) | `apps/woocommerce-mcp` |
| Gateway: registry, aggregation, routing, name collisions, timeouts, credentials, roles, keys, audit | `apps/gateway/src` (`router.ts`, `mcp.ts`, `routes/`, `policy.ts`, `crypto.ts`) |
| Dashboard | `apps/dashboard` ([design note](docs/dashboard.md)) |
| Chat agent | `apps/gateway/src/chat.ts` (Vercel AI SDK; any provider; the live deployment uses `openai/gpt-oss-120b` on Groq) |
| Helm charts and values | `deploy/helm/urumi` (+ `values-local.yaml`, `values-prod.yaml`), `deploy/helm/urumi-store`, `deploy/helm/urumi-hosted-mcp` |
| Three upstream servers | WooCommerce, `apps/utility-mcp`, `apps/policy-mcp` |
| **Bonus: multi-store provisioning** | `apps/provisioner`, `deploy/helm/urumi-store` ([ADR 0013](docs/adr/0013-provisioner-reconciler.md), [0014](docs/adr/0014-store-chart.md), [0015](docs/adr/0015-provisioner-rbac-and-admission.md)) |
| **Stand-out: production-like VPS, TLS with cert-manager** | `scripts/vps-bootstrap.sh`, `values-prod.yaml`, `templates/cert-manager.yaml`, [docs/vps-deploy.md](docs/vps-deploy.md) |
| **Stand-out: tool permissions** | `apps/gateway/src/policy.ts`, `routes/admin.ts`, dashboard Permissions page ([ADR 0010](docs/adr/0010-tool-permissions.md)) |
| **Stand-out: OAuth on the gateway** | `apps/gateway/src/oauth.ts` ([ADR 0012](docs/adr/0012-oauth-authorization-server.md)) |
| **Stand-out: handling many tools** | `apps/gateway/src/search.ts`, `mcp.ts` (`/mcp?surface=search`), chat switch ([ADR 0017](docs/adr/0017-tool-search-surface.md)) |
| **Stand-out: hosted MCP servers** | `apps/provisioner/src/hosted.ts`, `deploy/helm/urumi-hosted-mcp` ([ADR 0016](docs/adr/0016-hosted-mcp-servers.md)) |
| **Stand-out: security hardening** | SSRF `apps/gateway/src/ssrf.ts` ([ADR 0011](docs/adr/0011-ssrf-resolve-and-pin.md)), NetworkPolicies, RBAC and admission policy, non-root containers, encrypted credentials with rotation (`rekey.ts`) |
| **Stand-out: scaling** | two replicas, shared Postgres rate limits, HPA, PDB, a per-replica in-flight ceiling ([ADR 0007](docs/adr/0007-scale-and-observe-from-the-first-deploy.md), [0022](docs/adr/0022-admission-control-and-autoscaler-ownership.md)); `scripts/loadtest.ts` |
| **Stand-out: observability** | metrics, traces, alerts, failure reasons ([ADR 0020](docs/adr/0020-alerts-and-failure-reasons.md)) |
| **Stand-out: upgrades and rollback** | `helm test`, `--atomic`, [runbook](docs/runbook-upgrade-rollback.md) ([ADR 0021](docs/adr/0021-upgrade-and-rollback.md)) |

**How the WooCommerce MCP server talks to the store, and why.** Over WooCommerce's REST API (`/wp-json/wc/v3/products` and `/orders`) with HTTP Basic auth from a read/write consumer key held in a Kubernetes Secret and the MCP pod's environment, from inside the cluster over HTTP to the `wordpress` Service. REST is the integration WooCommerce documents and supports across versions, it needs no extra rights in the cluster, and it keeps each tool call an ordinary request with a deadline. The alternatives were WP-CLI inside the WordPress pod (needs `exec` rights and ties every call to a shell) and WooCommerce's own MCP plugin (the brief says to write the server ourselves). Details and the WooCommerce 11 basic-auth quirk are in [ADR 0004](docs/adr/0004-woocommerce-on-official-images.md).

Interview study material: [`docs/study/`](docs/study/00-start-here.md).

## Local setup

Needs Docker (running), kubectl, Helm 3.14+ or 4, k3d 5.x and Bun (the images use 1.4.3; use the same on the host: `npm i -g bun@1.4.3`). On Windows use Git Bash for the scripts. Open a new terminal if Helm or k3d were just installed.

Add two names to the hosts file (`C:\Windows\System32\drivers\etc\hosts` on Windows, `/etc/hosts` elsewhere):

```text
127.0.0.1 shop.local dashboard.local
```

New stores are served at `<slug>.shop.localhost`; browsers and curl resolve `*.localhost` to loopback by themselves, so there is nothing to add per store. (Windows' system resolver does not; use a browser, or `curl --resolve`, or `scripts/e2e.ts`, which sends a Host header.)

```sh
bash scripts/dev-up.sh
```

It creates the k3d cluster (Traefik off), installs ingress-nginx, generates every password and key into `deploy/secrets/generated.env` (gitignored, mode 600) and creates the Kubernetes Secrets from it, builds the six images and imports them, installs the chart with `values-local.yaml`, and restarts pods that use a rebuilt `:local` image. The first run takes 10 to 15 minutes (image builds, WordPress install). It is safe to rerun. `ONLY=gateway,dashboard bash scripts/dev-up.sh` rebuilds just those; `SKIP_BUILD=1` only upgrades the chart.

Then:
- Storefront: <http://shop.local>
- Dashboard: <http://dashboard.local>, user `ada`, password `ADMIN_PASSWORD` in `deploy/secrets/generated.env`
- `helm test urumi -n platform` runs the smoke test; `bun scripts/e2e.ts` runs the definition of done.

To enable the chat agent set an LLM key before `dev-up.sh` (or edit the `gateway-llm` Secret and restart the gateway): `LLM_PROVIDER` (`openai`, `google`, `anthropic`), `LLM_MODEL`, `LLM_API_KEY`, and optionally `LLM_BASE_URL` for any OpenAI-compatible endpoint (Groq, OpenRouter, Ollama). Without a key the chat page says so and everything else keeps working.

Free-tier examples (check the provider's current model names): Google Gemini `LLM_PROVIDER=google LLM_MODEL=gemini-2.0-flash LLM_API_KEY=...`; Groq `LLM_PROVIDER=openai LLM_BASE_URL=https://api.groq.com/openai/v1 LLM_MODEL=openai/gpt-oss-120b LLM_API_KEY=...` (what the live deployment runs; `llama-3.3-70b-versatile` was not available to the key used, so check `GET /openai/v1/models` for yours). The key lives in the `gateway-llm` Secret, never in the repository or the chart. The gateway's NetworkPolicy allows public internet egress on 80 and 443 (and nothing private), so a hosted LLM API is reachable; a model on your own machine (Ollama) is a private address and would need an explicit egress rule.

## Place an order

On <http://shop.local> add the sample mug (or a product the agent created) to the cart, check out as a guest and choose **Cash on delivery**. The order appears in WooCommerce admin at <http://shop.local/wp-admin> (user `admin`, password `WP_ADMIN_PASSWORD` in the env file) under WooCommerce, Orders, and is stored in MariaDB on a persistent volume: delete the WordPress pod and it is still there.

## Connect an external MCP client

In the dashboard open **API keys**, create a key, copy the `umk_...` token (shown once). The only things the client needs are the URL and the key:

```json
{
  "mcpServers": {
    "urumi": {
      "url": "http://dashboard.local/mcp",
      "headers": { "Authorization": "Bearer umk_..." }
    }
  }
}
```

Claude Code: `claude mcp add --transport http urumi http://dashboard.local/mcp --header "Authorization: Bearer umk_..."`. MCP Inspector: `npx @modelcontextprotocol/inspector`, transport Streamable HTTP, that URL and header.

Tool names are `{server}__{tool}`: `woocommerce__list_orders`, `utility__get_current_time`, `policy__get_return_policy`, `store_alpha__list_orders`. Members see read-only tools by default; an admin can allow more on the **Permissions** page. A revoked key gets 401 on its next call.

**Browser login instead of a key (OAuth).** A client that supports the MCP authorization flow can be pointed at `http://dashboard.local/mcp` with no header: it receives a 401 with `resource_metadata`, discovers the authorization server, registers itself, sends you to a consent page after you sign in to the dashboard, and receives a token bound to this gateway. Connected apps are listed and revocable under **API keys**. `bun scripts/oauth-demo.ts` runs the whole flow from a script with PKCE.

**Hundreds of tools.** `http://dashboard.local/mcp?surface=search` exposes three tools (`search_tools`, `describe_tool`, `call_tool`) instead of the full catalog. The chat agent switches to them on its own above 20 tools.

## Use the chat agent

Dashboard, **Chat**. Ask "create a product called Test Mug at 14.50", then place an order on the storefront by hand, then ask "what orders came in today?". Each answer lists the tools it called (server, tool, arguments, result). The agent acts as you: its calls are in the audit log under your name with actor `chat`, and it only receives the tools you are allowed to call.

## Stores (bonus)

Dashboard, **Stores**, enter a name. The platform creates namespace `store-<slug>` with its own MariaDB, WordPress, Secrets, volumes, Ingress host `<slug>.shop.localhost`, ResourceQuota, LimitRange and NetworkPolicies, then registers `store_<slug>` in the gateway. Status goes Provisioning, Ready or Failed (with a reason). Up to 3 stores per user, 10 minutes each, several in parallel; retry after a failure is safe. Deleting a store removes its tools from the gateway first, then the release, the namespace and its volumes. Try: create two stores, place an order in each, ask the chat agent "compare today's orders in alpha and beta", delete one and watch its tools disappear (`bun scripts/e2e.ts` with `STORES=1` does this and checks the namespace and volumes are gone). Isolation between stores: `STORE_A=alpha STORE_B=beta bun scripts/security-check.ts`.

## Hosted MCP servers (stand-out)

Dashboard, **Hosted** (admin): give a slug, an image from an allowed registry with an explicit tag, a size and environment variables (secret ones go into a Kubernetes Secret, write-only). It runs in `mcp-hosted` with a restricted Pod Security profile, a NetworkPolicy that admits only the gateway, and DNS-only egress, and is registered automatically. Locally, images imported into k3d work (`urumi-utility-mcp:local`).

## Production (k3s VPS)

**Done and verified.** The same chart ran on an AWS EC2 instance (t3.large, Ubuntu 24.04, k3s) on 2026-10-26: dashboard at `https://dashboard.<ip-with-dashes>.sslip.io`, storefront at `https://shop.<...>`, stores at `https://<slug>.stores.<...>`, all with real Let's Encrypt certificates from cert-manager. The names are `sslip.io` hostnames that resolve to the instance's Elastic IP, which needs no DNS records; a domain you own is a values change only. The whole definition of done, the multi-store bonus and a hosted server passed there (65 of 65 checks, including killing an upstream pod): [e2e output](docs/evidence/e2e-vps-aws-2026-10-26.txt), [cluster state](docs/evidence/vps-aws-deployment-2026-10-26.txt).

[docs/vps-deploy.md](docs/vps-deploy.md) is the guide, with the exact AWS CLI steps and the four defects the real run exposed and fixed. Short form: DNS (or `sslip.io`) for `dashboard.<domain>`, `shop.<domain>` and `*.stores.<domain>`, get the six images onto the node (a registry with a version tag, or `docker save | ssh ... k3s ctr images import -` as the AWS run did), then on the VPS `DOMAIN=... EMAIL=... REGISTRY=... TAG=... bash scripts/vps-bootstrap.sh`. It installs k3s (Traefik disabled), ingress-nginx and cert-manager, generates the Secrets, installs the same chart with `values-prod.yaml`, and runs `helm test`. What differs from local is a table of values in that guide. Upgrade and rollback: [runbook](docs/runbook-upgrade-rollback.md). To prove a deployment from your laptop: `ENTRY=https://dashboard.$DOMAIN DASHBOARD_HOST=dashboard.$DOMAIN SHOP_HOST=shop.$DOMAIN STORE_HOST_SUFFIX=stores.$DOMAIN HOSTED_IMAGE=<image> ADMIN_PASSWORD=... STORES=1 HOSTED=1 SKIP_KUBECTL=1 bun scripts/e2e.ts`.

## Demo video

The video shows the live AWS deployment: system design, the definition of done with two users (an admin and a member), Kubernetes, MCP internals, security, the chat agent, and local-to-VPS with an upgrade that fails and rolls back. It is generated, not edited by hand: `scripts/demo/record.ts` drives a real browser and a terminal against the live system and records each scene; `scripts/demo/assemble.ts` joins the scenes, speaks the narration with a synthetic text-to-speech voice and writes [docs/demo-narration.md](docs/demo-narration.md), the narration script with timestamps. It needs Edge or Chrome, ffmpeg, `pip install edge-tts`, `npm i -g @modelcontextprotocol/inspector`, ssh access to the server and `ADMIN_PASSWORD`. The architecture diagram is [docs/architecture.svg](docs/architecture.svg). Terminal output in the video is real: each command is run on the server (or on the laptop, for the external client) and its output printed, with the typing animated.

## Checks

```sh
bun test --timeout 30000                                                       # unit and in-process integration
TEST_DATABASE_URL=postgres://urumi:test@127.0.0.1:55432/urumi bun test         # + Postgres store and provisioner tests
helm lint deploy/helm/urumi -f deploy/helm/urumi/values-prod.yaml              # chart
helm test urumi -n platform                                                    # smoke test on the running release
bun scripts/e2e.ts                                                             # the definition of done, two users, against the cluster
STORES=1 bun scripts/e2e.ts                                                    # + multi-store bonus
bun scripts/security-check.ts                                                  # SSRF, NetworkPolicy, RBAC, secrets at rest
bun scripts/demo/record.ts && bun scripts/demo/assemble.ts                     # record and voice the demo video against the live system
```
A throwaway Postgres for the database tests: `docker run -d --name urumi-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_USER=urumi -e POSTGRES_DB=urumi -p 55432:5432 postgres:16-alpine`.

## Operating notes

- Deleting the Helm release keeps the core store's and the platform database's volumes (`helm.sh/resource-policy: keep`); a provisioned store is deleted with its volumes on purpose. Snapshot before a WooCommerce plugin upgrade; plugin database migrations are forward-only ([runbook](docs/runbook-upgrade-rollback.md)).
- Rotating the key that encrypts upstream credentials is a documented procedure with a re-encryption command, not a redeploy.
- Alert rules exist in Prometheus; nothing pages anyone until you add an Alertmanager receiver.
- Everything decided and everything that went wrong is in `docs/adr/`, `docs/experiments/` and `docs/log.md`.
