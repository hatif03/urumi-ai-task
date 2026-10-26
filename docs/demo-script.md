# Demo script

The submission video is generated against the live AWS deployment (`scripts/demo/record.ts`; its narration is [demo-narration.md](demo-narration.md)). This file is the manual version, for a live walkthrough against the local cluster.

For the submission video and for the live walkthrough. It follows the brief's "Demo video requirements" in order, and the definition of done with **two users** inside it. Total about 15 minutes; the cut-down version is the lines marked **(short)**. Commands assume the local cluster from `bash scripts/dev-up.sh` and two terminals plus a browser.

Users: **A** = `ada` (admin). **B** = `bea` (member, created in step 2). Have `deploy/secrets/generated.env` open for passwords.

## 0. Before recording

```sh
kubectl get pods -A                     # everything Running (grafana last to settle)
helm test urumi -n platform             # Succeeded
bun scripts/e2e.ts                      # all PASS: the same flow, scripted; keep the output as backup
```
Hosts file has `127.0.0.1 shop.local dashboard.local`. Set `LLM_API_KEY` if you want live chat (otherwise show the 503 and the scripted tool loop in `chat.test.ts`). Clear the audit view filters. Close the browser tabs you do not need.

## 1. System design and implementation (2 min)

Show `README.md` (the diagram and the "what is where" table). Say: four layers; the gateway is the only public MCP endpoint; the chat agent and external clients both go through it; nothing talks to an upstream directly. Open `docs/system-design.md` (the flowchart). Show the repo tree: `apps/gateway`, `apps/woocommerce-mcp`, `apps/provisioner`, `deploy/helm/*`.

## 2. Kubernetes: what runs where (3 min) **(short: 1 min)**

```sh
kubectl get ns --show-labels | grep -E "platform|store|mcp-hosted"
kubectl get pods,svc,ingress,pvc -n platform
kubectl get pods,svc,pvc -n store
kubectl get ingress -A                       # only dashboard host and shop host (and store hosts): no MCP server is public
kubectl get networkpolicy -A | head -30
kubectl -n platform get secret               # Secrets by name: nothing in the source
kubectl -n platform describe deploy gateway | grep -A6 -E "Limits|Requests|Liveness|Readiness|Startup"
```
Say: namespaces `platform` (gateway, dashboard, provisioner, Postgres, extra MCP servers, observability), `store` (WordPress, MariaDB, the WooCommerce MCP server), `mcp-hosted`. PVCs: MariaDB, WordPress, Postgres. Probes and requests/limits on every workload. Public: only the Ingress hosts; MCP servers are ClusterIP, and a NetworkPolicy lets only the gateway reach them. Prove it:
```sh
bun scripts/security-check.ts | head -20     # unlabelled pod BLOCKED, gateway pod OPEN, metadata address BLOCKED
```

## 3. Definition of done, store (2 min)

1. Browser: <http://shop.local>, add a product, cash on delivery, place the order.
2. <http://shop.local/wp-admin> (admin / `WP_ADMIN_PASSWORD`), WooCommerce, Orders: the order is there.
3. `kubectl -n store delete pod -l app=wordpress` and refresh: the order survives (persistent volume).

## 4. Definition of done, chat as user A (2 min)

Dashboard `http://dashboard.local`, sign in as `ada`.
1. **Servers**: three upstreams Connected, WooCommerce first, with their tools.
2. **Chat**: "Create a product called Demo Mug at 14.50". The tool trace shows `woocommerce__create_product`. Open <http://shop.local> and show the product.
3. Place an order for it by hand on the storefront.
4. **Chat**: "What orders came in today?" The agent calls `woocommerce__list_orders` and returns that order (it knows today's date from its prompt and the store's time zone from the tool description).
5. Say how the agent acts as A: it runs in the gateway process with A's id, and `Audit` shows the rows with actor `chat`.

## 5. Definition of done, external client as user B (3 min)

1. **Members** (as A): create `bea`, role member. Sign in as `bea` in a private window. **API keys**: create a key, copy it.
2. Connect MCP Inspector (`npx @modelcontextprotocol/inspector`, Streamable HTTP, `http://dashboard.local/mcp`, header `Authorization: Bearer umk_...`) or Claude Code: `claude mcp add --transport http urumi http://dashboard.local/mcp --header "Authorization: Bearer umk_..."`. Only URL and key. List tools: every enabled server's tools, prefixed. Note `create_product` is **absent** for B (permissions).
3. Ask the orders question: call `woocommerce__list_orders` (or ask Claude Code) and get the same order.
4. One task that needs two upstreams: "what time is it in UTC and what are today's orders" uses `utility__get_current_time` and `woocommerce__list_orders`.
5. Try `woocommerce__update_order_status` as B directly: `denied`.
6. **(OAuth)** Show `bun scripts/oauth-demo.ts` output, or remove the header in the client and complete the browser login.
7. **(Many tools)** `http://dashboard.local/mcp?surface=search` lists three tools; search "orders placed today", describe, call.

