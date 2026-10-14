import { createApiToken, sha256Hex } from "/app/apps/gateway/src/crypto.ts";
import { createPostgresStore } from "/app/apps/gateway/src/postgres.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const store = createPostgresStore(databaseUrl);
const user = await store.getUserByUsername(process.env.ADMIN_USERNAME ?? "ada");
if (!user) throw new Error("admin user is missing");

const created = createApiToken();
const key = await store.insertApiKey({
  userId: user.id,
  prefix: created.prefix,
  keyHash: await sha256Hex(created.token),
  label: "smoke",
});

async function rpc(method: string, params: Record<string, unknown>) {
  const response = await fetch("http://127.0.0.1:8080/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${created.token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const listed = await rpc("tools/list", {});
const tools = ((listed.body.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map((tool) => tool.name);
console.log(`list ${listed.status} ${tools.join(",")}`);

const echoed = await rpc("tools/call", { name: "utility__echo", arguments: { message: "ping" } });
const echoText = (echoed.body.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? JSON.stringify(echoed.body.error ?? {});
console.log(`echo ${echoed.status} ${echoText}`);

const products = await rpc("tools/call", { name: "woocommerce__list_products", arguments: { per_page: 5 } });
const productText = (products.body.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined)?.content?.[0]?.text ?? JSON.stringify(products.body.error ?? {});
console.log(`products ${products.status} ${productText.slice(0, 300)}`);

const createdProduct = await rpc("tools/call", {
  name: "woocommerce__create_product",
  arguments: { name: "Seed Check Mug", regular_price: "9.50" },
});
const createdText = (createdProduct.body.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? JSON.stringify(createdProduct.body.error ?? {});
console.log(`create ${createdProduct.status} permalink=${createdText.includes("permalink")}`);

const orders = await rpc("tools/call", { name: "woocommerce__list_orders", arguments: { per_page: 5 } });
const orderText = (orders.body.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? "";
console.log(`orders ${orders.status} hasProcessing=${orderText.includes("processing")}`);

const chatUser = user;
const { signSession } = await import("/app/apps/gateway/src/crypto.ts");
const session = await signSession({ uid: chatUser.id, role: chatUser.role, exp: Date.now() + 60_000 }, process.env.SESSION_SECRET ?? "");
const chat = await fetch("http://127.0.0.1:8080/api/chat", {
  method: "POST",
  headers: { cookie: `urumi_session=${session}`, "content-type": "application/json" },
  body: JSON.stringify({ messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hello" }] }] }),
});
console.log(`chat ${chat.status} ${(await chat.text()).slice(0, 120)}`);

const utility = await store.getServerBySlug("utility");
if (!utility) throw new Error("utility server missing");
await store.updateServer(utility.id, { enabled: false });
const hidden = await rpc("tools/list", {});
const hiddenNames = ((hidden.body.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map((tool) => tool.name);
console.log(`utility-disabled ${hidden.status} hasUtility=${hiddenNames.some((name) => name.startsWith("utility__"))}`);
await store.updateServer(utility.id, { enabled: true });

const metrics = await fetch("http://127.0.0.1:9090/metrics");
const metricBody = await metrics.text();
console.log(`metrics ${metrics.status} calls=${metricBody.includes("tool_calls_total")}`);

await store.revokeApiKey(key.id, user.id);
const revoked = await rpc("tools/list", {});
console.log(`revoked ${revoked.status}`);
await store.close();
