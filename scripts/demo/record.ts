#!/usr/bin/env bun
// Records the demo video against the live deployment, scene by scene, and writes the narration script.
//   SCENES=1,2 bun scripts/demo/record.ts     record only some scenes (state such as user B's key is kept in docs/demo/out/state.json)
//   bun scripts/demo/record.ts                record everything, then run `bun scripts/demo/assemble.ts`
// Needs: Edge or Chrome, ffmpeg on PATH, ssh access to the VPS, ADMIN_PASSWORD (the platform admin `ada`), npx and claude on PATH.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DASH, DOMAIN, EIP, OUT, SHOP, closeBrowser, local, remote, scene, sleep, type Scene } from "./lib.ts";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
if (!EIP || !ADMIN_PASSWORD) throw new Error("set ADMIN_PASSWORD (and EIP, or ~/.urumi-aws.env)");
const BEA = { user: "maya", password: "Bea-Demo-2026!" };
const only = (process.env.SCENES ?? "").split(",").filter(Boolean);
const want = (n: string) => only.length === 0 || only.includes(n);

const statePath = `${OUT}/state.json`;
const state: Record<string, string> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 1));

const MCP = `https://${DASH}/mcp`;
const inspector = (method: string, extra = "") => `mcp-inspector --cli ${MCP} --transport http --header "Authorization: Bearer $B_KEY" --method ${method}${extra}`;
// A raw JSON-RPC POST, for the cases where the Inspector would refuse before the gateway is asked (hidden tools, dead servers, 401s).
const rpc = (method: string, params: unknown, flags = "-s") => `curl ${flags} -m 25 ${MCP} -H "Authorization: Bearer $B_KEY" -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}'`;
const bEnv = () => ({ B_KEY: state.bKey ?? "" });
const names = (out: string) => out.split("\n").filter((l) => /"name": "[a-z0-9_]+__/.test(l)).map((l) => l.trim()).join("\n");

// ---------- shared UI flows ----------
async function login(s: Scene, user: string, password: string) {
  const cookies = await s.page.cookies(`https://${DASH}`);
  if (cookies.length) await s.page.deleteCookie(...cookies);
  await s.goto(`https://${DASH}/`);
  await s.type('input[name="username"]', user);
  await s.type('input[name="password"]', password);
  await s.click('button[type="submit"]', { pause: 1500 });
  await s.find("nav[aria-label='Main']");
}

async function placeOrder(s: Scene, product?: string, lines?: [string, string, string]): Promise<string> {
  const phase = (n: number, fn: () => Promise<unknown>) => (lines ? s.say(lines[n]!, fn) : fn());
  await phase(0, async () => {
    const shopCookies = await s.page.cookies(`https://${SHOP}`); // be a plain customer, not the WordPress admin of an earlier scene
    if (shopCookies.length) await s.page.deleteCookie(...shopCookies);
    await s.goto(`https://${SHOP}/shop/`);
    const tagged = await s.page.evaluate((match) => {
      const cards = [...document.querySelectorAll("li.wc-block-product, li.product, .wp-block-post")];
      const card = cards.find((c) => !match || (c.textContent ?? "").includes(match));
      const button = card?.querySelector("button");
      button?.setAttribute("data-demo", "add");
      return Boolean(button);
    }, product ?? "");
    if (!tagged) throw new Error(`no add-to-cart button for ${product ?? "any product"}`);
    await s.click("[data-demo=add]", { pause: 2500 });
    await s.click('header a[href$="/checkout/"], a[href$="/checkout/"]', { pause: 2500 });
    await s.find("#email");
  });
  await phase(1, async () => {
    await s.type("#email", "customer@example.com");
    await s.page.select("#shipping-country", "IN");
    await sleep(800);
    await s.type("#shipping-first_name", "Priya");
    await s.type("#shipping-last_name", "Sharma");
    await s.type("#shipping-address_1", "12 MG Road");
    await s.type("#shipping-city", "Bengaluru");
    await s.page.select("#shipping-state", "KA");
    await s.type("#shipping-postcode", "560001");
    await s.type("#shipping-phone", "9876543210");
    await sleep(1200);
  });
  await phase(2, async () => {
    await s.click("#radio-control-wc-payment-method-options-cod", { pause: 800 });
    await s.click("button.wc-block-components-checkout-place-order-button", { pause: 1000 });
    await s.page.waitForFunction(() => location.pathname.includes("order-received"), { timeout: 60000 });
    await sleep(2500);
  });
  return new URL(s.page.url()).pathname.split("/").filter(Boolean).pop() ?? "";
}

async function wpAdminOrders(s: Scene) {
  const password = (await remote("sudo grep -E '^WP_ADMIN_PASSWORD=' /root/urumi-secrets.env | cut -d= -f2-")).trim();
  const cookies = await s.page.cookies(`https://${SHOP}`);
  if (cookies.length) await s.page.deleteCookie(...cookies);
  await s.goto(`https://${SHOP}/wp-login.php`);
  await s.type("#user_login", "admin");
  await s.type("#user_pass", password);
  await s.click("#wp-submit", { pause: 2500 });
  await s.goto(`https://${SHOP}/wp-admin/admin.php?page=wc-orders`);
  await sleep(1500);
}

async function chatAsk(s: Scene, prompt: string) {
  await s.type('textarea[name="message"]', prompt, 38);
  await s.page.keyboard.press("Enter");
  await s.page.waitForFunction(() => document.querySelector('form[aria-label="Send a message"] button[type="submit"]')?.hasAttribute("disabled"), { timeout: 10000 }).catch(() => undefined);
  await s.page.waitForFunction(() => !document.querySelector('form[aria-label="Send a message"] button[type="submit"]')?.hasAttribute("disabled"), { timeout: 120000 });
  await sleep(1500);
}

// ---------- scenes ----------
if (want("01")) await scene("01-overview", "System design", async (s) => {
  await s.goto(`file://${process.cwd().replaceAll("\\", "/")}/docs/architecture.svg`, "load");
  await s.setCaption("1 · System design", "components and responsibilities");
  await s.say("Hi, this is my Round 1 submission: a WooCommerce hosting platform with a team MCP gateway, running on Kubernetes. Everything you will see is the real system, deployed on a k3s server on AWS, reached over real HTTPS with Let's Encrypt certificates.", () => s.moveTo(800, 60));
  await s.say("There are four layers. First, the store: WordPress and WooCommerce with MariaDB, on persistent volumes, in the store namespace. Second, a WooCommerce MCP server that I wrote myself. It exposes products and orders as tools over Streamable HTTP, and it talks to the store through the WooCommerce REST API with a scoped key.", () => s.moveTo(1370, 190));
  await s.say("Third, the gateway and the dashboard. The gateway is an MCP client to every registered server, and it is itself one MCP server that exposes all their tools at a single endpoint. Postgres holds users, hashed API keys, encrypted upstream credentials, permissions and the audit log. The dashboard is a React app for admins and members.", () => s.moveTo(840, 330));
  await s.say("Fourth, the chat agent. It runs inside the gateway and calls tools through the same router that external clients use, acting as the logged-in user. Nothing talks to an upstream server except the gateway.", () => s.moveTo(700, 380));
  await s.say("Besides the core, I built the multi-store bonus: a provisioner creates a complete store in its own namespace with Helm and registers its tools automatically. And these stand-out items: tool permissions, OAuth, tool search for large catalogs, hosted MCP servers, security hardening, scaling, observability, a real VPS with TLS, and upgrade with rollback.", () => s.moveTo(1370, 560));
});

if (want("02")) await scene("02-store", "Store", async (s) => {
  await s.setCaption("2 · Definition of done: the store", "storefront, checkout, order in WooCommerce admin");
  let order = "";
  order = await placeOrder(s, undefined, [
    "First, the store. This is the storefront, served by WordPress and WooCommerce inside the cluster. I add a product to the cart and go to checkout.",
    "At checkout I fill in the shipping details as a customer would. This is WooCommerce's block checkout, talking to its Store API, and everything on this page is served by the WordPress pod in the store namespace.",
    "I choose cash on delivery, which is test-friendly, and place the order.",
  ]);
  state.firstOrder = order; save();
  await s.say(`The order is confirmed, number ${order}. Now the WooCommerce admin. Here is the same order in the list. The data lives in MariaDB on a persistent volume, so it survives pod restarts.`, () => wpAdminOrders(s));
});

if (want("03")) await scene("03-kubernetes", "Kubernetes", async (s) => {
  await s.setCaption("3 · Kubernetes", "what runs where, public versus internal");
  await s.openTerminal("ssh ubuntu@urumi-vps  (k3s on AWS EC2)");
  await s.say("Now Kubernetes. This is the k3s node. The system uses three namespaces of its own. Platform runs the gateway, the dashboard, Postgres, the provisioner, two more MCP servers and the observability stack. Store runs WordPress, MariaDB and the WooCommerce MCP server. And mcp-hosted is for servers deployed from an image.", async () => {
    await s.run("kubectl get ns | grep -E 'NAME|platform|store|mcp-hosted'");
    await s.run("kubectl get pods -n platform");
    await s.run("kubectl get pods -n store");
  });
  await s.clearTerminal();
  await s.say("Persistent storage: the database, WordPress content and Postgres each have a persistent volume claim, bound on the node's disk. Secrets are Kubernetes Secrets generated at install time; none are in the repository or in a values file, and you only see their names here.", async () => {
    await s.run("kubectl get pvc -A");
    await s.run("kubectl get secret -A | grep -vE 'helm.sh|token|tls$' | cut -c1-110");
  });
  await s.clearTerminal();
  await s.say("Ingress. Only the dashboard host and the shop host are exposed, each with its own Let's Encrypt certificate issued by cert-manager. The gateway's MCP endpoint is a path on the dashboard host. There is no ingress and no public service for any upstream MCP server.", async () => {
    await s.run("kubectl get ingress -A");
    await s.run("kubectl get certificate -A");
    await s.run("kubectl get svc -A | grep -vE 'ClusterIP|NAME'");
  });
  await s.clearTerminal();
  await s.say("Every workload has resource requests and limits and readiness and liveness probes. Here is the gateway deployment: the CPU and memory it asks for, the ceiling it may use, and the probes Kubernetes uses to decide when to send traffic and when to restart it.", async () => {
    await s.run("kubectl -n platform describe deploy/gateway | grep -E 'Replicas:|Limits:|Requests:|cpu:|memory:|Liveness:|Readiness:' | cut -c1-150");
    await s.run("kubectl -n platform get hpa");
  });
  await s.clearTerminal();
  await s.say("How internal-only is enforced: every namespace has a default-deny network policy, and the WooCommerce MCP server admits traffic only from the gateway. I will prove it. First a throwaway pod tries to open the MCP server's port. Then the gateway pod tries the same thing.", async () => {
    await s.run("kubectl get networkpolicy -n store");
    await s.run(`kubectl run probe -n platform --rm -i --restart=Never --image=busybox:1.36 -- sh -c "nc -z -w 4 woocommerce-mcp.store.svc.cluster.local 8080 && echo OPEN || echo BLOCKED" 2>&1 | grep -E 'OPEN|BLOCKED'`, { shown: "kubectl run probe --rm -i --image=busybox -- nc -z -w 4 woocommerce-mcp.store.svc.cluster.local 8080   # from a random pod" });
    await s.run(`kubectl -n platform exec deploy/gateway -c gateway -- sh -c "nc -z -w 4 woocommerce-mcp.store.svc.cluster.local 8080 && echo OPEN || echo BLOCKED"`, { shown: "kubectl exec deploy/gateway -- nc -z -w 4 woocommerce-mcp.store.svc.cluster.local 8080   # from the gateway" });
  });
  await s.say("The random pod is blocked and the gateway is let through. The same policies keep one store's MCP server away from another store's database, and the containers run as non-root with read-only filesystems.");
});

if (want("04")) await scene("04-chat-a", "Chat as user A", async (s) => {
  await s.setCaption("4 · Definition of done: chat agent as user A (ada, admin)", "create a product, take an order, ask for today's orders");
  await s.say("Now the dashboard, as user A, an admin. The Servers page lists every registered upstream with its status and the tools it exposes. The WooCommerce server was registered first, automatically, at install time.", async () => {
    await login(s, "ada", ADMIN_PASSWORD);
    await s.page.evaluate(() => document.querySelectorAll("details").forEach((d) => d.removeAttribute("open")));
    await s.click("article.card:first-of-type details summary");
    await sleep(1200);
  });
  await s.say("Now the chat agent. I ask it to create a product with a name and a price.", async () => {
    await s.click('nav[aria-label="Main"] a[href="/chat"]');
    await chatAsk(s, "Create a product called Demo Mug priced at 14.50");
  });
  await s.say("The agent called the WooCommerce create product tool, and the chat shows exactly which tool it called, with its arguments and result. Now the storefront: the product is there.", async () => {
    await s.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2500);
    await s.goto(`https://${SHOP}/shop/`);
    await sleep(2500);
  });
  let order = "";
  order = await placeOrder(s, "Demo Mug", [
    "I place an order for it by hand on the storefront, as a customer would. The Demo Mug the agent created is the first product in the shop.",
    "Same checkout as before: shipping details, then cash on delivery.",
    "And place the order.",
  ]);
  state.demoOrder = order; save();
  await s.say(`Order ${order} is placed. Back in the chat I ask what orders came in today.`, async () => {
    await s.goto(`https://${DASH}/chat`);
    await s.find('textarea[name="message"]');
    await chatAsk(s, "What orders came in today?");
  });
  await s.say("The agent called the list orders tool and returned the order I just placed. It acted as ada: the call went through the gateway's router with her user id, and it will show in the audit log under her name.", async () => { await sleep(2000); });
});

