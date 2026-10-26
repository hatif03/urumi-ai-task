# Start here

This folder is written for you, the candidate, not for the reviewers. After you submit, you sit a live interview where you walk through the system and defend it. These files are how you get ready.

| File | Use it to |
| --- | --- |
| [00-start-here.md](00-start-here.md) | Get the pitch, the 7-day plan and the glossary |
| [01-concepts.md](01-concepts.md) | Learn each idea from zero, then see exactly where this repo uses it |
| [02-walkthrough.md](02-walkthrough.md) | Know the code, file by file, and trace three requests end to end |
| [03-interview-questions.md](03-interview-questions.md) | Practice out loud with model answers |
| [04-tradeoffs-cheatsheet.md](04-tradeoffs-cheatsheet.md) | Hold every decision, its alternative and its cost on one page; demo-day checklist |
| [resources.md](resources.md) | Videos, specs and docs by topic, with a study order |

How to use the set:

1. Read the elevator pitch below until you can say it without looking.
2. Follow the 7-day plan. Each day pairs a concept section, a walkthrough section and a block of questions.
3. Answer the questions out loud before you read the model answer. If you cannot name the file that implements an answer, open the file.
4. Before the interview, read [04-tradeoffs-cheatsheet.md](04-tradeoffs-cheatsheet.md) and the "known limitations" list in it. Naming your own weak spots before the interviewer finds them is worth more than a polished answer.

What is checked and what is not. Every statement about this repo in these files was checked against the code at the time of writing, and cites a path. Statements about what ran on a cluster point to [docs/log.md](../log.md), an ADR "Outcome" line, or a test. If you want to say "I saw X working", find the line that records it first, or run it yourself on demo day. Do not repeat a claim you have not seen.

## The 5-minute elevator pitch

**The problem.** A team wants AI tools to work with a WooCommerce store. Each person should not have to configure each tool server, and nobody should hold the store's credentials.

**What I built.** Four layers on Kubernetes, installed by one Helm chart.

1. **A store**: WordPress and WooCommerce on MariaDB, with persistent disks, behind ingress-nginx.
2. **A WooCommerce MCP server** I wrote. It speaks MCP over HTTP and exposes five tools (list products, create product, list orders, get order, update order status). It calls WooCommerce's REST API with a consumer key that only this pod holds. It has no Ingress, and a NetworkPolicy lets only the gateway reach it.
3. **A gateway and dashboard.** Admins register MCP servers once. The gateway is an MCP client to every upstream and itself an MCP server on one URL. Tool names are prefixed `{server}__{tool}` so two servers can both have `list_orders`. Members authenticate with their own API key, or with OAuth 2.1 and a browser login. Upstream credentials are encrypted in Postgres and never leave the gateway. Every call is written to an audit log with user, server, tool, time, duration and outcome.
4. **A chat agent** in the dashboard. It runs a tool loop inside the gateway process, as the logged-in user, through the same router as `/mcp`, so its calls land in the same audit log under the same name.

**What makes it hold up.** A slow or dead upstream times out on its own and does not slow the others. Two gateway replicas share state through Postgres, so any replica can answer any request. Each replica caps its calls in flight and answers "busy" past the cap instead of queueing, and the autoscaler adds replicas. Tool permissions are enforced on `tools/call` and not only hidden in `tools/list`. Admin-supplied URLs go through an SSRF check, a pinned connection, and a NetworkPolicy that blocks private ranges.

**The bonus.** A provisioner service turns the store into a platform. From the dashboard a user creates a store: a new namespace, its own database, Secrets, volumes, Ingress host, quota and network isolation, installed as a Helm release, registered in the gateway automatically as `store_<name>__*`. Creation is idempotent and resumes after a restart. Delete removes the registration first, then the release, the namespace and the volumes. An admin can also deploy an MCP server from a container image into a locked-down namespace.

**What I would say is weakest.** Postgres is a single pod. The store MCP servers trust the network and not a token. Permissions trust the annotations an upstream declares. Alerts are rules in Prometheus with no Alertmanager behind them. Chat runs on a free-tier open-weight model (`openai/gpt-oss-120b` on Groq), so its answers vary, and the tests use a fake model. What ran on the k3d cluster is recorded in the 2026-10-20 entry of [docs/log.md](../log.md) and in `docs/evidence/` (the end-to-end run with two users and two stores, the OAuth flow, security checks, the trace check, the browser check, the load test, the rollback and TLS rehearsals, the recovery check).