## 6. Team and control (2 min)

1. As A, **API keys**/**Members**: revoke B's key. In the client, B's next call is **401**.
2. **Servers**: disable `utility`. Its tools vanish from Chat and from the external client's list (call `tools/list`). Enable it again.
3. Kill an upstream pod: `kubectl -n platform scale deploy/policy-mcp --replicas=0`. Other servers keep working (call `woocommerce__list_orders`); **Servers** shows `policy` Unreachable with the reason ("connection refused" / "timeout"); `tools/list` is still fast. Restore: `kubectl -n platform scale deploy/policy-mcp --replicas=2`.
4. **Audit**: every call above, attributed to the right user, with server, tool, time, duration and outcome (success, denied, unauthorized).

## 7. MCP internals (2 min)

Open `docs/mcp-internals.md`. Walk one call: Ingress, authenticate, split `slug__tool`, rate limit, permission, warm client, 8 s deadline, WooCommerce REST, audit. Show collisions: two stores both export `list_orders`. Show a timeout: the failure matrix. Show `apps/gateway/src/router.ts` `catalog()` (parallel, 3 s) and `call()`.

## 8. Security posture (2 min)

Open `docs/threat-model.md` and answer the four questions aloud. Show: API keys hashed (`select key_hash from api_keys` is 64 hex), credentials ciphertext (`security-check.ts` output), SSRF rejection (add a server with `http://169.254.169.254/` in the UI: refused), "a malicious admin-added server": SSRF checks, sanitised descriptions, permissions outside the model, NetworkPolicy, hosted servers in a restricted namespace with no egress.

## 9. Bonus: stores (4 min, start provisioning before this section)

Start two creates at the beginning of section 4 so they are ready: **Stores**, create `alpha` and `beta`.
1. **Stores** page: status, phase, URL, created time. Several provisioning at once.
2. `kubectl get ns | grep store-`; `kubectl -n store-alpha get pods,pvc,resourcequota,limitrange,networkpolicy,ingress`.
3. `kubectl -n store-alpha get secret`, and the Helm release: `helm list -A`.
4. Order in each storefront (`http://alpha.shop.localhost`, `http://beta.shop.localhost`).
5. **Chat**: "Compare today's orders in alpha and beta." Tools `store_alpha__list_orders` and `store_beta__list_orders`.
6. Isolation: `STORE_A=alpha STORE_B=beta bun scripts/security-check.ts` (the cross-store probes are BLOCKED).
7. Delete `beta` in the UI: the tools disappear first, then `kubectl get ns store-beta` is gone and `kubectl get pv` has no volume for it.
8. Recovery: create `gamma`, and while it is `provisioning` run `kubectl -n platform delete pod -l app=provisioner`; it completes (or fails with a reason) after the new pod starts.
9. Guardrails: a fourth store for the same user is refused with the limit message.

## 10. Chat agent (1 min)

`apps/gateway/src/chat.ts`: the model gets the permitted catalog (or the three search tools above 20), the loop is the AI SDK `streamText` with `stopWhen: stepCountIs(8)`, each `execute` calls `router.call` with the session user, so audit, permissions and rate limits apply. The dashboard renders the tool trace from the stream.

## 11. Local to VPS (2 min)

Open `docs/vps-deploy.md`: the table of what changes (`values-prod.yaml`: hosts, TLS, images, storage, replicas, secrets). `helm template -f values-prod.yaml | grep -n "tls:\|cluster-issuer"`. Show `scripts/vps-bootstrap.sh`. Show upgrade and rollback: `helm history urumi -n platform`, then `helm rollback` of the deliberately broken gateway image (output in `docs/evidence/`), and `helm test`.

## Things to say honestly

What is not done or not proven: a run on a real VPS with a public domain; alert delivery (no Alertmanager receiver); https upstream DNS pinning (network policy carries it); per-member scoping inside a store; chat history is not stored server-side. The study doc `docs/study/04-tradeoffs-cheatsheet.md` has the full list.