if (want("05")) await scene("05-external-b", "External client as user B", async (s) => {
  await s.setCaption("5 · Definition of done: external MCP client as user B (maya, member)", "add a server, invite a member, connect with URL and key only");
  await s.say("As admin I can add another MCP server by URL and credential. I register a second copy of the demo utility server with a bearer secret. Note the secret field: once saved, it is never shown again.", async () => {
    await login(s, "ada", ADMIN_PASSWORD);
    await s.click("main .row.between button");
    await s.find("dialog[open]");
    await s.type('dialog[open] label:nth-of-type(1) input', "Demo echo");
    await s.type('dialog[open] input[name="url"]', "http://utility-mcp.platform.svc.cluster.local:8080/mcp");
    await s.page.select("dialog[open] select", "bearer");
    await s.type('dialog[open] input[name="secret"]', "demo-upstream-secret-123");
    await s.click('dialog[open] button[type="submit"]', { pause: 2500 });
  });
  await s.say("Next, team members. I invite maya with the member role.", async () => {
    await s.click('nav[aria-label="Main"] a[href="/members"]');
    await s.type('form[aria-label="Invite a member"] input[name="username"]', BEA.user);
    await s.type('form[aria-label="Invite a member"] input[name="password"]', BEA.password);
    await s.click('form[aria-label="Invite a member"] button[type="submit"]', { pause: 2000 });
  });
  await s.say("Now I am maya, user B. A member sees no Members, Permissions or Audit pages. I open API keys and generate my own key. It is shown once, and only its hash is stored.", async () => {
    await login(s, BEA.user, BEA.password);
    await s.click('nav[aria-label="Main"] a[href="/keys"]');
    await s.type('form[aria-label="Create an API key"] input[name="label"]', "claude-code");
    await s.click('form[aria-label="Create an API key"] button[type="submit"]', { pause: 1500 });
    state.bKey = await s.text("code.token");
    save();
    await sleep(2500);
    await s.click('dialog[open] button:not([data-copy]):last-of-type', { pause: 500 }).catch(() => undefined);
  });
  await s.openTerminal("external MCP client (my laptop): MCP Inspector CLI, only the gateway URL and maya's key");
  let listed = "";
  await s.say("Now an external MCP client on my own machine: the MCP Inspector. All it has is the gateway URL and maya's key. Listing tools returns the tools of every enabled server, each prefixed with its server's name. Notice the two servers that both offer an echo tool: they stay distinct: utility, double underscore, echo, and demo underscore echo, double underscore, echo. That is my collision scheme.", async () => {
    listed = await s.run(inspector("tools/list") + ` | grep -E '"name": "[a-z0-9_]+__' | sed 's/^ *//'`, { where: "local", env: bEnv(), shown: `mcp-inspector --cli ${MCP} --header "Authorization: Bearer $B_KEY" --method tools/list | grep name`, maxLines: 40 });
  });
  await s.clearTerminal();
  await s.say("Now the orders question: I call the list orders tool and get the same order that user A's agent saw.", async () => {
    await s.run(inspector("tools/call", " --tool-name woocommerce__list_orders") + " | head -n 30", { where: "local", env: bEnv(), shown: `mcp-inspector --cli ${MCP} --header "Authorization: Bearer $B_KEY" --method tools/call --tool-name woocommerce__list_orders`, maxLines: 30 });
  });
  await s.clearTerminal();
  await s.say("One prompt that needs two different upstream servers. Here is Claude Code as the client, configured only with the gateway URL and maya's key. I ask for the current time in UTC and the number of orders. The time comes from the utility server and the orders from WooCommerce.", async () => {
    await local(`printf '{"mcpServers":{"urumi":{"type":"http","url":"${MCP}","headers":{"Authorization":"Bearer %s"}}}}' "$B_KEY" > docs/demo/out/mcp-b.json`, bEnv());
    await s.run(`sed -E 's/(Bearer umk_[A-Za-z0-9]{4})[A-Za-z0-9_-]*/\\1…/' docs/demo/out/mcp-b.json`, { where: "local", shown: "cat mcp.json   # the whole client configuration" });
    await s.run(`claude -p "Use the urumi tools: what is the current time in UTC, and how many orders are in the store? Answer in one sentence." --mcp-config docs/demo/out/mcp-b.json --strict-mcp-config --allowedTools "mcp__urumi"`, { where: "local", shown: `claude -p "what time is it in UTC and how many orders are there?" --mcp-config mcp.json --strict-mcp-config` });
  });
  await s.clearTerminal();
  await s.say("What can a member not do? Bea's tool list has no write tools: update order status is hidden from her. If she calls it directly anyway, by sending the JSON-RPC request by hand, the gateway rejects it with a denied error. Admins can still do it.", async () => {
    await s.run(inspector("tools/list") + " | grep -c update_order_status", { where: "local", env: bEnv(), shown: `mcp-inspector ... --method tools/list | grep -c update_order_status   # 0: hidden from members`, maxLines: 4 });
    await s.run(rpc("tools/call", { name: "woocommerce__update_order_status", arguments: { id: Number(state.demoOrder ?? 1), status: "completed" } }), { where: "local", env: bEnv(), shown: `curl ${MCP} -H "Authorization: Bearer $B_KEY" -d '{"method":"tools/call","params":{"name":"woocommerce__update_order_status", ...}}'`, maxLines: 8 });
  });
});

