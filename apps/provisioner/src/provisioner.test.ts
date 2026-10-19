import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createApi } from "./api.ts";
import { migrate } from "./db.ts";
import { FakeGateway, FakeHelm, FakeKube } from "./fakes.ts";
import { createHosted, hostedSteps, validateImage } from "./hosted.ts";
import { createStore, deleteStore, listStores, retryStore, slugify, storeSteps } from "./stores.ts";
import { Worker, type Config, type Deps } from "./worker.ts";

// Needs a real Postgres (claiming uses `for update skip locked`):
//   TEST_DATABASE_URL=postgres://urumi:test@127.0.0.1:55432/urumi bun test apps/provisioner
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const config: Config = {
  platformNamespace: "platform",
  provisionTimeoutSeconds: 600,
  maxHelmSeconds: 540,
  storesDomain: "shop.localhost",
  storesScheme: "http",
  storeChart: "/charts/urumi-store",
  hostedChart: "/charts/urumi-hosted-mcp",
  hostedNamespace: "mcp-hosted",
  hostedRegistries: ["ghcr.io/", "urumi-"],
  hostedPullPolicy: "Never",
  maxStoresPerUser: 3,
  storeValues: { persistence: { storageClass: "local-path" } },
  hostedValues: {},
  serviceAccount: "provisioner",
};

// `expect(promise).rejects.toMatchObject(...)` hangs on these error objects under bun 1.2.19; compare by hand.
async function expectStatus(promise: Promise<unknown>, status: number) {
  const outcome = await promise.then(() => "resolved", (error: { status?: number }) => `rejected ${error.status}`);
  expect(outcome).toBe(`rejected ${status}`);
}

type Who = { id: string; username: string; role: "admin" | "member" };
const ada: Who = { id: "00000000-0000-0000-0000-00000000000a", username: "ada", role: "admin" };
const bea: Who = { id: "00000000-0000-0000-0000-00000000000b", username: "bea", role: "member" };

