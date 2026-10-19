import type { SQL } from "bun";
import { Fail, randomSecret, Retry, type Config, type Step } from "./worker.ts";
import type { Work } from "./db.ts";

// A store is one Helm release (chart urumi-store) in its own namespace, plus one registered MCP server
// in the gateway. Phases, in order:
//   provisioning: namespace -> secrets -> release -> register -> ready
//   deleting:     unregister -> uninstall -> namespace -> drain -> forget
// Each phase is idempotent; see worker.ts for how a restart resumes.

export type StoreRow = {
  id: string;
  ownerId: string;
  ownerName: string;
  name: string;
  slug: string;
  namespace: string;
  host: string;
  url: string;
  mcpSlug: string;
  status: string;
  phase: string;
  reason: string;
  attempt: number;
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
};

export const mcpSlugFor = (slug: string) => `store_${slug}`;
export const namespaceFor = (slug: string) => `store-${slug}`;
const releaseFor = (slug: string) => `store-${slug}`;

export function slugify(name: string): string | null {
  let slug = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/^[0-9]/.test(slug)) slug = `s${slug}`;
  slug = slug.slice(0, 16);
  return /^[a-z][a-z0-9]{2,15}$/.test(slug) ? slug : null;
}

export const storeUrl = (config: Config, slug: string) => `${config.storesScheme}://${slug}.${config.storesDomain}`;