if (want("06")) await scene("06-control", "Team and control", async (s) => {
  await s.setCaption("6 · Definition of done: team and control", "disable a server, kill a pod, revoke a key, audit");
  await s.say("Now control. As admin I disable the second utility server. Its tools should disappear for everyone, both in the chat agent and in an external client.", async () => {
    await login(s, "ada", ADMIN_PASSWORD);
    await s.page.evaluate(() => {
      const card = [...document.querySelectorAll("article.card")].find((c) => (c.textContent ?? "").includes("demo_echo"));
      card?.querySelectorAll("button").forEach((b) => { if (b.textContent === "Disable") b.setAttribute("data-demo", "disable"); });
    });
    await s.click("[data-demo=disable]", { pause: 2500 });
  });
  await s.openTerminal("external MCP client: maya's key");
  await s.say("The external client lists tools again. demo_echo's tools are gone.", async () => {
    await s.run(inspector("tools/list") + ` | grep -E '"name": "[a-z0-9_]+__' | sed 's/^ *//'`, { where: "local", env: bEnv(), shown: `mcp-inspector --cli ${MCP} --header "Authorization: Bearer $B_KEY" --method tools/list | grep name`, maxLines: 40 });
  });
  await s.say("And in the chat agent, as ada, the same question now has no tool to answer it.", async () => {
    await login(s, "ada", ADMIN_PASSWORD);
    await s.click('nav[aria-label="Main"] a[href="/chat"]');
    await chatAsk(s, "Use the demo_echo tool to echo the word hello. If you do not have that tool, say so.");
  });
  await s.say("Next, kill an upstream. I scale the policy server's pods to zero. The dashboard shows it as unreachable with the reason, while the WooCommerce server stays connected.", async () => {
    await remote("kubectl -n platform scale deploy/policy-mcp --replicas=0 && kubectl -n platform wait --for=delete pod -l app=policy-mcp --timeout=60s");
    await s.goto(`https://${DASH}/`);
    await s.page.evaluate(() => document.querySelectorAll("button").forEach((b) => { if (b.textContent === "Probe") (b as HTMLButtonElement).setAttribute("data-demo-probe", "1"); }));
    await sleep(500);
    await s.click("article.card:nth-of-type(3) button:nth-of-type(2), [data-demo-probe]", { pause: 3500 });
    await s.page.reload({ waitUntil: "networkidle2" });
    await sleep(3000);
  });
  await s.openTerminal("external MCP client: maya's key");
  await s.say("From the external client, tool listing still works and a WooCommerce call still succeeds. A call to the dead server's tool fails with a clear error instead of hanging, within its timeout.", async () => {
    await s.run(inspector("tools/call", " --tool-name woocommerce__list_products") + " | grep '\"name\"' | head -n 5", { where: "local", env: bEnv(), shown: `mcp-inspector --cli ${MCP} --header "Authorization: Bearer $B_KEY" --method tools/call --tool-name woocommerce__list_products | grep name`, maxLines: 8 });
    await s.run(rpc("tools/call", { name: "policy__get_return_policy", arguments: {} }), { where: "local", env: bEnv(), shown: `curl ${MCP} -H "Authorization: Bearer $B_KEY" -d '{"method":"tools/call","params":{"name":"policy__get_return_policy"}}'   # the dead server`, maxLines: 8 });
  });
  await remote("kubectl -n platform scale deploy/policy-mcp --replicas=2");
  await s.say("I bring the server back. Now revoke maya's key. In the members list I open her keys and press revoke.", async () => {
    await login(s, "ada", ADMIN_PASSWORD);
    await s.click('nav[aria-label="Main"] a[href="/members"]');
    await s.find("table tbody tr");
    await s.page.evaluate((token) => {
      const row = [...document.querySelectorAll("tbody tr")].find((r) => r.querySelector("td")?.firstChild?.textContent === "maya");
      const key = [...(row?.querySelectorAll("li") ?? [])].find((li) => token.startsWith((li.querySelector("code")?.textContent ?? "").replace("…", "")) && li.querySelector("button.danger"));
      key?.querySelector("button.danger")?.setAttribute("data-demo", "revoke");
    }, state.bKey ?? "");
    await s.click("[data-demo=revoke]", { pause: 800 });
    await s.click("dialog[open] button.danger", { pause: 2000 });
  });
  await s.openTerminal("external MCP client: maya's old key");
  await s.say("Bea's next call is rejected: the gateway answers 401 unauthorized, and points at its OAuth metadata, which is why a client like the Inspector would fall back to a browser login.", async () => {
    await s.run(rpc("tools/list", {}, "-si") + " | head -n 9", { where: "local", env: bEnv(), shown: `curl -i ${MCP} -H "Authorization: Bearer $B_KEY" -d '{"method":"tools/list"}'   # the revoked key`, maxLines: 10 });
  });
  await s.say("Finally the audit log. Every call above is here, attributed to the right user: ada's chat calls with actor chat, maya's calls through the API key, the denied write, the rejected revoked key, with the server, tool, time, duration and outcome for each.", async () => {
    await login(s, "ada", ADMIN_PASSWORD);
    await s.click('nav[aria-label="Main"] a[href="/audit"]');
    await sleep(3500);
  });
});

