# Tooling

What is installed for this repo, what we deliberately did not install, and how to call it. Decisions are in [ADR 0008](adr/0008-dev-tooling-and-skills.md).

## CLIs on this machine

| Tool | Role | Status on 2026-10-14 |
| --- | --- | --- |
| Bun 1.4.3 in the images (1.2.19 or newer on the host; the host copy is only for scripts and tests, `npm i -g bun@1.4.3` matches the images) | Package manager and runtime for every service we write | Images pinned to `oven/bun:1.4.3-alpine` after 1.2.19 crashed under load ([experiment 0006](experiments/0006-gateway-collapse-under-load.md)) |
| Node and npm | Only used to run `npx skills` and, later, MCP Inspector. Application code runs on Bun | Already present |
| kubectl 1.33.3 | Inspect the local cluster | Already present |
| Docker | Runs k3d. The client is installed; the Docker Desktop engine was not running during setup | Start Docker Desktop before `k3d cluster create` |
| Helm 4.3.0 | The only deploy tool. Installed with `winget install Helm.Helm` | Installed. Open a new shell so `helm` is on `PATH` |
| k3d 5.9.0 | Local Kubernetes. Installed with `winget install k3d.k3d` | Installed. Same new-shell note as Helm |
| WP-CLI | Store bootstrap | Not installed on the host. PHP is not installed, and the bootstrap runs `wordpress:cli` inside the cluster |
| puppeteer-core 25 | Drives the real dashboard from `scripts/ui-check.ts` through an installed Edge or Chrome (no browser download; set `BROWSER_PATH` to choose) | Root devDependency |
| cert-manager | TLS issuers for the VPS and the local rehearsal | Installed into a cluster with Helm, not on the host (`docs/vps-deploy.md`) |
| Helm 3.18 inside the provisioner image | Runs `helm upgrade --install` for stores and hosted servers | Downloaded and checksum-verified in `apps/provisioner/Dockerfile` |

Host WP-CLI was skipped on purpose. The store bootstrap is a Job using the `wordpress:cli` image, which matches [ADR 0004](adr/0004-woocommerce-on-official-images.md). Once Docker is running, a one-off check is:

```powershell
docker run --rm wordpress:cli wp --info
```

WooCommerce's own CLI is that same `wp` binary after the plugin is installed (`wp plugin install woocommerce --activate`, `wp option update woocommerce_feature_mcp_integration_enabled`). We use the plugin and option commands in the bootstrap Job. We do not turn on `mcp_integration`.

## MCP servers

The assignment says to write the WooCommerce MCP server and not to install an existing one. WooCommerce's developer preview is a different server: the WordPress MCP Adapter at `/wp-json/mcp/mcp-adapter-default-server`, plus a deprecated `/wp-json/woocommerce/mcp` route. Enabling it is `wp option update woocommerce_feature_mcp_integration_enabled yes`, and remote clients use `@automattic/mcp-wordpress-remote`. That stack is documented in the [WooCommerce MCP guide](https://developer.woocommerce.com/docs/features/mcp/) and the [AI tools page](https://developer.woocommerce.com/docs/getting-started/ai/). It is reference material for tool ideas (list and create products, list orders, update order status). It is not a component of this platform.

MCP Inspector is the client we use to test our gateway:

```powershell
npx --yes @modelcontextprotocol/inspector
```

Point it at `http://dashboard.local/mcp` with the member bearer token once the gateway exists. Do not commit a config that contains that token.

## Docs for agents

WooCommerce publishes the developer docs as one markdown file: [llms-full.txt](https://developer.woocommerce.com/docs/llms-full.txt). Any page also has a markdown twin, for example [the AI page](https://developer.woocommerce.com/docs/getting-started/ai.md). Use those when a REST field or a CLI flag is unclear. They do not include the PHP code reference.

## Skills installed for Cursor and Claude Code

Installed into this repo with `npx skills add ... --agent cursor --agent claude-code --copy`, so both agents read the same files. Copies live under `.agents/skills/` (Cursor) and `.claude/skills/` (Claude Code). `skills-lock.json` pins the sources.

| Skill | Source | Why it is here |
| --- | --- | --- |
| `wp-wpcli-and-ops` | [WordPress/agent-skills](https://github.com/WordPress/agent-skills) | Bootstrap Job: install, rewrite, options, idempotent `wp` commands |
| `wp-rest-api` | WordPress/agent-skills | How WordPress REST routes, schemas, and permissions behave. Our server calls WooCommerce's `wc/v3` routes, which sit on that API |
| `wp-abilities-api` | WordPress/agent-skills | How the official WooCommerce MCP exposes abilities. Read it to compare, not to register abilities inside WordPress |
| `vercel-react-best-practices` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | The dashboard is React |
| `kubernetes-helm` | [terminalskills/skills](https://github.com/terminalskills/skills) | Charts, probes, storage, ingress, autoscaling |
| `bun-hono-integration` | [secondsky/claude-skills](https://github.com/secondsky/claude-skills) | Hono on `Bun.serve`, which is the HTTP choice in [ADR 0002](adr/0002-bun-runtime-and-workspaces.md) |
| `urumi-stack` | this repo | The boundaries above, so a generic skill does not override them |

## Skills we looked at and did not install

- `woocommerce/agent-skills` only ships `abilities-api-implement` and a stale-PR auditor. The first one walks an agent through registering WooCommerce abilities in-process. That is the official MCP this assignment does not allow us to submit.
- `navarroido/Woocommerce-skill` is 56 merchant workflows (refunds, coupons, inventory campaigns). Useful for a store operator, not for building the gateway.
- Node-centric OpenTelemetry skills assume auto-instrumentation. [ADR 0007](adr/0007-scale-and-observe-from-the-first-deploy.md) uses manual spans and an OTLP HTTP exporter because that is the Bun path.
