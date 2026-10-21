#!/usr/bin/env bun
// Security claims, each tried against the live cluster. Output is pasted into docs/security-test-log.md.
//   bun scripts/security-check.ts                 platform checks
//   ISOLATION=1 bun scripts/security-check.ts     also cross-store isolation (creates and deletes two stores)
//   STORE_A=alpha STORE_B=beta bun scripts/security-check.ts   the same, on two stores that already exist
import { readFileSync } from "node:fs";

const ENTRY = process.env.ENTRY ?? "http://127.0.0.1";
const DASH = process.env.DASHBOARD_HOST ?? "dashboard.local";
const env = Object.fromEntries((() => { try { return readFileSync("deploy/secrets/generated.env", "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)); } catch { return []; } })());
const PASSWORD = process.env.ADMIN_PASSWORD ?? env.ADMIN_PASSWORD;

let failures = 0;
const check = (ok: boolean, name: string, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const section = (t: string) => console.log(`\n== ${t}`);
const sh = (...args: string[]) => { const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: (r.stdout.toString() + r.stderr.toString()).trim() }; };
const kubectl = (...args: string[]) => sh("kubectl", ...args);

async function http(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", DASH);
  return fetch(`${ENTRY}${path}`, { ...init, headers, redirect: "manual" });
}
const login = await http("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "ada", password: PASSWORD }) });
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const api = async (method: string, path: string, body?: unknown) => {
  const r = await http(path, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};

// An ephemeral pod that tries one TCP connection and prints OPEN or BLOCKED. It waits six seconds first: a new pod's
// NetworkPolicy rules are programmed a moment after it starts, and a probe that races them proves nothing.
function probe(namespace: string, name: string, target: string, labels = "app=netcheck"): string {
  kubectl("-n", namespace, "delete", "pod", name, "--ignore-not-found", "--wait=true");
  const created = kubectl("-n", namespace, "run", name, "--restart=Never", "--labels", labels, "--image=urumi-gateway:local", "--image-pull-policy=Never",
    "--overrides", JSON.stringify({ spec: { automountServiceAccountToken: false, containers: [{ name, image: "urumi-gateway:local", imagePullPolicy: "Never", securityContext: { runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" } }, resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { cpu: "100m", memory: "64Mi" } }, command: ["bun", "-e", `await Bun.sleep(6000);const [h,p]="${target}".split(":");const t=setTimeout(()=>{console.log("BLOCKED");process.exit(0)},3000);try{await Bun.connect({hostname:h,port:Number(p),socket:{open(s){console.log("OPEN");s.end();process.exit(0)},data(){},error(){console.log("BLOCKED");process.exit(0)},close(){}}})}catch{console.log("BLOCKED");process.exit(0)}`] }] } }));
  if (created.code !== 0) return `ERROR ${created.out.slice(0, 160)}`;
  for (let i = 0; i < 40; i++) {
    const phase = kubectl("-n", namespace, "get", "pod", name, "-o", "jsonpath={.status.phase}").out;
    if (phase === "Succeeded" || phase === "Failed") break;
    Bun.sleepSync(1000);
  }
  const out = kubectl("-n", namespace, "logs", name).out;
  kubectl("-n", namespace, "delete", "pod", name, "--ignore-not-found", "--wait=false");
  return out.includes("OPEN") ? "OPEN" : out.includes("BLOCKED") ? "BLOCKED" : `ERROR ${out.slice(0, 160)}`;
}

section("SSRF: the API refuses an admin-supplied address in a blocked range");
for (const [label, url] of [["cloud metadata endpoint", "http://169.254.169.254/latest/meta-data/"], ["loopback", "http://127.0.0.1:8080/mcp"], ["Kubernetes API service", "https://kubernetes.default.svc.cluster.local/"], ["private range", "http://10.0.0.5/mcp"], ["IPv4-mapped IPv6 metadata", "http://[::ffff:169.254.169.254]/"], ["userinfo in the URL", "http://user:pass@example.com/mcp"]] as const) {
  const r = await api("POST", "/api/servers", { slug: "ssrf_probe", displayName: "x", url });
  check(r.status === 400, `rejects ${label}`, `${r.status} ${r.json.error ?? ""}`);
}
check((await api("GET", "/api/servers")).json.servers.every((s: { slug: string }) => s.slug !== "ssrf_probe"), "nothing was stored by the rejected requests");

section("Network layer: default deny, and what the gateway pod can and cannot reach");
const gatewayPod = kubectl("-n", "platform", "get", "pod", "-l", "app=gateway", "-o", "jsonpath={.items[0].metadata.name}").out;
const fromGateway = (target: string) => kubectl("-n", "platform", "exec", gatewayPod, "-c", "gateway", "--", "bun", "-e", `const [h,p]="${target}".split(":");const t=setTimeout(()=>{console.log("BLOCKED");process.exit(0)},3500);try{await Bun.connect({hostname:h,port:Number(p),socket:{open(s){console.log("OPEN");s.end();process.exit(0)},data(){},error(){console.log("BLOCKED");process.exit(0)},close(){}}})}catch{console.log("BLOCKED");process.exit(0)}`).out.split(/\r?\n/).find((line) => line === "OPEN" || line === "BLOCKED");
check(fromGateway("169.254.169.254:80") === "BLOCKED", "gateway pod cannot open the metadata address 169.254.169.254:80");
check(fromGateway("10.43.0.1:443") === "BLOCKED", "gateway pod cannot open the Kubernetes API service 10.43.0.1:443");
check(fromGateway("woocommerce-mcp.store.svc.cluster.local:8080") === "OPEN", "gateway pod can reach the WooCommerce MCP server it is meant to call");
check(fromGateway("postgres.platform.svc.cluster.local:5432") === "OPEN", "gateway pod can reach its database");
check(probe("platform", "netcheck-a", "woocommerce-mcp.store.svc.cluster.local:8080") === "BLOCKED", "an unlabelled pod cannot reach the WooCommerce MCP server");
check(probe("store", "netcheck-b", "mariadb.store.svc.cluster.local:3306") === "BLOCKED", "an unlabelled pod in the store namespace cannot reach MariaDB");
const pgProbe = probe("platform", "netcheck-c", "postgres.platform.svc.cluster.local:5432");
check(pgProbe === "BLOCKED", "an unlabelled pod cannot reach Postgres", pgProbe);
check(kubectl("-n", "platform", "get", "ingress", "-o", "name").out.split("\n").length >= 1 && !kubectl("get", "ingress", "-A", "-o", "jsonpath={.items[*].spec.rules[*].host}").out.match(/mcp|woocommerce-mcp/), "no Ingress exposes an MCP server: only the gateway is public");

section("Provisioner: least privilege, tested by impersonating its service account");
const sa = "--as=system:serviceaccount:platform:provisioner";
const can = (...args: string[]) => kubectl("auth", "can-i", ...args, sa).out.split(/\r?\n/).find((line) => line === "yes" || line === "no");
check(can("get", "secrets", "-n", "kube-system") === "no", "cannot read Secrets in kube-system");
check(can("list", "secrets", "--all-namespaces") === "no", "cannot list Secrets cluster-wide");
check(can("create", "deployments", "-n", "kube-system") === "no", "cannot create workloads in kube-system");
check(can("delete", "nodes") === "no", "cannot delete nodes");
check(can("create", "namespaces") === "yes" && can("delete", "namespaces") === "yes", "can create and delete namespaces (what it needs)");
check(can("patch", "namespaces") === "no", "cannot patch or relabel an existing namespace");
const bind = kubectl("create", "rolebinding", "evil", "--clusterrole=urumi-store-admin", "--serviceaccount=platform:provisioner", "-n", "kube-system", sa);
check(bind.code !== 0 && /urumi-provisioner-bindings|managed|denied|forbidden/i.test(bind.out), "cannot bind its role into kube-system (admission policy)", bind.out.split("\n")[0]?.slice(0, 140));
const escalate = kubectl("create", "rolebinding", "evil2", "--clusterrole=cluster-admin", "--serviceaccount=platform:provisioner", "-n", "platform", sa);
check(escalate.code !== 0, "cannot bind cluster-admin to itself", escalate.out.split("\n")[0]?.slice(0, 140));

section("Containers: non-root, no privilege escalation, read-only root, no service-account token where unneeded");
const pods = JSON.parse(kubectl("get", "pods", "-A", "-o", "json").out).items as Array<any>;
const ours = pods.filter((p) => ["gateway", "dashboard", "provisioner", "woocommerce-mcp", "utility-mcp", "policy-mcp"].includes(p.metadata.labels?.app));
check(ours.length > 0 && ours.every((p) => p.spec.containers.every((c: any) => c.securityContext?.runAsNonRoot === true && c.securityContext?.allowPrivilegeEscalation === false && c.securityContext?.readOnlyRootFilesystem === true)), "our Bun and nginx containers run non-root, no escalation, read-only root", `${ours.length} pods`);
const uid = kubectl("-n", "platform", "exec", kubectl("-n", "platform", "get", "pod", "-l", "app=gateway", "--field-selector=status.phase=Running", "-o", "jsonpath={.items[0].metadata.name}").out, "-c", "gateway", "--", "id", "-u").out;
check(uid === "1000", "gateway runs as uid 1000", uid);
check(pods.filter((p) => p.metadata.namespace === "mcp-hosted").every((p) => p.spec.automountServiceAccountToken === false), "hosted MCP pods get no service-account token");
check(["store", "platform"].every((ns) => (JSON.parse(kubectl("get", "ns", ns, "-o", "json").out).metadata.labels["pod-security.kubernetes.io/enforce"]) === "baseline"), "namespaces enforce the baseline Pod Security profile");

section("Every workload: probes and resource requests and limits");
const longRunning = pods.filter((p) => !(p.metadata.ownerReferences ?? []).some((o: any) => o.kind === "Job") && ["platform", "store", "mcp-hosted"].concat(pods.map((x) => x.metadata.namespace).filter((n: string) => n.startsWith("store-"))).includes(p.metadata.namespace) && !["urumi-smoke"].includes(p.metadata.name) && !p.metadata.name.startsWith("netcheck") && !p.metadata.name.startsWith("iso-"));
const noProbe = longRunning.flatMap((p) => p.spec.containers.filter((c: any) => !(c.readinessProbe || c.livenessProbe || c.startupProbe)).map((c: any) => `${p.metadata.namespace}/${p.metadata.name}:${c.name}`));
const noLimits = longRunning.flatMap((p) => p.spec.containers.filter((c: any) => !(c.resources?.requests?.cpu && c.resources?.requests?.memory && c.resources?.limits?.memory)).map((c: any) => `${p.metadata.namespace}/${p.metadata.name}:${c.name}`));
check(longRunning.length > 0 && noProbe.length === 0, "every long-running container has a readiness, liveness or startup probe", noProbe.length ? noProbe.join(", ") : `${longRunning.length} pods`);
check(noLimits.length === 0, "every container has CPU and memory requests and a memory limit", noLimits.join(", "));

section("Secrets at rest");
const pg = (query: string) => kubectl("-n", "platform", "exec", "deploy/postgres", "--", "psql", "-U", "urumi", "-d", "urumi", "-At", "-c", query).out;
const hash = pg("select key_hash from api_keys limit 1");
check(/^[0-9a-f]{64}$/.test(hash), "API keys are stored as a 64-hex SHA-256, never the token", hash.slice(0, 16) + "...");
check(pg("select count(*) from api_keys where key_hash like 'umk_%'") === "0", "no row holds a plaintext key");
check(/^\$argon2id\$/.test(pg("select password_hash from users limit 1")), "passwords are argon2id hashes");
const create = await api("POST", "/api/servers", { slug: "secret_probe", displayName: "Secret probe", url: "http://utility-mcp.platform.svc.cluster.local:8080/mcp", credentialType: "bearer", secret: "plaintext-canary-12345" });
const cipher = pg("select credential_ciphertext from mcp_servers where slug = 'secret_probe'");
check(create.status === 201 && cipher.includes("ciphertext") && !cipher.includes("plaintext-canary-12345"), "an upstream credential is stored as AES-GCM ciphertext", cipher.slice(0, 60) + "...");
check(!JSON.stringify((await api("GET", "/api/servers")).json).includes("plaintext-canary-12345"), "and never appears in an API response");
await api("DELETE", `/api/servers/${create.json.server?.id}`);
check(kubectl("-n", "platform", "get", "secret", "gateway-secrets", "-o", "jsonpath={.data}").out.length > 0 && !readFileSyncSafe("apps").includes("ck_"), "no secret material in the source tree");

function readFileSyncSafe(dir: string): string {
  const out = sh("git", "grep", "-nE", "(ck|cs)_[A-Za-z0-9_-]{20,}|umk_[A-Za-z0-9_-]{30,}|sk-[A-Za-z0-9]{20,}", "--", dir, "deploy", "scripts");
  return out.code === 0 ? out.out : "";
}

// ISOLATION=1 creates two stores of its own (about 6 minutes), checks them, and deletes them.
const madeStores: string[] = [];
if (process.env.ISOLATION) {
  const tag = Math.random().toString(36).slice(2, 6);
  for (const prefix of ["isoa", "isob"]) madeStores.push((await api("POST", "/api/stores", { name: `${prefix}${tag}` })).json.store.id);
  process.env.STORE_A = `isoa${tag}`;
  process.env.STORE_B = `isob${tag}`;
  for (const stop = Date.now() + 10 * 60 * 1000; Date.now() < stop;) {
    const list = (await api("GET", "/api/stores")).json.stores as Array<{ slug: string; status: string }>;
    if ([process.env.STORE_A, process.env.STORE_B].every((slug) => list.find((s) => s.slug === slug)?.status === "ready")) break;
    await Bun.sleep(5000);
  }
}
if (process.env.STORE_A && process.env.STORE_B) {
  section("Isolation between stores");
  const [a, b] = [process.env.STORE_A, process.env.STORE_B];
  const nsA = `store-${a}`, nsB = `store-${b}`;
  check(probe(nsA, "iso-a1", `mariadb.${nsB}.svc.cluster.local:3306`) === "BLOCKED", `a pod in ${nsA} cannot reach ${nsB}'s MariaDB`);
  check(probe(nsA, "iso-a2", `wordpress.${nsB}.svc.cluster.local:80`) === "BLOCKED", `a pod in ${nsA} cannot reach ${nsB}'s WordPress`);
  check(probe(nsA, "iso-a3", `woocommerce-mcp.${nsB}.svc.cluster.local:8080`) === "BLOCKED", `a pod in ${nsA} cannot reach ${nsB}'s MCP server`);
  check(probe(nsA, "iso-a4", `mariadb.${nsA}.svc.cluster.local:3306`) === "BLOCKED", `an unlabelled pod in ${nsA} cannot reach its own MariaDB either (only WordPress and the bootstrap job can)`);
  check(probe(nsA, "iso-a5", "woocommerce-mcp.store.svc.cluster.local:8080") === "BLOCKED", `a pod in ${nsA} cannot reach the core store's MCP server`);
  const mcpPodA = kubectl("-n", nsA, "get", "pod", "-l", "app=woocommerce-mcp", "-o", "jsonpath={.items[0].metadata.name}").out;
  const fromMcp = kubectl("-n", nsA, "exec", mcpPodA, "--", "bun", "-e", `const t=setTimeout(()=>{console.log("BLOCKED");process.exit(0)},3500);try{await Bun.connect({hostname:"mariadb.${nsA}.svc.cluster.local",port:3306,socket:{open(s){console.log("OPEN");s.end();process.exit(0)},data(){},error(){console.log("BLOCKED");process.exit(0)},close(){}}})}catch{console.log("BLOCKED");process.exit(0)}`).out.split(/\r?\n/).find((line) => line === "OPEN" || line === "BLOCKED");
  check(fromMcp === "BLOCKED", `${nsA}'s own MCP server cannot reach its own MariaDB (REST to WordPress only)`);
  const quota = kubectl("-n", nsA, "get", "resourcequota,limitrange", "-o", "name").out;
  check(/resourcequota/.test(quota) && /limitrange/.test(quota), `${nsA} has a ResourceQuota and a LimitRange`);
  const labels = JSON.parse(kubectl("get", "ns", nsA, "-o", "json").out).metadata.labels;
  check(labels["urumi.io/managed"] === "true" && labels["pod-security.kubernetes.io/enforce"] === "baseline", `${nsA} carries the managed and Pod Security labels`);
}

for (const id of madeStores) await api("DELETE", `/api/stores/${id}`);
console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
process.exit(failures);