export function presentStore(row: Record<string, unknown>, config: Config): StoreRow {
  const slug = String(row.slug);
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    ownerName: String(row.owner_name),
    name: String(row.name),
    slug,
    namespace: String(row.namespace),
    host: String(row.host),
    url: storeUrl(config, slug),
    mcpSlug: mcpSlugFor(slug),
    status: String(row.status),
    phase: String(row.phase),
    reason: String(row.reason ?? ""),
    attempt: Number(row.attempt),
    deadlineAt: new Date(row.deadline_at as string).toISOString(),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

export class StoreError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type Caller = { id: string; username: string; role: "admin" | "member" };

// Safe to retry: the same owner asking for the same name (or a name with the same slug) gets the store
// that already exists, whatever state it is in. The per-owner limit is counted under an advisory lock so
// two parallel requests cannot both pass it.
export async function createStore(sql: SQL, config: Config, caller: Caller, name: string): Promise<{ store: StoreRow; created: boolean }> {
  const trimmed = name.trim().slice(0, 60);
  const slug = slugify(trimmed);
  if (!slug) throw new StoreError("store name must contain 3 to 16 letters or digits", 400);
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${caller.id}))`;
    const existing = (await tx`select * from stores where slug = ${slug}`)[0];
    if (existing) {
      if (existing.owner_id !== caller.id) throw new StoreError("that store name is taken", 409);
      return { store: presentStore(existing, config), created: false };
    }
    const [{ n }] = await tx`select count(*)::int as n from stores where owner_id = ${caller.id}::uuid and status <> 'deleting'`;
    if (n >= config.maxStoresPerUser) throw new StoreError(`store limit reached (${config.maxStoresPerUser} per user); delete one first`, 429);
    const row = (await tx`
      insert into stores (id, owner_id, owner_name, name, slug, namespace, host, status, phase, deadline_at)
      values (${crypto.randomUUID()}::uuid, ${caller.id}::uuid, ${caller.username}, ${trimmed}, ${slug}, ${namespaceFor(slug)}, ${`${slug}.${config.storesDomain}`}, 'provisioning', 'namespace',
              now() + (${config.provisionTimeoutSeconds} * interval '1 second'))
      returning *`)[0];
    return { store: presentStore(row, config), created: true };
  });
}

export async function listStores(sql: SQL, config: Config, caller: Caller): Promise<{ stores: StoreRow[]; limits: { maxPerUser: number; used: number } }> {
  const rows = caller.role === "admin"
    ? await sql`select * from stores order by created_at desc`
    : await sql`select * from stores where owner_id = ${caller.id}::uuid order by created_at desc`;
  const [{ n }] = await sql`select count(*)::int as n from stores where owner_id = ${caller.id}::uuid and status <> 'deleting'`;
  return { stores: rows.map((row: Record<string, unknown>) => presentStore(row, config)), limits: { maxPerUser: config.maxStoresPerUser, used: n } };
}

async function ownedStore(sql: SQL, caller: Caller, id: string) {
  const row = (await sql`select * from stores where id = ${id}::uuid`.catch(() => []))[0];
  if (!row || (caller.role !== "admin" && row.owner_id !== caller.id)) throw new StoreError("store not found", 404);
  return row as Record<string, unknown>;
}

export async function retryStore(sql: SQL, config: Config, caller: Caller, id: string): Promise<StoreRow> {
  const row = await ownedStore(sql, caller, id);
  if (row.status !== "failed") throw new StoreError("only a failed store can be retried", 409);
  const updated = (await sql`
    update stores set status = 'provisioning', phase = 'namespace', reason = '', attempt = attempt + 1, next_run_at = now(),
      deadline_at = now() + (${config.provisionTimeoutSeconds} * interval '1 second'), updated_at = now()
    where id = ${id}::uuid and status = 'failed' returning *`)[0];
  if (!updated) throw new StoreError("store changed state", 409);
  return presentStore(updated, config);
}

export async function deleteStore(sql: SQL, config: Config, caller: Caller, id: string): Promise<StoreRow> {
  const row = await ownedStore(sql, caller, id);
  if (row.status === "deleting") return presentStore(row, config);
  const updated = (await sql`
    update stores set status = 'deleting', phase = 'unregister', reason = '', next_run_at = now(), updated_at = now()
    where id = ${id}::uuid returning *`)[0];
  return presentStore(updated, config);
}

const rowOf = (work: Work) => work.raw as { slug: string; name: string; owner_id: string; namespace: string };

// How long to wait for a deleted namespace and its volumes to disappear before the reason says so.
const DRAIN_RETRY_SECONDS = 4;

export function storeSteps(): Record<string, Step> {
  return {
    "provisioning:namespace": async ({ work, deps }) => {
      const { slug, namespace } = rowOf(work);
      const existing = await deps.kube.getNamespace(namespace);
      // A namespace that exists without our label is not ours. Never adopt it, never delete it.
      if (existing && existing.labels["urumi.io/store"] !== slug) throw new Fail(`namespace ${namespace} already exists and is not managed by Urumi`);
      await deps.kube.createNamespace(namespace, {
        "urumi.io/managed": "true",
        "urumi.io/store": slug,
        "pod-security.kubernetes.io/enforce": "baseline",
        "pod-security.kubernetes.io/warn": "restricted",
      });
      // Gives the provisioner's service account the store-admin ClusterRole inside this namespace only.
      await deps.kube.ensureRoleBinding(namespace, "urumi-provisioner", "urumi-store-admin");
      return { next: "secrets" };
    },

    // Generated once and never rewritten: createSecret leaves an existing Secret alone, so a retry
    // after a crash cannot change a database password that MariaDB already initialised with.
    "provisioning:secrets": async ({ work, deps }) => {
      const { slug, namespace } = rowOf(work);
      const labels = { "urumi.io/store": slug };
      await deps.kube.createSecret(namespace, "store-db", { password: randomSecret(24), "root-password": randomSecret(24) }, labels);
      await deps.kube.createSecret(namespace, "store-admin", { username: "admin", password: randomSecret(18), email: `admin@${slug}.${deps.config.storesDomain}` }, labels);
      await deps.kube.createSecret(namespace, "store-wc-api", { "consumer-key": `ck_${randomSecret(24)}`, "consumer-secret": `cs_${randomSecret(24)}` }, labels);
      return { next: "release" };
    },

    "provisioning:release": async ({ work, deps, signal }) => {
      const { slug, name, namespace } = rowOf(work);
      const release = releaseFor(slug);
      // A process killed during install leaves the release pending-install; Helm then refuses to touch it.
      // Nothing worth keeping exists yet, so remove it and start the install clean.
      const current = await deps.helm.status(release, namespace);
      if (current && current.status !== "deployed") await deps.helm.uninstall(release, namespace);
      const remaining = Math.floor((work.deadlineAt.getTime() - Date.now()) / 1000);
      if (remaining < 45) throw new Fail("not enough time left to install the store");
      try {
        await deps.helm.upgradeInstall({
          release,
          namespace,
          chart: deps.config.storeChart,
          timeoutSeconds: Math.min(remaining - 15, deps.config.maxHelmSeconds),
          values: { ...deps.config.storeValues, store: { slug, name, host: `${slug}.${deps.config.storesDomain}`, url: storeUrl(deps.config, slug) } },
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        const problems = await deps.kube.podProblems(namespace).catch(() => "");
        throw new Fail(`helm install failed: ${(error instanceof Error ? error.message : String(error)).slice(-400)}${problems ? ` | ${problems}` : ""}`);
      }
      return { next: "register" };
    },

    // Ready means the gateway itself can reach the store's MCP server, not that a Deployment says so.
    "provisioning:register": async ({ work, deps }) => {
      const { slug, name, namespace } = rowOf(work);
      const url = `http://woocommerce-mcp.${namespace}.svc.cluster.local:8080/mcp`;
      const result = await deps.gateway.register({ slug: mcpSlugFor(slug), displayName: `Store: ${name}`, url, managedBy: "store" });
      if (result.status !== "connected") throw new Retry(`gateway cannot reach the store's MCP server yet (${result.status})`, 3);
      return { ready: true };
    },

    "deleting:unregister": async ({ work, deps }) => {
      await deps.gateway.unregister(mcpSlugFor(rowOf(work).slug));
      return { next: "uninstall" };
    },

    "deleting:uninstall": async ({ work, deps }) => {
      const { slug, namespace } = rowOf(work);
      const existing = await deps.kube.getNamespace(namespace);
      // Deleted before the namespace was created (or it is not ours): there is no release to remove, and Helm
      // would fail with "forbidden" because the provisioner holds no rights in a namespace it does not own.
      if (existing && existing.labels["urumi.io/store"] === slug) {
        // A crash between creating the namespace and binding the role leaves a namespace Helm cannot read.
        await deps.kube.ensureRoleBinding(namespace, "urumi-provisioner", "urumi-store-admin");
        await deps.helm.uninstall(releaseFor(slug), namespace);
      }
      return { next: "namespace" };
    },

    "deleting:namespace": async ({ work, deps }) => {
      const { slug, namespace } = rowOf(work);
      const existing = await deps.kube.getNamespace(namespace);
      // Only a namespace this store created is deleted. A foreign namespace with the same name is left alone.
      if (existing && existing.labels["urumi.io/store"] === slug) await deps.kube.deleteNamespace(namespace);
      return { next: "drain" };
    },

    // Namespace deletion is asynchronous. The store is gone only when the namespace and every volume
    // that was bound inside it are gone.
    "deleting:drain": async ({ work, deps }) => {
      const { namespace } = rowOf(work);
      const [ns, volumes] = await Promise.all([deps.kube.getNamespace(namespace), deps.kube.volumesFor(namespace)]);
      // A namespace that is not ours (never adopted, see provisioning:namespace) is not waited for.
      if (ns && ns.labels["urumi.io/store"] === rowOf(work).slug) throw new Retry(`waiting for namespace ${namespace} to terminate`, DRAIN_RETRY_SECONDS);
      if (volumes.length) throw new Retry(`waiting for volumes to be released: ${volumes.join(", ")}`, DRAIN_RETRY_SECONDS);
      return { forget: true };
    },
  };
}