suite("provisioner", () => {
  let sql: SQL;
  let kube: FakeKube;
  let helm: FakeHelm;
  let gateway: FakeGateway;
  let deps: Deps;
  const owner = (n = 1) => `worker-${n}`;
  const stores = (n = 1, heartbeatMs = 50) => new Worker(deps, "stores", storeSteps(), owner(n), undefined, heartbeatMs);
  const hosted = () => new Worker(deps, "hosted_servers", hostedSteps(), owner(9), undefined, 50);

  beforeAll(async () => {
    sql = new SQL(url!);
    await sql.unsafe("drop table if exists stores, hosted_servers, provisioner_migrations cascade");
    await migrate(sql);
    await migrate(sql); // idempotent
  });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => {
    await sql`delete from stores`;
    await sql`delete from hosted_servers`;
    kube = new FakeKube();
    helm = new FakeHelm(kube);
    gateway = new FakeGateway();
    kube.bindings.push("mcp-hosted/urumi-provisioner"); // the chart creates this one statically
    deps = { sql, helm, kube, gateway, config };
  });

  // Runs ticks until the table has nothing claimable. Backoff is zeroed so a retry happens immediately.
  async function drain(worker: Worker, table = "stores", max = 40) {
    for (let i = 0; i < max; i++) {
      await sql.unsafe(`update ${table} set next_run_at = now() where status in ('provisioning','deleting')`);
      if (!(await worker.tick())) return;
    }
    throw new Error("did not settle");
  }
  const row = async (slug: string) => (await sql`select * from stores where slug = ${slug}`)[0];

  test("slugs", () => {
    expect(slugify("Alpha Shop")).toBe("alphashop");
    expect(slugify("9lives")).toBe("s9lives");
    expect(slugify("ab")).toBeNull();
    expect(slugify("A very long store name indeed")).toBe("averylongstorena");
    expect(slugify("!!!")).toBeNull();
  });

  test("a store goes namespace -> secrets -> release -> register -> ready, with the right shape", async () => {
    const { store, created } = await createStore(sql, config, ada, "Alpha");
    expect(created).toBe(true);
    expect(store).toMatchObject({ slug: "alpha", namespace: "store-alpha", status: "provisioning", url: "http://alpha.shop.localhost", mcpSlug: "store_alpha" });
    await drain(stores());
    expect((await row("alpha")).status).toBe("ready");
    expect(kube.namespaces.get("store-alpha")).toMatchObject({ "urumi.io/managed": "true", "urumi.io/store": "alpha", "pod-security.kubernetes.io/enforce": "baseline" });
    expect(kube.bindings.filter((b) => b.startsWith("store-"))).toEqual(["store-alpha/urumi-provisioner"]);
    expect([...kube.secrets.keys()].sort()).toEqual(["store-alpha/store-admin", "store-alpha/store-db", "store-alpha/store-wc-api"]);
    expect(helm.installs[0]).toMatchObject({ release: "store-alpha", namespace: "store-alpha" });
    expect(helm.installs[0]!.values).toMatchObject({ store: { slug: "alpha", name: "Alpha", host: "alpha.shop.localhost", url: "http://alpha.shop.localhost" }, persistence: { storageClass: "local-path" } });
    expect(gateway.servers.get("store_alpha")).toMatchObject({ displayName: "Store: Alpha", url: "http://woocommerce-mcp.store-alpha.svc.cluster.local:8080/mcp", managedBy: "store" });
  });

  test("several stores provision at the same time and none interferes with another", async () => {
    for (const name of ["Alpha", "Beta", "Gamma"]) await createStore(sql, config, name === "Gamma" ? bea : ada, name);
    await Promise.all([1, 2, 3].map((n) => drain(stores(n))));
    expect((await sql`select slug, status from stores order by slug`).map((r: any) => `${r.slug}:${r.status}`)).toEqual(["alpha:ready", "beta:ready", "gamma:ready"]);
    expect(helm.installs.map((i) => i.release).sort()).toEqual(["store-alpha", "store-beta", "store-gamma"]);
    expect([...gateway.servers.keys()].sort()).toEqual(["store_alpha", "store_beta", "store_gamma"]);
  });

  test("two workers never take the same row", async () => {
    await createStore(sql, config, ada, "Alpha");
    helm.script = ["hang"];
    const first = stores(1);
    const running = first.tick();
    await Bun.sleep(100);
    expect(await stores(2).tick()).toBe(false); // the lease is held
    await sql`update stores set status = 'deleting', phase = 'unregister'`; // make the first worker abort
    await running;
  });

  test("create is safe to retry, names are unique per slug, and the per-user cap is enforced", async () => {
    const first = await createStore(sql, config, ada, "Alpha");
    const again = await createStore(sql, config, ada, "alpha!");
    expect(again.created).toBe(false);
    expect(again.store.id).toBe(first.store.id);
    await expectStatus(createStore(sql, config, bea, "Alpha"), 409);
    await createStore(sql, config, ada, "Beta");
    await createStore(sql, config, ada, "Gamma");
    await expectStatus(createStore(sql, config, ada, "Delta"), 429);
    expect((await createStore(sql, config, bea, "Delta")).created).toBe(true); // another user is unaffected
    await deleteStore(sql, config, ada, first.store.id);
    expect((await createStore(sql, config, ada, "Delta2")).created).toBe(true); // a deleting store frees its slot
    await expectStatus(createStore(sql, config, ada, "x"), 400);
  });

  test("parallel creates cannot exceed the cap", async () => {
    const results = await Promise.allSettled(["Aa1", "Bb2", "Cc3", "Dd4", "Ee5"].map((name) => createStore(sql, config, ada, name)));
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(3);
    expect(results.filter((r) => r.status === "rejected").length).toBe(2);
  });

  test("members see only their own stores, admins see all", async () => {
    await createStore(sql, config, ada, "Alpha");
    await createStore(sql, config, bea, "Beta");
    expect((await listStores(sql, config, bea)).stores.map((s) => s.slug)).toEqual(["beta"]);
    expect((await listStores(sql, config, ada)).stores.length).toBe(2);
    const stranger = await createStore(sql, config, bea, "Gamma");
    await expectStatus(deleteStore(sql, config, { ...bea, id: "00000000-0000-0000-0000-0000000000cc" }, stranger.store.id), 404);
  });

  describe("recovery", () => {
    // A crash in a phase is a worker that stops partway; a restart is a new worker after the lease expires.
    for (const phase of ["namespace", "secrets", "release", "register"] as const) {
      test(`a restart in phase ${phase} resumes and ends with the same cluster as a clean run`, async () => {
        await createStore(sql, config, ada, "Alpha");
        await sql`update stores set phase = ${phase}, lease_owner = 'dead-pod', lease_until = now() - interval '1 second'`;
        if (phase !== "namespace") {
          // what the dead pod had already done
          await kube.createNamespace("store-alpha", { "urumi.io/store": "alpha", "urumi.io/managed": "true" });
          await kube.ensureRoleBinding("store-alpha", "urumi-provisioner", "urumi-store-admin");
        }
        if (phase === "register") helm.releases.set("store-alpha/store-alpha", "deployed"); // the install had finished
        if (phase === "release") {
          await kube.createSecret("store-alpha", "store-db", { password: "original", "root-password": "original" }, {});
          helm.releases.set("store-alpha/store-alpha", "pending-install"); // killed mid-install
        }
        await drain(stores(2));
        expect((await row("alpha")).status).toBe("ready");
        expect(kube.calls.filter((c) => c === "createNamespace:store-alpha").length).toBeLessThanOrEqual(1);
        expect(helm.installs.length).toBe(phase === "register" ? 0 : 1);
        expect(gateway.servers.has("store_alpha")).toBe(true);
        if (phase === "release") {
          expect(helm.uninstalls).toEqual(["store-alpha/store-alpha"]); // the half-installed release was cleared first
          expect(kube.secrets.get("store-alpha/store-db")!.password).toBe("original"); // existing credentials were not regenerated
        }
      });
    }

    test("a step error is retried with the phase kept, then succeeds", async () => {
      await createStore(sql, config, ada, "Alpha");
      kube.failNext.createNamespace = 2;
      const worker = stores();
      await worker.tick();
      expect(await row("alpha")).toMatchObject({ status: "provisioning", phase: "namespace" });
      expect((await row("alpha")).reason).toContain("retrying namespace");
      await drain(worker);
      expect((await row("alpha")).status).toBe("ready");
    });

    test("the gateway not yet reaching the MCP server is waited for, not failed", async () => {
      await createStore(sql, config, ada, "Alpha");
      gateway.statuses = ["unreachable", "unreachable"];
      await drain(stores());
      expect((await row("alpha")).status).toBe("ready");
      expect(gateway.calls.filter((c) => c.startsWith("register")).length).toBe(3);
    });

    test("past the deadline a store fails cleanly and says where", async () => {
      await createStore(sql, config, ada, "Alpha");
      await sql`update stores set deadline_at = now() - interval '1 second', phase = 'release'`;
      await drain(stores());
      const failed = await row("alpha");
      expect(failed.status).toBe("failed");
      expect(failed.reason).toContain('timed out in phase "release"');
    });

    test("a failed helm install fails with the reason, and retry runs it again", async () => {
      await createStore(sql, config, ada, "Alpha");
      helm.script = ["fail"];
      kube.podProblemText = "mariadb-0: ImagePullBackOff";
      await drain(stores());
      const failed = await row("alpha");
      expect(failed.status).toBe("failed");
      expect(failed.reason).toContain("helm install failed");
      expect(failed.reason).toContain("ImagePullBackOff");
      const retried = await retryStore(sql, config, ada, failed.id);
      expect(retried).toMatchObject({ status: "provisioning", attempt: 2 });
      await drain(stores());
      expect((await row("alpha")).status).toBe("ready");
      await expectStatus(retryStore(sql, config, ada, failed.id), 409); // only failed stores retry
    });

    test("a namespace that exists and is not ours is never adopted and never deleted", async () => {
      kube.namespaces.set("store-alpha", { owner: "someone-else" });
      const { store } = await createStore(sql, config, ada, "Alpha");
      await drain(stores());
      expect((await row("alpha")).status).toBe("failed");
      expect((await row("alpha")).reason).toContain("not managed by Urumi");
      await deleteStore(sql, config, ada, store.id);
      await drain(stores());
      expect(await row("alpha")).toBeUndefined();
      expect(kube.namespaces.has("store-alpha")).toBe(true);
      expect(kube.calls).not.toContain("deleteNamespace:store-alpha");
    });
  });

  describe("teardown", () => {
    test("delete removes the registration first, then the release, the namespace and its volumes, then the row", async () => {
      const { store } = await createStore(sql, config, ada, "Alpha");
      await drain(stores());
      expect(gateway.servers.has("store_alpha")).toBe(true);
      await deleteStore(sql, config, ada, store.id);
      await drain(stores());
      expect(await row("alpha")).toBeUndefined();
      expect(gateway.calls.at(-1)).toBe("unregister:store_alpha");
      expect(gateway.servers.size).toBe(0);
      expect(helm.releases.size).toBe(0);
      expect(kube.namespaces.size).toBe(0);
      expect(kube.volumes.size).toBe(0);
      expect(kube.secrets.size).toBe(0);
      // order: the tools vanish before the workload does
      const order = [...gateway.calls, ...helm.uninstalls];
      expect(order.indexOf("unregister:store_alpha")).toBeLessThan(order.indexOf("store-alpha/store-alpha"));
    });

    test("a store deleted before its namespace exists is removed without touching Helm", async () => {
      const { store } = await createStore(sql, config, ada, "Alpha");
      await deleteStore(sql, config, ada, store.id); // still in provisioning/namespace: nothing has been created
      await drain(stores());
      expect(await row("alpha")).toBeUndefined();
      expect(helm.uninstalls).toEqual([]);
      expect(kube.namespaces.size).toBe(0);
    });

    test("a namespace created but never bound is bound before Helm is asked to uninstall", async () => {
      const { store } = await createStore(sql, config, ada, "Alpha");
      await kube.createNamespace("store-alpha", { "urumi.io/store": "alpha", "urumi.io/managed": "true" }); // crash right after create
      await deleteStore(sql, config, ada, store.id);
      await drain(stores());
      expect(await row("alpha")).toBeUndefined();
      expect(helm.uninstalls).toEqual(["store-alpha/store-alpha"]);
      expect(kube.namespaces.size).toBe(0);
    });

    test("deleting twice is the same as deleting once", async () => {
      const { store } = await createStore(sql, config, ada, "Alpha");
      await drain(stores());
      await deleteStore(sql, config, ada, store.id);
      const second = await deleteStore(sql, config, ada, store.id);
      expect(second.status).toBe("deleting");
      await drain(stores());
      expect(await row("alpha")).toBeUndefined();
    });

    test("a restart in the middle of a delete finishes the delete", async () => {
      const { store } = await createStore(sql, config, ada, "Alpha");
      await drain(stores());
      await deleteStore(sql, config, ada, store.id);
      await sql`update stores set phase = 'drain', lease_owner = 'dead-pod', lease_until = now() - interval '1 second'`;
      kube.terminating.set("store-alpha", 1);
      await drain(stores(2));
      expect(await row("alpha")).toBeUndefined();
      expect(kube.namespaces.size).toBe(0);
    });

    test("deleting a store that is still installing cancels the install and tears everything down", async () => {
      const { store } = await createStore(sql, config, ada, "Alpha");
      helm.script = ["hang"];
      const worker = stores();
      const running = worker.tick();
      await Bun.sleep(150);
      expect(helm.releases.get("store-alpha/store-alpha")).toBe("pending-install");
      await deleteStore(sql, config, ada, store.id);
      await running; // the heartbeat noticed the status change and aborted helm
      await drain(stores(2));
      expect(await row("alpha")).toBeUndefined();
      expect(helm.releases.size).toBe(0);
      expect(kube.namespaces.size).toBe(0);
    });

    test("a delete that cannot finish stays 'deleting' with a reason and is retried", async () => {
      const { store } = await createStore(sql, config, ada, "Alpha");
      await drain(stores());
      await deleteStore(sql, config, ada, store.id);
      kube.stuck.add("store-alpha"); // finalizers keep the namespace Terminating
      const worker = stores();
      for (let i = 0; i < 5; i++) { await sql`update stores set next_run_at = now()`; await worker.tick(); }
      const stuck = await row("alpha");
      expect(stuck.status).toBe("deleting");
      expect(stuck.reason).toContain("waiting for namespace store-alpha");
      kube.stuck.delete("store-alpha");
      await drain(worker);
      expect(await row("alpha")).toBeUndefined();
    });
  });

  describe("hosted servers", () => {
    test("image rules", () => {
      const regs = ["ghcr.io/", "urumi-"];
      expect(validateImage("ghcr.io/acme/tools:1.2.3", regs)).toBeNull();
      expect(validateImage("urumi-utility-mcp:local", regs)).toBeNull();
      expect(validateImage("ghcr.io/acme/tools@sha256:" + "a".repeat(64), regs)).toBeNull();
      expect(validateImage("ghcr.io/acme/tools:latest", regs)).toContain("latest");
      expect(validateImage("ghcr.io/acme/tools", regs)).toContain("tag or digest");
      expect(validateImage("evil.example/x:1", regs)).toContain("must come from");
      expect(validateImage("ghcr.io/acme/tools:1 --privileged", regs)).toContain("tag or digest");
      expect(validateImage("GHCR.io/Acme:1", regs)).toContain("tag or digest");
    });

    test("input validation and secret handling", async () => {
      const base = { slug: "hosted_util", displayName: "Util", image: "urumi-utility-mcp:local", size: "small" as const };
      await expectStatus(createHosted(sql, kube, config, ada.id, { ...base, slug: "Bad__Slug" }), 400);
      await expectStatus(createHosted(sql, kube, config, ada.id, { ...base, size: "huge" as never }), 400);
      await expectStatus(createHosted(sql, kube, config, ada.id, { ...base, env: { LD_PRELOAD: "x" } }), 400);
      await expectStatus(createHosted(sql, kube, config, ada.id, { ...base, env: { lower: "x" } }), 400);
      await expectStatus(createHosted(sql, kube, config, ada.id, { ...base, port: 80 }), 400);
      const created = await createHosted(sql, kube, config, ada.id, { ...base, env: { MODE: "demo" }, secretEnv: { API_TOKEN: "s3cret-value" } });
      expect(created).toMatchObject({ slug: "hosted_util", envNames: ["MODE"], secretNames: ["API_TOKEN"], status: "provisioning" });
      expect(JSON.stringify(await sql`select * from hosted_servers`)).not.toContain("s3cret-value"); // never in Postgres
      expect(kube.secrets.get("mcp-hosted/hosted-hosted-util-env")).toEqual({ API_TOKEN: "s3cret-value" });
      await expectStatus(createHosted(sql, kube, config, ada.id, base), 409);
      expect(kube.secrets.size).toBe(1); // the rejected duplicate did not leave or clobber a secret
    });

    test("deploy, register, then delete removes workload, secret and registration", async () => {
      const created = await createHosted(sql, kube, config, ada.id, { slug: "hosted_util", displayName: "Util", image: "urumi-utility-mcp:local", size: "medium", secretEnv: { API_TOKEN: "x" } });
      await drain(hosted(), "hosted_servers");
      expect((await sql`select status from hosted_servers`)[0].status).toBe("ready");
      expect(helm.installs[0]).toMatchObject({ release: "hosted-hosted-util", namespace: "mcp-hosted" });
      expect((helm.installs[0]!.values as any).server).toMatchObject({ image: "urumi-utility-mcp:local", pullPolicy: "Never", port: 8080, secretName: "hosted-hosted-util-env", resources: { limits: { memory: "256Mi" } } });
      expect(gateway.servers.get("hosted_util")).toMatchObject({ url: "http://mcp-hosted-util.mcp-hosted.svc.cluster.local:8080/mcp", managedBy: "hosted" });
      const { deleteHosted } = await import("./hosted.ts");
      await deleteHosted(sql, created.id);
      await drain(hosted(), "hosted_servers");
      expect((await sql`select * from hosted_servers`).length).toBe(0);
      expect(helm.releases.size).toBe(0);
      expect(kube.secrets.size).toBe(0);
      expect(gateway.servers.size).toBe(0);
    });
  });

  describe("http api", () => {
    const token = "provisioner-test-token";
    const call = (path: string, init: RequestInit & { as?: Who | null; auth?: string } = {}) => {
      const app = createApi(deps, token);
      const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${init.auth ?? token}` };
      if (init.as !== null) {
        const who = init.as ?? ada;
        Object.assign(headers, { "x-urumi-user-id": who.id, "x-urumi-username": who.username, "x-urumi-role": who.role });
      }
      return app.request(path, { ...init, headers });
    };

    test("needs the service token and a caller identity", async () => {
      expect((await call("/v1/stores", { auth: "wrong" })).status).toBe(401);
      expect((await call("/v1/stores", { as: null })).status).toBe(400);
      expect((await call("/v1/stores")).status).toBe(200);
    });

    test("create returns 201 then 200 for the same name, 429 over the cap, and hosted is admin only", async () => {
      expect((await call("/v1/stores", { method: "POST", body: JSON.stringify({ name: "Alpha" }) })).status).toBe(201);
      expect((await call("/v1/stores", { method: "POST", body: JSON.stringify({ name: "Alpha" }) })).status).toBe(200);
      for (const name of ["Beta", "Gamma"]) await call("/v1/stores", { method: "POST", body: JSON.stringify({ name }) });
      const over = await call("/v1/stores", { method: "POST", body: JSON.stringify({ name: "Delta" }) });
      expect(over.status).toBe(429);
      expect(((await over.json()) as { error: string }).error).toContain("limit");
      expect((await call("/v1/hosted", { as: bea })).status).toBe(403);
      expect((await call("/v1/hosted", { as: bea, method: "POST", body: "{}" })).status).toBe(403);
      const listed = (await (await call("/v1/hosted")).json()) as { registries: string[]; sizes: string[] };
      expect(listed.sizes).toEqual(["small", "medium", "large"]);
    });
  });
});
