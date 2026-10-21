#!/usr/bin/env bun
// Drives tool calls through the gateway while you watch it scale, and reports success rate and latency per
// window. The default per-key rate limit (60/min) would throttle a load test, so raise it for the run:
//   helm upgrade urumi deploy/helm/urumi -n platform -f deploy/helm/urumi/values-local.yaml \
//     --set gateway.ratePerMinute=1000000 --set hpa.localMax=4
//   bun scripts/loadtest.ts                       # 30s, 24 workers
//   DURATION=120 WORKERS=48 bun scripts/loadtest.ts
// The HPA scales the gateway on CPU (target 70%); `kubectl -n platform get hpa,pods -l app=gateway -w` shows it.
import { readFileSync } from "node:fs";

const ENTRY = process.env.ENTRY ?? "http://127.0.0.1";
const HOST = process.env.DASHBOARD_HOST ?? "dashboard.local";
const DURATION = Number(process.env.DURATION ?? 30) * 1000;
const WORKERS = Number(process.env.WORKERS ?? 24);
const WINDOW = 5000;
const env = Object.fromEntries((() => { try { return readFileSync("deploy/secrets/generated.env", "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)); } catch { return []; } })());

const base = { host: HOST };
const login = await fetch(`${ENTRY}/api/login`, { method: "POST", headers: { ...base, "content-type": "application/json" }, body: JSON.stringify({ username: "ada", password: process.env.ADMIN_PASSWORD ?? env.ADMIN_PASSWORD }) });
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
const created = await (await fetch(`${ENTRY}/api/api-keys`, { method: "POST", headers: { ...base, cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "loadtest" }) })).json() as { token: string; key: { id: string } };

const results: Array<{ at: number; ms: number; ok: boolean; status: number }> = [];
const started = Date.now();
async function worker() {
  while (Date.now() - started < DURATION) {
    const t0 = performance.now();
    let status = 0;
    let ok = false;
    try {
      const r = await fetch(`${ENTRY}/mcp`, { method: "POST", headers: { ...base, authorization: `Bearer ${created.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "utility__echo", arguments: { message: "load" } } }) });
      status = r.status;
      const body = await r.json() as { result?: unknown; error?: unknown };
      ok = r.status === 200 && !!body.result && !body.error;
    } catch { /* counted as a failure */ }
    results.push({ at: Date.now() - started, ms: performance.now() - t0, ok, status });
  }
}

const watcher = setInterval(() => {
  const r = Bun.spawnSync(["kubectl", "-n", "platform", "get", "deploy", "gateway", "-o", "jsonpath={.status.readyReplicas}/{.spec.replicas}"], { stdout: "pipe", stderr: "pipe" });
  console.log(`  ... gateway ready/desired replicas: ${r.stdout.toString() || "?"}`);
}, WINDOW);
await Promise.all(Array.from({ length: WORKERS }, worker));
clearInterval(watcher);

const pct = (values: number[], p: number) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!.toFixed(0) : "-";
console.log("\nwindow   calls   ok%    p50ms  p95ms  p99ms");
for (let w = 0; w * WINDOW < DURATION; w++) {
  const slice = results.filter((r) => r.at >= w * WINDOW && r.at < (w + 1) * WINDOW);
  if (!slice.length) continue;
  const ms = slice.map((r) => r.ms);
  console.log(`${String(w * 5).padStart(3)}-${String(w * 5 + 5).padEnd(4)} ${String(slice.length).padStart(6)} ${(100 * slice.filter((r) => r.ok).length / slice.length).toFixed(1).padStart(6)} ${pct(ms, 0.5).padStart(7)} ${pct(ms, 0.95).padStart(6)} ${pct(ms, 0.99).padStart(6)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\ntotal ${results.length} calls, ${(results.length / (DURATION / 1000)).toFixed(0)}/s, success ${(100 * (results.length - failed.length) / results.length).toFixed(2)}%${failed.length ? `, statuses of failures: ${[...new Set(failed.map((f) => f.status))].join(",")}` : ""}`);
await fetch(`${ENTRY}/api/api-keys/${created.key.id}`, { method: "DELETE", headers: { ...base, cookie } });
process.exit(failed.length / results.length > 0.01 ? 1 : 0);