if (want("07")) await scene("07-internals", "MCP internals", async (s) => {
  await s.setCaption("7 · MCP internals", "how a tool call travels, collisions, timeouts, a dead upstream");
  await s.openTerminal("gateway source and docs, on the VPS");
  await s.say("How a tool call travels. A client posts a JSON-RPC message to the gateway's single MCP endpoint. Ingress routes it to a gateway pod. The gateway authenticates the key or OAuth token, resolves the tool name to a server, takes a token from the caller's rate-limit bucket, checks permissions, and only then connects to the upstream with its stored credential and calls the tool with a deadline. The upstream, for example my WooCommerce server, calls the store's REST API and the result travels back unchanged, with an audit row written on the way.", async () => {
    await s.run("sed -n '/## The path of one call/,/The chat agent skips/p' docs/mcp-internals.md | cut -c1-175 | head -n 28");
  });
  await s.clearTerminal();
  await s.say("Name collisions. A public tool name is the server's slug, two underscores, and the upstream tool name. Two servers that both export list orders become store alpha list orders and store beta list orders. The router splits at the first double underscore and strips the prefix before calling the upstream.", async () => {
    await s.run("sed -n '/## Names and collisions/,/## Listing/p' docs/mcp-internals.md | cut -c1-175");
    await s.run("sed -n '/export function joinToolName/,/^}/p;/export function splitToolName/,/^}/p' packages/mcp-names/src/index.ts | cut -c1-150");
  });
  await s.clearTerminal();
  await s.say("Timeouts and a dead upstream. Listing asks every server in parallel with a three second deadline, and a server that misses it contributes nothing and is marked unreachable. Every call has its own eight second deadline and its own connection, so one slow or dead server can never delay a call to another. This is the failure matrix: what the caller sees, what the dashboard shows, and what the audit log records.", async () => {
    await s.run("grep -nE 'LIST_TIMEOUT_MS|CALL_TIMEOUT_MS' apps/gateway/src/router.ts | cut -c1-160 | head -n 6");
    await s.run("sed -n '/## Failure matrix/,/One slow or dead upstream/p' docs/mcp-internals.md | cut -c1-175 | head -n 18");
  });
});