**It also runs for real.** On 2026-10-26 the same charts were deployed on AWS (EC2 t3.large, Ubuntu 24.04, k3s v1.36, `ap-south-1`, an Elastic IP, `sslip.io` hostnames, real Let's Encrypt certificates) with `scripts/vps-bootstrap.sh` and `values-prod.yaml`, and the full `scripts/e2e.ts` passed there: 65 of 65 checks, including two stores in parallel, a hosted server and killing an upstream pod ([docs/evidence/e2e-vps-aws-2026-10-26.txt](../evidence/e2e-vps-aws-2026-10-26.txt), [docs/evidence/vps-aws-deployment-2026-10-26.txt](../evidence/vps-aws-deployment-2026-10-26.txt)). Say the limits yourself: `sslip.io` is not a domain you own, the images were copied to the node and not pulled from a registry, it is one node, and the instance may no longer be running. Four things only the real host exposed are in [03-interview-questions.md](03-interview-questions.md) section 17.

## Read the 2026-10-20 log entry and the experiments

Interviewers like "what broke, and how did you find out". This project has real answers, written down. Before the interview read:

- the **2026-10-20 entry in [docs/log.md](../log.md)**: the audit of the first build, then the list "Found by running it, then fixed";
- **[experiment 0006](../experiments/0006-gateway-collapse-under-load.md) and [ADR 0022](../adr/0022-admission-control-and-autoscaler-ownership.md)**: throughput collapsed at 8% node CPU; the cause was the Bun 1.2.19 runtime crashing inside the pod (the image is now `oven/bun:1.4.3-alpine`). This is the best story in the project; learn it first.
- **[docs/experiments/](../experiments/README.md)**: 0002 (Bun SQL stored a stringified JSON parameter as a JSON string), 0003 (readiness probes timing out under load made the gateway lose the store, and Grafana restarted for six days), 0004 (an in-memory rate-limit shortcut admitted about 20 calls a second whatever the limit), 0005 (a test matcher that hung);
- the evidence files in `docs/evidence/`, so you know exactly what each run proved;
- **[docs/vps-deploy.md](../vps-deploy.md)** ("The AWS run, step by step" and "What the real run changed") and **[docs/requirements-coverage.md](../requirements-coverage.md)**, which maps every line of the brief to where it is met and how it was checked, and lists what is still open.

[03-interview-questions.md](03-interview-questions.md) section 16 turns these into model answers (questions 156 to 167; start with 162). Each story has the same shape: what you saw, how you found the cause, what you changed, what test or check now guards it. Tell them in that order.

## 7-day plan

About 2 to 3 hours a day. Section numbers in "Resources" are the numbered sections of [resources.md](resources.md).

| Day | Learn | Read the code | Practise | Resources |
| --- | --- | --- | --- | --- |
| 1 | MCP, JSON-RPC, Streamable HTTP, stateless vs sessions ([01](01-concepts.md) sections 1-2) | [02](02-walkthrough.md): adapter, WooCommerce MCP, gateway router | Questions: system design, MCP internals | 1, 2 |
| 2 | Auth: API keys, OAuth 2.1, PKCE, resource indicators; token passthrough; tool poisoning, hashing vs encryption (01 sections 3-5 and 12) | gateway `auth.ts`, `oauth.ts`, `mcp.ts`, `crypto.ts` | Questions: security, OAuth | 3, 4, 16 |
| 3 | Kubernetes objects, probes, limits, storage, Ingress, local domains, k3d vs k3s (01 sections 6 and 8) | the three charts: `urumi`, `urumi-store`, `urumi-hosted-mcp` | Questions: Kubernetes, local-to-VPS | 6, 8 |
| 4 | Helm, upgrade and rollback; NetworkPolicy, RBAC, Pod Security, admission policy (01 sections 7 and 9) | `networkpolicy.yaml`, `provisioner.yaml`, `values-*.yaml` | Questions: upgrade and rollback; run `helm template` on both values files | 7, 9 |
| 5 | Reconcile loops, leases, idempotency; namespace-per-tenant (01 sections 9-10) | provisioner: `worker.ts`, `stores.ts`, `hosted.ts`, tests | Questions: provisioning, hosted servers; trace walk-through (c) | 10 |
| 6 | SSRF, token bucket, BM25 (01 sections 11 and 13-14); permissions | `ssrf.ts`, `policy.ts`, `search.ts`, `router.ts` | Questions: permissions, many tools, scaling, observability | 11, 15, 16, 17, 5 |
| 7 | Nothing new. Run the demo script twice ([docs/demo-script.md](../demo-script.md)). | Re-read [04](04-tradeoffs-cheatsheet.md); read the 2026-10-20 log entry and `docs/experiments/` | The "hard follow-ups", "what broke" and "AI usage" questions, out loud | all |

If you only have two days: do days 2 and 5, then read the cheat sheet.

## Demo day checklist

A demo video is being produced. Keep these open and in this order:

1. **[docs/demo-script.md](../demo-script.md)**: the definition-of-done flow, step by step, with the two users and the commands.
2. **[docs/demo-narration.md](../demo-narration.md)**: what to say at each step (the file may appear shortly after this one; if the link is empty, use the script and the walkthrough traces).
3. **[04-tradeoffs-cheatsheet.md](04-tradeoffs-cheatsheet.md)**, section "Demo day checklist": what to start, what to open, the fallbacks table, and the live URL pattern.
4. Before recording: `helm test urumi -n platform` and `bun scripts/e2e.ts` (add `STORES=1` and `HOSTED=1`) so you know the baseline. On the live deployment run the same suite over HTTPS (command in [docs/vps-deploy.md](../vps-deploy.md)).
5. Chat was run for real on 2026-10-26 against `openai/gpt-oss-120b` on Groq (key in the `gateway-llm` Secret): it created a product and answered the orders question, and the video shows it. If your key changes, check the model name in `GET /openai/v1/models` first: the first model tried was not available to the key.
6. Know the four sentences you will say about what is public, what is internal, how that is enforced (ClusterIP plus a default-deny NetworkPolicy), and what a member can never see (upstream URLs and credentials).

## Glossary

- **MCP (Model Context Protocol)**: an open protocol that lets an AI client discover and call tools on a server. Messages are JSON-RPC 2.0.
- **JSON-RPC**: request/response messages shaped `{jsonrpc, id, method, params}`, answered by `{jsonrpc, id, result}` or `{jsonrpc, id, error}`. A message without `id` is a notification and gets no answer.
- **Streamable HTTP**: the MCP transport that uses one HTTP endpoint (here `POST /mcp`). The server answers with one JSON body or an event stream. This repo always answers with one JSON body.
- **Tool**: a named function the server exposes, with a JSON Schema for its arguments. Example: `list_orders`.
- **Upstream**: an MCP server the gateway calls on behalf of users (WooCommerce, utility, policy, a store, a hosted server).
- **Gateway**: the service that is both an MCP client to the upstreams and an MCP server for people and the chat agent. It also holds auth, audit, permissions and the dashboard API.
- **Slug**: the short name of a server, lowercase words joined by single underscores (`woocommerce`, `store_alpha`). Fixed at registration.
- **Prefix**: the slug plus `__` put in front of an upstream tool name to make the public name: `woocommerce__list_orders`.
- **SSRF (server-side request forgery)**: tricking a server into calling an address the attacker could not reach, such as the cloud metadata service or the Kubernetes API.
- **PKCE (Proof Key for Code Exchange)**: an OAuth extension where the client sends a hash of a secret first and the secret itself later, so a stolen authorization code is useless. This gateway accepts only `S256`.
- **Resource indicator (RFC 8707)**: the `resource` parameter that says which server a token is for. The gateway binds the token to `https://<host>/mcp` and rejects it elsewhere.
- **NetworkPolicy**: a Kubernetes object that says which pods may talk to which. With default deny, only listed connections work. Enforced by the cluster's network plugin.
- **RBAC**: Kubernetes role-based access control. A Role or ClusterRole lists verbs on resources; a RoleBinding grants it to a service account or user.
- **Reconcile loop**: code that repeatedly compares wanted state (a database row) with actual state (the cluster) and acts to close the gap.
- **Lease**: a time-limited claim on a row. A worker that dies stops renewing it and another worker takes over when it expires.
- **ResourceQuota**: a cap on the total CPU, memory, pods and volumes in a namespace.
- **LimitRange**: per-container defaults and bounds in a namespace. It gives containers without requests or limits a default, which a quota needs.
- **Ingress**: a Kubernetes object that maps a host and path to a Service. ingress-nginx is the controller that implements it.
- **PV / PVC**: a PersistentVolume is a disk; a PersistentVolumeClaim is a pod's request for one. The StorageClass (`local-path` on k3s and k3d) creates the PV when a claim appears.
- **Probe**: a health check. Startup waits for slow first boot, readiness decides whether a pod gets traffic, liveness decides whether to restart it.
- **HPA**: HorizontalPodAutoscaler. Changes the replica count of a Deployment from a metric such as CPU.
- **PDB**: PodDisruptionBudget. Limits how many pods of a workload voluntary disruptions (drains, upgrades) may take down at once.
- **Helm release**: one installed copy of a chart, with a name, a namespace, values and a numbered revision history you can roll back.
