#!/usr/bin/env bun
// Runs the Round 1 definition of done against a live cluster, with two users, over HTTP like a real client.
//   bun scripts/e2e.ts                  core flow only
//   STORES=1 bun scripts/e2e.ts         also the multi-store bonus (creates and deletes two stores, ~5 min)
//   SKIP_KUBECTL=1                      skip the steps that need kubectl (pod kill, namespace checks)
// It talks to 127.0.0.1:80 with a Host header, so no hosts-file entry is needed. Every line is PASS or FAIL
// and the exit code is the number of failures. Output is what docs/evidence/ keeps.
import { readFileSync } from "node:fs";

const ENTRY = process.env.ENTRY ?? "http://127.0.0.1";
const DASH = process.env.DASHBOARD_HOST ?? "dashboard.local";
const SHOP = process.env.SHOP_HOST ?? "shop.local";
const env = Object.fromEntries(
  (() => { try { return readFileSync("deploy/secrets/generated.env", "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)); } catch { return []; } })(),
);
const ADMIN_USER = process.env.ADMIN_USERNAME ?? "ada";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error("set ADMIN_PASSWORD or run scripts/dev-up.sh first");

let failures = 0;
const started = Date.now();
const pass = (name: string, detail = "") => console.log(`PASS  ${name}${detail ? `  (${detail})` : ""}`);
const fail = (name: string, detail = "") => { failures++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ""}`); };
const check = (ok: boolean, name: string, detail = "") => (ok ? pass(name, detail) : fail(name, detail));
const skip = (name: string, why: string) => console.log(`SKIP  ${name}  (${why})`);
const section = (title: string) => console.log(`\n== ${title}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function http(host: string, path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  if (init.cookie) headers.set("cookie", init.cookie);
  return fetch(`${ENTRY}${path}`, { ...init, headers, redirect: "manual" });
}

async function login(username: string, password: string) {
  const response = await http(DASH, "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { ok: response.ok, cookie };
}

const api = async (cookie: string, method: string, path: string, body?: unknown) => {
  const response = await http(DASH, path, { method, cookie, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json().catch(() => ({})) as any;
  return { status: response.status, json };
};

async function mcp(token: string, method: string, params?: Record<string, unknown>, query = "") {
  const response = await http(DASH, `/mcp${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await response.json().catch(() => ({})) as any;
  return { status: response.status, json };
}
const tools = async (token: string, query = "") => ((await mcp(token, "tools/list", undefined, query)).json.result?.tools ?? []).map((t: { name: string }) => t.name) as string[];
const call = (token: string, name: string, args: Record<string, unknown> = {}) => mcp(token, "tools/call", { name, arguments: args });
const text = (result: { json: any }) => result.json.result?.content?.[0]?.text ?? JSON.stringify(result.json.error ?? {});

function kubectl(...args: string[]): { code: number; out: string } {
  const result = Bun.spawnSync(["kubectl", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
}

// Places an order the way a shopper does, through WooCommerce's public Store API (cart token, guest checkout, cash on delivery).
async function placeOrder(host: string, productId: number, who: string) {
  const cartResponse = await http(host, "/wp-json/wc/store/v1/cart");
  const token = cartResponse.headers.get("cart-token") ?? "";
  const headers = { "content-type": "application/json", "cart-token": token };
  const added = await http(host, "/wp-json/wc/store/v1/cart/add-item", { method: "POST", headers, body: JSON.stringify({ id: productId, quantity: 1 }) });
  if (!added.ok) return { ok: false, detail: `add-item ${added.status} ${(await added.text()).slice(0, 120)}` };
  const address = { first_name: who, last_name: "Shopper", address_1: "1 Test Street", city: "Chennai", state: "TN", postcode: "600001", country: "IN", email: `${who.toLowerCase()}@example.com`, phone: "9999999999" };
  const done = await http(host, "/wp-json/wc/store/v1/checkout", { method: "POST", headers, body: JSON.stringify({ billing_address: address, shipping_address: address, payment_method: "cod" }) });
  const body = await done.json().catch(() => ({})) as any;
  return { ok: done.ok, orderId: body.order_id as number | undefined, detail: done.ok ? `order ${body.order_id}` : `checkout ${done.status} ${JSON.stringify(body).slice(0, 160)}` };
}

const today = () => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return { after: new Date(start.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 19), before: new Date(start.getTime() + 48 * 3600 * 1000).toISOString().slice(0, 19) };
};

// ---------------------------------------------------------------------------------------------------------------
section("Setup: admin A, member B, one key each");
const admin = await login(ADMIN_USER, ADMIN_PASSWORD);
check(admin.ok, "admin signs in to the dashboard API");
const suffix = Math.random().toString(36).slice(2, 7);
const bName = `bea${suffix}`;
const bPassword = `pw-${crypto.randomUUID()}`;
check((await api(admin.cookie, "POST", "/api/members", { username: bName, password: bPassword, role: "member" })).status === 201, "admin invites member B", bName);
const memberLogin = await login(bName, bPassword);
const keyA = (await api(admin.cookie, "POST", "/api/api-keys", { label: "e2e-A" })).json;
const keyB = (await api(memberLogin.cookie, "POST", "/api/api-keys", { label: "e2e-B" })).json;
check(String(keyA.token).startsWith("umk_") && String(keyB.token).startsWith("umk_"), "each user issues their own key");
const A = keyA.token as string;
const B = keyB.token as string;

section("Servers: three upstreams, one of them the WooCommerce MCP server");
const servers = (await api(admin.cookie, "GET", "/api/servers")).json.servers as Array<{ slug: string; status: string; toolCount: number; url?: string; credentialSet: boolean }>;
check(["woocommerce", "utility", "policy"].every((slug) => servers.some((s) => s.slug === slug && s.status === "connected")), "woocommerce, utility and policy are Connected", servers.map((s) => `${s.slug}:${s.status}:${s.toolCount}`).join(" "));
const memberServers = (await api(memberLogin.cookie, "GET", "/api/servers")).json.servers as Array<{ url?: string }>;
check(memberServers.every((s) => s.url === undefined), "a member never receives an upstream URL");
check(!JSON.stringify(servers).includes("ciphertext") && !JSON.stringify(servers).includes("secret"), "no credential material in the server list");

section("Store: storefront, product, checkout, order in WooCommerce");
const front = await http(SHOP, "/");
check(front.status === 200, "storefront answers", `${front.status}`);
const productName = `E2E Mug ${suffix}`;
const created = await call(A, "woocommerce__create_product", { name: productName, regular_price: "21.99" });
check(!created.json.error && !created.json.result?.isError, "user A creates a product through the gateway", text(created).slice(0, 90));
const productId = JSON.parse(text(created)).id as number;
const productPage = await http(SHOP, new URL(JSON.parse(text(created)).permalink).pathname);
check(productPage.status === 200 && (await productPage.text()).includes(productName), "the new product has a storefront page with its name");
const catalog = await (await http(SHOP, "/wp-json/wc/store/v1/products?per_page=50")).json() as Array<{ name: string }>;
check(catalog.some((p) => p.name === productName), "and is in the storefront's public product list");
const order = await placeOrder(SHOP, productId, `Ann${suffix}`);
check(order.ok, "a shopper checks out with cash on delivery", order.detail);

section("External client, user B: same orders question, two upstreams in one task");
check((await tools(B)).includes("woocommerce__list_orders"), "B sees the WooCommerce read tools");
const bList = await call(B, "woocommerce__list_orders", today());
check(text(bList).includes(String(order.orderId)), "B asks for today's orders and gets the order", `order ${order.orderId}`);
const bTime = await call(B, "utility__get_current_time", { timezone: "UTC" });
const bPolicy = await call(B, "policy__get_return_policy");
check(!bTime.json.error && !bPolicy.json.error && !bList.json.error, "one task uses tools from woocommerce, utility and policy");

section("Permissions: a member cannot write");
const bTools = await tools(B);
const aTools = await tools(A);
check(!bTools.includes("woocommerce__create_product") && !bTools.includes("woocommerce__update_order_status"), "write tools are hidden from B's tool list");
check(aTools.includes("woocommerce__create_product") && aTools.includes("woocommerce__update_order_status"), "A still sees them");
const denied = await call(B, "woocommerce__update_order_status", { id: order.orderId ?? 1, status: "completed" });
check(denied.json.error?.data?.code === "denied", "B's direct call to a hidden tool is rejected", denied.json.error?.message ?? "");

section("Many tools: the search surface");
const surface = await tools(B, "?surface=search");
check(surface.join() === "search_tools,describe_tool,call_tool", "?surface=search exposes three tools", surface.join());
const searched = JSON.parse(text(await mcp(B, "tools/call", { name: "search_tools", arguments: { query: "orders placed today" } }, "?surface=search")));
check(searched.tools?.[0]?.name?.endsWith("__list_orders"), "search_tools finds the orders tool first", searched.tools?.[0]?.name);
const viaSearch = await mcp(B, "tools/call", { name: "call_tool", arguments: { name: "utility__echo", arguments: { message: "via search" } } }, "?surface=search");
check(text(viaSearch).includes("via search"), "call_tool runs the tool it found");

section("Control: revoke, disable, kill");
const bKeyId = ((await api(memberLogin.cookie, "GET", "/api/api-keys")).json.keys as Array<{ id: string }>)[0]!.id;
check((await api(admin.cookie, "DELETE", `/api/api-keys/${bKeyId}`)).status === 200, "admin revokes B's key");
check((await mcp(B, "tools/list")).status === 401, "B's next call is rejected with 401");
const utility = servers.find((s) => s.slug === "utility")!;
const utilityId = ((await api(admin.cookie, "GET", "/api/servers")).json.servers as Array<{ id: string; slug: string }>).find((s) => s.slug === "utility")!.id;
await api(admin.cookie, "PATCH", `/api/servers/${utilityId}`, { enabled: false });
check(!(await tools(A)).some((t) => t.startsWith("utility__")), "disabling a server removes its tools from the external client");
const disabledCall = await call(A, "utility__echo", { message: "x" });
check(!!disabledCall.json.error, "a call to a disabled server's tool is refused", disabledCall.json.error?.message ?? "");
await api(admin.cookie, "PATCH", `/api/servers/${utilityId}`, { enabled: true });
check((await tools(A)).some((t) => t.startsWith("utility__")), "re-enabling brings them back");
void utility;

if (process.env.SKIP_KUBECTL) skip("kill an upstream pod", "SKIP_KUBECTL set");
else {
  kubectl("-n", "platform", "scale", "deploy/policy-mcp", "--replicas=0");
  kubectl("-n", "platform", "wait", "--for=delete", "pod", "-l", "app=policy-mcp", "--timeout=60s");
  const list = await tools(A);
  check(list.some((t) => t.startsWith("woocommerce__")) && list.some((t) => t.startsWith("utility__")), "with one upstream dead the others still list");
  check(text(await call(A, "utility__echo", { message: "still up" })).includes("still up"), "and still answer calls");
  const dead = await call(A, "policy__get_return_policy");
  check(["upstream_unreachable", "upstream_timeout"].includes(dead.json.error?.data?.code), "the dead one returns a clear error", dead.json.error?.data?.code);
  await api(admin.cookie, "POST", `/api/servers/${((await api(admin.cookie, "GET", "/api/servers")).json.servers as Array<{ id: string; slug: string }>).find((s) => s.slug === "policy")!.id}/probe`, {});
  const shown = ((await api(admin.cookie, "GET", "/api/servers")).json.servers as Array<{ slug: string; status: string; statusDetail: string }>).find((s) => s.slug === "policy")!;
  check(shown.status === "unreachable", "the dashboard shows it Unreachable, with a reason", shown.statusDetail.slice(0, 80));
  kubectl("-n", "platform", "scale", "deploy/policy-mcp", "--replicas=2");
  kubectl("-n", "platform", "rollout", "status", "deploy/policy-mcp", "--timeout=90s");
  const policyId = ((await api(admin.cookie, "GET", "/api/servers")).json.servers as Array<{ id: string; slug: string }>).find((s) => s.slug === "policy")!.id;
  // The Service endpoints and the gateway's probe settle within seconds of the pods becoming Ready; allow for that.
  let back = false;
  for (const stop = Date.now() + 45_000; Date.now() < stop && !back;) {
    await api(admin.cookie, "POST", `/api/servers/${policyId}/probe`, {});
    back = ((await api(admin.cookie, "GET", "/api/servers")).json.servers as Array<{ slug: string; status: string }>).find((s) => s.slug === "policy")!.status === "connected";
    if (!back) await sleep(3000);
  }
  check(back, "and Connected again once the pod is back");
}

section("Audit: every call above, attributed");
const audit = (await api(admin.cookie, "GET", "/api/audit?limit=200")).json.audit as Array<{ username: string | null; serverSlug: string | null; toolName: string | null; outcome: string; durationMs: number; actor: string }>;
const by = (user: string, tool: string, outcome = "success") => audit.some((r) => r.username === user && r.toolName === tool && r.outcome === outcome);
check(by(ADMIN_USER, "create_product"), "A's create_product is under A's name");
check(by(bName, "list_orders"), "B's list_orders is under B's name");
check(by(bName, "update_order_status", "denied"), "B's denied write is recorded as denied");
check(audit.some((r) => r.outcome === "unauthorized"), "the revoked key's rejected call is recorded");
check(audit.filter((r) => r.username).every((r) => typeof r.durationMs === "number" && r.serverSlug), "rows carry server and duration");
check((await api(memberLogin.cookie, "GET", "/api/audit")).status === 403, "a member cannot read the audit log");

// ---------------------------------------------------------------------------------------------------------------
if (!process.env.STORES) {
  skip("multi-store provisioning", "set STORES=1 to run it");
} else {
  section("Bonus: two stores, compare orders, delete one");
  const make = (name: string) => api(admin.cookie, "POST", "/api/stores", { name });
  const names = [`alpha${suffix}`.slice(0, 12), `beta${suffix}`.slice(0, 12)];
  const results = await Promise.all(names.map(make));
  check(results.every((r) => r.status === 201), "two stores are created in parallel", results.map((r) => r.status).join());
  check((await make(names[0]!)).status === 200, "creating the same store again is idempotent");
  const waitReady = async (slug: string, timeoutMs = 10 * 60 * 1000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const found = ((await api(admin.cookie, "GET", "/api/stores")).json.stores as Array<{ slug: string; status: string; phase: string; reason: string }>).find((s) => s.slug === slug);
      if (found?.status === "ready") return found;
      if (found?.status === "failed") return found;
      await sleep(5000);
    }
    return null;
  };
  const ready = await Promise.all(names.map((n) => waitReady(n)));
  check(ready.every((s) => s?.status === "ready"), "both stores reach Ready", ready.map((s) => `${s?.status}/${s?.phase}${s?.reason ? ` ${s.reason}` : ""}`).join(" | "));

  const slugs = names.map((n) => n.replace(/[^a-z0-9]/g, ""));
  const aToolsNow = await tools(A);
  check(slugs.every((s) => aToolsNow.includes(`store_${s}__list_orders`)), "each store's tools appear, named after the store", slugs.map((s) => `store_${s}__list_orders`).join(", "));
  const storeProduct = async (slug: string) => {
    const listed = JSON.parse(text(await call(A, `store_${slug}__list_products`, { per_page: 5 }))) as { id: number }[] | { items: { id: number }[] };
    return (Array.isArray(listed) ? listed : listed.items)[0]!.id;
  };
  const orders = await Promise.all(slugs.map(async (slug) => placeOrder(`${slug}.shop.localhost`, await storeProduct(slug), slug)));
  check(orders.every((o) => o.ok), "an order is placed on each storefront", orders.map((o) => o.detail).join(" | "));
  const counts = await Promise.all(slugs.map(async (slug) => {
    const body = JSON.parse(text(await call(A, `store_${slug}__list_orders`, today()))) as unknown[];
    return Array.isArray(body) ? body.length : -1;
  }));
  check(counts.every((n) => n >= 1), "today's orders compare across the two stores", counts.join(" vs "));
  const bytes = await Promise.all(slugs.map((s) => http(`${s}.shop.localhost`, "/")));
  check(bytes.every((r) => r.status === 200), "each store has its own working storefront URL");

  if (!process.env.SKIP_KUBECTL) {
    const quota = kubectl("-n", `store-${slugs[0]}`, "get", "resourcequota,limitrange", "-o", "name");
    check(/resourcequota/.test(quota.out) && /limitrange/.test(quota.out), "each namespace has a ResourceQuota and a LimitRange");
    const over = await make(`gamma${suffix}`.slice(0, 12));
    const over2 = await make(`delta${suffix}`.slice(0, 12));
    check(over.status === 201 && over2.status === 429, "the per-user cap refuses the fourth store", `${over.status} then ${over2.status}`);
    await api(admin.cookie, "DELETE", `/api/stores/${over.json.store.id}`);
  }

  const victim = ready[1]!;
  const victimStore = ((await api(admin.cookie, "GET", "/api/stores")).json.stores as Array<{ id: string; slug: string }>).find((s) => s.slug === slugs[1])!;
  await api(admin.cookie, "DELETE", `/api/stores/${victimStore.id}`);
  const goneBy = Date.now() + 5 * 60 * 1000;
  let gone = false;
  while (Date.now() < goneBy) {
    const list = ((await api(admin.cookie, "GET", "/api/stores")).json.stores as Array<{ slug: string }>);
    if (!list.some((s) => s.slug === slugs[1])) { gone = true; break; }
    await sleep(4000);
  }
  check(gone, "deleting a store removes it from the list", victim.status);
  const afterTools = await tools(A);
  check(!afterTools.some((t) => t.startsWith(`store_${slugs[1]}__`)) && afterTools.some((t) => t.startsWith(`store_${slugs[0]}__`)), "its tools are gone, the other store's remain");
  check(!(await api(admin.cookie, "GET", "/api/servers")).json.servers.some((s: { slug: string }) => s.slug === `store_${slugs[1]}`), "its MCP registration is gone");
  if (!process.env.SKIP_KUBECTL) {
    check(kubectl("get", "ns", `store-${slugs[1]}`).code !== 0, "its namespace is gone");
    const pvs = kubectl("get", "pv", "-o", "jsonpath={range .items[*]}{.spec.claimRef.namespace}{\"\\n\"}{end}").out;
    check(!pvs.includes(`store-${slugs[1]}`), "its volumes are gone");
  }
  // clean up the survivor so the run leaves nothing behind
  await api(admin.cookie, "DELETE", `/api/stores/${((await api(admin.cookie, "GET", "/api/stores")).json.stores as Array<{ id: string; slug: string }>).find((s) => s.slug === slugs[0])!.id}`);
}

// ---------------------------------------------------------------------------------------------------------------
if (!process.env.HOSTED) {
  skip("hosted MCP servers", "set HOSTED=1 to run it");
} else {
  section("Stand-out: a hosted MCP server from an image");
  const slug = `hosted_e2e${suffix}`.slice(0, 20);
  const bad = await api(admin.cookie, "POST", "/api/hosted", { slug, displayName: "x", image: "urumi-utility-mcp:latest", size: "small" });
  check(bad.status === 400, "an image with the latest tag is refused", bad.json.error);
  const evil = await api(admin.cookie, "POST", "/api/hosted", { slug, displayName: "x", image: "evil.example/miner:1", size: "small" });
  check(evil.status === 400, "an image from a registry that is not allowed is refused", evil.json.error);
  check((await api(memberLogin.cookie, "GET", "/api/hosted")).status === 403, "a member cannot see or create hosted servers");
  const created = await api(admin.cookie, "POST", "/api/hosted", { slug, displayName: "Hosted echo", image: "urumi-utility-mcp:local", size: "small", env: { MODE: "demo" }, secretEnv: { API_TOKEN: "hosted-secret-canary" } });
  check(created.status === 201, "an admin deploys the utility image as a hosted server", created.json.error ?? created.json.hosted?.status);
  let state = created.json.hosted;
  const until = Date.now() + 4 * 60 * 1000;
  while (Date.now() < until && state?.status !== "ready" && state?.status !== "failed") {
    await sleep(3000);
    state = ((await api(admin.cookie, "GET", "/api/hosted")).json.hosted as Array<{ slug: string; status: string; reason: string }>).find((h) => h.slug === slug);
  }
  check(state?.status === "ready", "it reaches Ready and is registered with the gateway", `${state?.status} ${state?.reason ?? ""}`);
  check((await tools(A)).includes(`${slug}__echo`), "its tools appear in the gateway's list", `${slug}__echo`);
  check(text(await call(A, `${slug}__echo`, { message: "hello hosted" })).includes("hello hosted"), "and a call to it works end to end");
  if (!process.env.SKIP_KUBECTL) {
    const pod = kubectl("-n", "mcp-hosted", "get", "pod", "-l", `urumi.io/hosted=${slug}`, "-o", "jsonpath={.items[0].metadata.name}").out;
    const spec = JSON.parse(kubectl("-n", "mcp-hosted", "get", "pod", pod, "-o", "json").out);
    const c = spec.spec.containers[0];
    check((spec.spec.securityContext?.runAsNonRoot === true || c.securityContext?.runAsNonRoot === true) && c.securityContext.readOnlyRootFilesystem === true && c.securityContext.allowPrivilegeEscalation === false && spec.spec.automountServiceAccountToken === false, "the pod is non-root, read-only, with no service-account token");
    check(c.resources.limits.memory === "128Mi" && kubectl("-n", "mcp-hosted", "get", "networkpolicy", "-o", "name").out.includes(slug.replace(/_/g, "-")), "it has resource limits and its own NetworkPolicy");
    check(kubectl("-n", "mcp-hosted", "get", "secret", `hosted-${slug.replace(/_/g, "-")}-env`, "-o", "name").code === 0, "its secret environment is a Kubernetes Secret");
    const inDb = kubectl("-n", "platform", "exec", "deploy/postgres", "--", "psql", "-U", "urumi", "-d", "urumi", "-At", "-c", "select env::text || secret_keys::text from hosted_servers").out;
    check(!inDb.includes("hosted-secret-canary"), "the secret value is not in Postgres");
  }
  const id = ((await api(admin.cookie, "GET", "/api/hosted")).json.hosted as Array<{ id: string; slug: string }>).find((h) => h.slug === slug)!.id;
  await api(admin.cookie, "DELETE", `/api/hosted/${id}`);
  let gone = false;
  for (const stop = Date.now() + 3 * 60 * 1000; Date.now() < stop;) {
    if (!((await api(admin.cookie, "GET", "/api/hosted")).json.hosted as Array<{ slug: string }>).some((h) => h.slug === slug)) { gone = true; break; }
    await sleep(3000);
  }
  check(gone, "deleting it removes the row");
  check(!(await tools(A)).some((t) => t.startsWith(`${slug}__`)), "and its tools");
  if (!process.env.SKIP_KUBECTL) {
    const left = kubectl("-n", "mcp-hosted", "get", "deploy,svc,secret,networkpolicy", "-o", "name").out;
    check(!left.includes(slug.replace(/_/g, "-")), "and the Deployment, Service, Secret and NetworkPolicy", left.replace(/\n/g, " ").slice(0, 80));
  }
}

// clean up the member
const bId = ((await api(admin.cookie, "GET", "/api/members")).json.members as Array<{ id: string; username: string }>).find((m) => m.username === bName)!.id;
await api(admin.cookie, "PATCH", `/api/members/${bId}`, { disabled: true });
console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`} in ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(failures);