if (want("08")) await scene("08-security", "Security posture", async (s) => {
  await s.setCaption("8 · Security posture", "keys, credentials, member limits, malicious servers");
  await s.openTerminal("ssh ubuntu@urumi-vps: what is in the database");
  await s.say("Security. API keys are shown once and stored only as a SHA-256 hash with a short prefix for lookup; passwords are hashed with a memory-hard function. Here is the database. There is no way to recover a key from it.", async () => {
    await s.run(`kubectl -n platform exec deploy/postgres -- psql -U urumi -d urumi -c "select prefix, left(key_hash, 24) || '…' as sha256_hash, label, revoked_at is not null as revoked from api_keys order by created_at desc limit 6" | cut -c1-140`, { shown: "psql: select prefix, key_hash, label, revoked from api_keys" });
    await s.run(`kubectl -n platform exec deploy/postgres -- psql -U urumi -d urumi -c "select username, role, left(password_hash, 22) || '…' as password_hash from users"`, { shown: "psql: select username, role, password_hash from users" });
  });
  await s.say("Upstream credentials are encrypted at rest with AES-GCM under a key that lives only in a Kubernetes Secret. The second utility server I added has a bearer secret; this is what is stored. The API never returns it, the browser never sees it, and an MCP client only ever gets tools.", async () => {
    await s.run(`kubectl -n platform exec deploy/postgres -- psql -U urumi -d urumi -c "select slug, credential_type, left(credential_ciphertext, 44) || '…' as credential_ciphertext from mcp_servers" | cut -c1-140`, { shown: "psql: select slug, credential_type, credential_ciphertext from mcp_servers" });
  });
  await s.say("Client tokens are never passed through to upstream servers. The gateway uses its own stored credential for each upstream, and the caller's Authorization and cookie headers are never forwarded. That is the confused-deputy rule from the MCP authorization specification.", async () => {
    await s.run("sed -n '/private async connect/,/await client.connect/p' apps/gateway/src/router.ts | cut -c1-165");
  });
  await s.say("Now the malicious or compromised server. First, a server URL aimed at the cloud metadata address or the cluster's internal network. The gateway resolves the name once, checks every address against a block list, pins the connection to the checked address, and refuses redirects. Let me add one.", async () => {
    await login(s, "ada", ADMIN_PASSWORD);
    await s.click("main .row.between button");
    await s.find("dialog[open]");
    await s.type('dialog[open] label:nth-of-type(1) input', "Metadata probe");
    await s.type('dialog[open] input[name="url"]', "http://169.254.169.254/latest/meta-data/");
    await s.click('dialog[open] button[type="submit"]', { pause: 3500 });
  });
  await s.say("It is blocked by the SSRF policy, with that reason shown. Second, a server that is reachable but hostile: its tool descriptions are untrusted text that ends up in a model's context. The gateway strips control and bidirectional characters, caps their length, labels each tool with its server, and tells the chat model to treat tool text as data. Most importantly, the permission check is outside the model: if a model is talked into calling a write tool, a member's call is still denied.", async () => {
    await sleep(1000);
  });
  await s.openTerminal("threat model, excerpt");
  await s.run("sed -n '/^## The four questions/,/^## Other threats/p' docs/threat-model.md | cut -c1-175 | head -n 30");
  await s.say("What one member can do to another: nothing. Keys, chat history and sessions are per user, a member sees no other user's keys or the audit log, and a member cannot reach upstream credentials. Admins can manage servers, members and permissions; members can use only the tools their role allows.");
  await s.goto(`https://${DASH}/`);
  await login(s, "ada", ADMIN_PASSWORD);
  await s.click('nav[aria-label="Main"] a[href="/permissions"]');
  await s.say("This is the permissions page: per-role and per-user allow or deny rules for any server or tool. Restricted tools are hidden from the tool list and rejected if called directly. By default members get read-only tools.", async () => { await sleep(1500); });
});

