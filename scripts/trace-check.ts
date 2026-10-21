#!/usr/bin/env bun
// One tool call, followed through Tempo: the client's traceparent joins the gateway span, the MCP server span
// and the WooCommerce REST span in one trace, and the same trace id is on the audit row.
import { readFileSync } from "node:fs";

const ENTRY = process.env.ENTRY ?? "http://127.0.0.1";
const HOST = process.env.DASHBOARD_HOST ?? "dashboard.local";
const env = Object.fromEntries((() => { try { return readFileSync("deploy/secrets/generated.env", "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)); } catch { return []; } })());
let failures = 0;
const check = (ok: boolean, name: string, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const login = await fetch(`${ENTRY}/api/login`, { method: "POST", headers: { host: HOST, "content-type": "application/json" }, body: JSON.stringify({ username: "ada", password: process.env.ADMIN_PASSWORD ?? env.ADMIN_PASSWORD }) });
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
const key = await (await fetch(`${ENTRY}/api/api-keys`, { method: "POST", headers: { host: HOST, cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "trace-check" }) })).json() as { token: string; key: { id: string } };

const traceId = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
const call = await fetch(`${ENTRY}/mcp`, {
  method: "POST",
  headers: { host: HOST, authorization: `Bearer ${key.token}`, "content-type": "application/json", accept: "application/json, text/event-stream", traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "woocommerce__list_products", arguments: { per_page: 1 } } }),
});
check(call.status === 200 && call.headers.get("traceparent")?.includes(traceId) === true, "the response carries the client's trace id", call.headers.get("traceparent") ?? "");

const audit = await (await fetch(`${ENTRY}/api/audit?tool=list_products&limit=5`, { headers: { host: HOST, cookie } })).json() as { audit: Array<{ traceId: string }> };
check(audit.audit.some((r) => r.traceId === traceId), "the audit row has the same trace id");

const forward = Bun.spawn(["kubectl", "-n", "platform", "port-forward", "svc/tempo", "13200:3200"], { stdout: "ignore", stderr: "ignore" });
await sleep(3000);
let spans: Array<{ service: string; name: string; id: string; parent: string }> = [];
for (let attempt = 0; attempt < 12 && spans.length < 3; attempt++) {
  await sleep(2500);
  const r = await fetch(`http://127.0.0.1:13200/api/traces/${traceId}`).catch(() => null);
  if (!r?.ok) continue;
  const body = await r.json() as { batches?: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }; scopeSpans: Array<{ spans: Array<{ name: string; spanId: string; parentSpanId?: string }> }> }> };
  spans = (body.batches ?? []).flatMap((b) => b.scopeSpans.flatMap((s) => s.spans.map((sp) => ({
    service: b.resource.attributes.find((a) => a.key === "service.name")?.value.stringValue ?? "?",
    name: sp.name, id: sp.spanId, parent: sp.parentSpanId ?? "",
  }))));
}
forward.kill();
for (const s of spans) console.log(`      ${s.service.padEnd(18)} ${s.name}`);
check(spans.some((s) => s.service === "gateway" && s.name === "gateway.call_upstream"), "Tempo has the gateway's upstream-call span");
check(spans.some((s) => s.service === "woocommerce-mcp" && s.name.startsWith("mcp.tool")), "and the WooCommerce MCP server's tool span");
check(spans.some((s) => s.service === "woocommerce-mcp" && s.name === "woocommerce.http"), "and the REST call to the store");
const byId = new Map(spans.map((s) => [s.id, s]));
const rest = spans.find((s) => s.name === "woocommerce.http");
check(!!rest && byId.get(rest.parent)?.name.startsWith("mcp.tool") === true, "the REST span is a child of the tool span, which is a child of the gateway's span", rest ? byId.get(rest.parent)?.name : "no rest span");

await fetch(`${ENTRY}/api/api-keys/${key.key.id}`, { method: "DELETE", headers: { host: HOST, cookie } });
console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
process.exit(failures);
