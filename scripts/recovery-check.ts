#!/usr/bin/env bun
// "If the provisioning component restarts mid-provisioning, the store either completes or fails cleanly."
// Creates a store, kills the provisioner pod while the Helm install is running, and checks that the store
// completes with one namespace, one release and one set of credentials. Then does the same during a delete.
//   bun scripts/recovery-check.ts          ~8 minutes
import { readFileSync } from "node:fs";

const ENTRY = process.env.ENTRY ?? "http://127.0.0.1";
const HOST = process.env.DASHBOARD_HOST ?? "dashboard.local";
const env = Object.fromEntries((() => { try { return readFileSync("deploy/secrets/generated.env", "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)); } catch { return []; } })());
let failures = 0;
const check = (ok: boolean, name: string, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kubectl = (...args: string[]) => { const r = Bun.spawnSync(["kubectl", ...args], { stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: (r.stdout.toString() + r.stderr.toString()).trim() }; };

const login = await fetch(`${ENTRY}/api/login`, { method: "POST", headers: { host: HOST, "content-type": "application/json" }, body: JSON.stringify({ username: "ada", password: process.env.ADMIN_PASSWORD ?? env.ADMIN_PASSWORD }) });
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${ENTRY}${path}`, { method, headers: { host: HOST, cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
type Store = { id: string; slug: string; status: string; phase: string; reason: string; attempt: number };
// While the provisioner pod is being replaced the gateway answers 502: that is "unknown", not "the store is gone".
const stores = async (): Promise<Store[] | null> => {
  try {
    const r = await api("GET", "/api/stores");
    return Array.isArray(r.json.stores) ? r.json.stores : null;
  } catch { return null; }
};
const find = async (slug: string): Promise<Store | undefined | null> => { const all = await stores(); return all === null ? null : all.find((s) => s.slug === slug); };
const killProvisioner = () => kubectl("-n", "platform", "delete", "pod", "-l", "app=provisioner", "--grace-period=0", "--force");

const slug = `recov${Math.random().toString(36).slice(2, 6)}`;
const created = await api("POST", "/api/stores", { name: slug });
check(created.status === 201, "store created", slug);
const id = created.json.store.id as string;

// 1. kill the provisioner while Helm is installing
for (let i = 0; i < 120; i++) { const s = await find(slug); if (s?.phase === "release") break; await sleep(1000); }
const before = await find(slug);
check(before?.phase === "release" && before.status === "provisioning", "the store is in the release phase (Helm installing)", `${before?.status}/${before?.phase}`);
const podBefore = kubectl("-n", "platform", "get", "pod", "-l", "app=provisioner", "-o", "jsonpath={.items[0].metadata.name}").out;
console.log(`      killing ${podBefore}`);
killProvisioner();
for (let i = 0; i < 60; i++) { await sleep(2000); const p = kubectl("-n", "platform", "get", "pod", "-l", "app=provisioner", "-o", "jsonpath={.items[*].metadata.name}").out; if (p && !p.includes(podBefore)) break; }
const podAfter = kubectl("-n", "platform", "get", "pod", "-l", "app=provisioner", "-o", "jsonpath={.items[0].metadata.name}").out;
check(podAfter !== podBefore && podAfter.length > 0, "Kubernetes started a replacement provisioner pod", podAfter);

let finalState: Store | undefined | null = await find(slug);
for (const stop = Date.now() + 12 * 60 * 1000; Date.now() < stop;) {
  const seen = await find(slug);
  if (seen === null) { await sleep(3000); continue; }
  finalState = seen;
  if (finalState && (finalState.status === "ready" || finalState.status === "failed")) break;
  await sleep(5000);
}
check(finalState?.status === "ready" || (finalState?.status === "failed" && finalState.reason.length > 10), "the store completes, or fails cleanly with a reason", `${finalState?.status} ${finalState?.reason ?? ""}`);
check(finalState?.status === "ready", "in this run it completed", `attempt ${finalState?.attempt}`);
const ns = `store-${slug}`;
check(kubectl("get", "ns", "-l", `urumi.io/store=${slug}`, "-o", "name").out.split("\n").filter(Boolean).length === 1, "exactly one namespace exists for it");
const releases = kubectl("-n", ns, "get", "secret", "-l", "owner=helm,name=store-" + slug, "-o", "name").out.split("\n").filter(Boolean);
check(releases.length >= 1, "one Helm release lineage", `${releases.length} revision secret(s)`);
const secrets = kubectl("-n", ns, "get", "secret", "-o", "name").out;
check(["store-db", "store-admin", "store-wc-api"].every((n) => secrets.includes(n)), "the credentials exist once");
const tools = await fetch(`${ENTRY}/api/servers`, { headers: { host: HOST, cookie } }).then((r) => r.json() as Promise<any>);
check(tools.servers.some((s: { slug: string; status: string }) => s.slug === `store_${slug}` && s.status === "connected"), "it is registered in the gateway and Connected");

// 2. kill the provisioner while a delete is draining
await api("DELETE", `/api/stores/${id}`);
for (let i = 0; i < 60; i++) { const s = await find(slug); if (s === undefined || (s && (s.phase === "drain" || s.phase === "namespace" || s.phase === "uninstall"))) break; await sleep(500); }
console.log("      killing the provisioner during the delete");
killProvisioner();
let gone = false;
for (const stop = Date.now() + 8 * 60 * 1000; Date.now() < stop;) {
  const left = await find(slug);
  if (left === undefined) { gone = true; break; }
  await sleep(4000);
}
check(gone, "the delete finishes after the restart");
check(kubectl("get", "ns", ns).code !== 0, "the namespace is gone");
check(!kubectl("get", "pv", "-o", "jsonpath={.items[*].spec.claimRef.namespace}").out.includes(ns), "its volumes are gone");
check(!(await fetch(`${ENTRY}/api/servers`, { headers: { host: HOST, cookie } }).then((r) => r.json() as Promise<any>)).servers.some((s: { slug: string }) => s.slug === `store_${slug}`), "its MCP registration is gone");

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
process.exit(failures);