if (want("09")) await scene("09-chat-internals", "Chat agent", async (s) => {
  await s.setCaption("9 · The chat agent", "the tool loop, acting as the logged-in user");
  await s.openTerminal("apps/gateway/src/chat.ts");
  await s.say("The chat agent. The dashboard posts the conversation to the gateway. The gateway builds the model's tool list from what the logged-in user is allowed to call, and runs a loop: the model proposes tool calls, the gateway executes them, the results go back to the model, for up to eight steps. The model can be any provider; I am using an open-weight model hosted on Groq, through an OpenAI-compatible endpoint, and its key is in a Kubernetes Secret.", async () => {
    await s.run("grep -nE 'streamText|stopWhen|router.call|caller|systemPrompt' apps/gateway/src/chat.ts | cut -c1-170 | head -n 14");
  });
  await s.say("The important line is here: each tool call goes through the same router function as an external client's call, with the session user as the caller. So the permissions, rate limits and audit are identical, and the audit row says actor chat with that user's name. The agent never holds a credential of its own and never talks to an upstream directly.", async () => {
    await s.run(`kubectl -n platform exec deploy/postgres -- psql -U urumi -d urumi -c "select u.username, a.actor, a.server_slug, a.tool_name, a.outcome, round(a.duration_ms::numeric) as ms from audit_log a join users u on u.id = a.user_id order by a.id desc limit 10"`, { shown: "psql: audit_log: who, actor, server, tool, outcome, ms (latest 10)" });
  });
});

