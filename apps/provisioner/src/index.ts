import { SQL } from "bun";
import { log } from "@urumi/obs";
import { createApi } from "./api.ts";
import { migrate } from "./db.ts";
import { createGateway } from "./gateway.ts";
import { createHelm } from "./helm.ts";
import { hostedSteps } from "./hosted.ts";
import { createKube } from "./kube.ts";
import { storeSteps } from "./stores.ts";
import { Worker, type Config, type Deps } from "./worker.ts";

const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const json = (name: string): Record<string, unknown> => JSON.parse(process.env[name] ?? "{}");
const list = (name: string, fallback: string) => (process.env[name] ?? fallback).split(",").map((item) => item.trim()).filter(Boolean);

const config: Config = {
  platformNamespace: process.env.POD_NAMESPACE ?? "platform",
  provisionTimeoutSeconds: Number(process.env.PROVISION_TIMEOUT_SECONDS ?? 600),
  maxHelmSeconds: Number(process.env.MAX_HELM_SECONDS ?? 540),
  storesDomain: process.env.STORES_DOMAIN ?? "shop.localhost",
  storesScheme: process.env.STORES_SCHEME === "https" ? "https" : "http",
  storeChart: process.env.STORE_CHART ?? "/charts/urumi-store",
  hostedChart: process.env.HOSTED_CHART ?? "/charts/urumi-hosted-mcp",
  hostedNamespace: process.env.HOSTED_NAMESPACE ?? "mcp-hosted",
  hostedRegistries: list("HOSTED_REGISTRIES", "ghcr.io/"),
  hostedPullPolicy: process.env.HOSTED_PULL_POLICY ?? "IfNotPresent",
  maxStoresPerUser: Number(process.env.MAX_STORES_PER_USER ?? 3),
  storeValues: json("STORE_VALUES"),
  hostedValues: json("HOSTED_VALUES"),
  serviceAccount: process.env.PROVISIONER_SERVICE_ACCOUNT ?? "provisioner",
};

const sql = new SQL(need("DATABASE_URL"));
await migrate(sql);
const deps: Deps = { sql, helm: createHelm(), kube: createKube(), gateway: createGateway(need("GATEWAY_URL"), need("INTERNAL_TOKEN")), config };

const owner = `${process.env.HOSTNAME ?? "provisioner"}-${crypto.randomUUID().slice(0, 8)}`;
const workers = [new Worker(deps, "stores", storeSteps(), owner), new Worker(deps, "hosted_servers", hostedSteps(), owner)];
const CONCURRENCY = Number(process.env.PROVISION_CONCURRENCY ?? 3);

// Several stores can provision at once: up to CONCURRENCY rows are worked in parallel, and a second pod
// would take different rows because claiming uses `for update skip locked`.
let running = 0;
setInterval(() => {
  for (const worker of workers) {
    if (running >= CONCURRENCY) return;
    running++;
    worker.tick()
      .catch((error) => log("error", "tick failed", { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { running--; });
  }
}, 1000);

const api = createApi(deps, need("PROVISIONER_TOKEN"));
const server = Bun.serve({ port: Number(process.env.PORT ?? 8080), hostname: "0.0.0.0", fetch: api.fetch });
const metricsServer = Bun.serve({
  port: Number(process.env.METRICS_PORT ?? 9090),
  hostname: "0.0.0.0",
  fetch: (req) => (new URL(req.url).pathname === "/metrics" ? api.fetch(req) : new Response("not found", { status: 404 })),
});
log("info", "provisioner started", { owner, port: server.port, metricsPort: metricsServer.port });
process.on("SIGTERM", () => {
  server.stop();
  metricsServer.stop();
  setTimeout(() => process.exit(0), 5000);
});