if (want("10")) await scene("10-production", "Local to VPS", async (s) => {
  await s.setCaption("10 · Local to VPS", "what changes through Helm values, upgrade and rollback");
  await s.openTerminal("ssh ubuntu@urumi-vps");
  await s.say("The local to production story. It is the same Helm chart in both places. Local uses values-local.yaml: k3d, hosts-file names, no TLS, images imported into the cluster. The VPS uses values-prod.yaml plus a short list of overrides: domain names, https, a certificate issuer, image registry and tag, larger limits and volumes. This is the diff of the two files.", async () => {
    await s.run("diff -y -W 170 --suppress-common-lines deploy/helm/urumi/values-local.yaml deploy/helm/urumi/values-prod.yaml | head -n 34");
  });
  await s.clearTerminal();
  await s.say("The bootstrap script installs k3s, ingress-nginx and cert-manager, generates every secret into a root-only file, creates the Kubernetes Secrets from it, and then installs the chart with exactly these overrides. Domains and ingress hosts, TLS through a Let's Encrypt cluster issuer, storage on the local-path class, and secrets generated on the server and never in the repository.", async () => {
    await s.run("sed -n '/Everything below is the complete list/,/helm test/p' scripts/vps-bootstrap.sh | cut -c1-150");
  });
  await s.clearTerminal();
  await s.say("Upgrades and rollback. Here is the release history. First I upgrade the gateway to an image tag that does not exist, atomically. While Helm waits, a loop checks that the dashboard keeps answering. The new pods cannot pull that image, so they never become ready. Because the deployment rolls out with zero unavailable pods, Kubernetes keeps sending traffic to the old, healthy gateway pods, and you can see the dashboard answering two hundred the whole time. When the timeout passes, Helm marks the revision as failed and rolls back by itself.", async () => {
    await s.run("helm history urumi -n platform | tail -n 4 | cut -c1-150");
    await s.run(`(for i in $(seq 1 11); do curl -s -o /dev/null -w "%{http_code} " https://${DASH}/healthz; sleep 6; done; echo) & helm upgrade urumi deploy/helm/urumi -n platform --reuse-values --set images.gateway.tag=does-not-exist --atomic --timeout 60s 2>&1 | grep -v warnings.go | tail -n 2 | cut -c1-150; wait`, { shown: `helm upgrade urumi deploy/helm/urumi -n platform --reuse-values --set images.gateway.tag=does-not-exist --atomic --timeout 60s   # while curl polls the dashboard` });
  });
  await s.say("The history shows the failed revision and the automatic rollback. Now a normal upgrade and a manual rollback: I change one gateway setting, then roll back to the previous revision. Everything is back as it was, and the store, its data and the other servers were never touched.", async () => {
    await s.run("helm history urumi -n platform | tail -n 4 | cut -c1-150");
    await s.run("helm upgrade urumi deploy/helm/urumi -n platform --reuse-values --set gateway.maxInflightCalls=32 --wait --timeout 4m 2>&1 | grep -E 'STATUS|REVISION'");
    await s.run("helm rollback urumi -n platform --wait --timeout 4m 2>&1 | grep 'Rollback was'; helm history urumi -n platform | tail -n 3 | cut -c1-150");
    await s.run("helm test urumi -n platform 2>&1 | grep -E 'Phase|NAME'");
  });
  await s.say("That is the system: a real WooCommerce store, my own MCP server, a gateway that aggregates, secures and audits every tool, a chat agent that acts as the user, per-store provisioning, and one set of Helm charts from a laptop to a VPS. The repository has the README, the design and threat-model notes, and the evidence from these runs. Thank you for watching.");
});

await closeBrowser();
console.log("done; next: bun scripts/demo/assemble.ts");
