import type { Gateway, Helm, Kube, ManagedServer } from "./ports.ts";

// In-memory stand-ins for the cluster, Helm and the gateway. They record what happened so a test can
// assert that a crash and a resume produced the same cluster as a clean run.

export class FakeKube implements Kube {
  namespaces = new Map<string, Record<string, string>>();
  stuck = new Set<string>(); // namespaces whose finalizers never finish
  terminating = new Map<string, number>(); // namespace -> getNamespace calls left before it disappears
  secrets = new Map<string, Record<string, string>>();
  bindings: string[] = [];
  volumes = new Map<string, string>(); // pv name -> namespace
  calls: string[] = [];
  failNext: Record<string, number> = {};
  podProblemText = "";

  private maybeFail(op: string) {
    if ((this.failNext[op] ?? 0) > 0) {
      this.failNext[op]!--;
      throw new Error(`injected failure in ${op}`);
    }
  }

  async getNamespace(name: string) {
    this.calls.push(`getNamespace:${name}`);
    const labels = this.namespaces.get(name);
    if (!labels) return null;
    const left = this.terminating.get(name);
    if (left !== undefined && !this.stuck.has(name)) {
      if (left <= 0) {
        this.namespaces.delete(name);
        this.terminating.delete(name);
        for (const [pv, ns] of this.volumes) if (ns === name) this.volumes.delete(pv);
        for (const key of [...this.secrets.keys()]) if (key.startsWith(`${name}/`)) this.secrets.delete(key);
        return null;
      }
      this.terminating.set(name, left - 1);
    }
    return { labels };
  }

  async createNamespace(name: string, labels: Record<string, string>) {
    this.maybeFail("createNamespace");
    this.calls.push(`createNamespace:${name}`);
    if (!this.namespaces.has(name)) this.namespaces.set(name, labels);
  }

  async deleteNamespace(name: string) {
    this.calls.push(`deleteNamespace:${name}`);
    if (this.namespaces.has(name)) this.terminating.set(name, 2);
  }

  async ensureRoleBinding(namespace: string, name: string, clusterRole: string) {
    this.calls.push(`bind:${namespace}:${name}:${clusterRole}`);
    if (!this.bindings.includes(`${namespace}/${name}`)) this.bindings.push(`${namespace}/${name}`);
  }

  async getSecret(namespace: string, name: string) {
    return this.secrets.get(`${namespace}/${name}`) ?? null;
  }

  async createSecret(namespace: string, name: string, data: Record<string, string>, _labels?: Record<string, string>) {
    this.maybeFail("createSecret");
    this.calls.push(`createSecret:${namespace}/${name}`);
    if (!this.secrets.has(`${namespace}/${name}`)) this.secrets.set(`${namespace}/${name}`, data);
  }

  async deleteSecret(namespace: string, name: string) {
    this.calls.push(`deleteSecret:${namespace}/${name}`);
    this.secrets.delete(`${namespace}/${name}`);
  }

  async volumesFor(namespace: string) {
    return [...this.volumes].filter(([, ns]) => ns === namespace).map(([pv]) => pv);
  }

  async podProblems() {
    return this.podProblemText;
  }
}

export class FakeHelm implements Helm {
  releases = new Map<string, string>(); // "ns/release" -> status
  installs: Array<{ release: string; namespace: string; values: Record<string, unknown> }> = [];
  uninstalls: string[] = [];
  // Behaviour of the next upgradeInstall calls, consumed in order: "ok", "fail", "hang" (wait for abort),
  // "crash" (leave the release pending-install and throw, as a killed process would).
  script: Array<"ok" | "fail" | "hang" | "crash"> = [];
  constructor(private readonly kube: FakeKube) {}

  private needBinding(namespace: string) {
    if (!this.kube.bindings.includes(`${namespace}/urumi-provisioner`)) throw new Error(`forbidden: the provisioner has no role in ${namespace}`);
  }

  async status(release: string, namespace: string) {
    this.needBinding(namespace);
    const status = this.releases.get(`${namespace}/${release}`);
    return status ? { status } : null;
  }

  async upgradeInstall(input: { release: string; namespace: string; chart: string; values: Record<string, unknown>; timeoutSeconds: number; signal?: AbortSignal }) {
    this.needBinding(input.namespace);
    const key = `${input.namespace}/${input.release}`;
    const mode = this.script.shift() ?? "ok";
    this.releases.set(key, "pending-install");
    if (mode === "crash") throw new Error("process killed");
    if (mode === "fail") {
      this.releases.set(key, "failed");
      throw new Error("Error: timed out waiting for the condition");
    }
    if (mode === "hang") {
      await new Promise<void>((_, reject) => {
        input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    this.releases.set(key, "deployed");
    this.installs.push({ release: input.release, namespace: input.namespace, values: input.values });
    // A real install creates PVCs; local-path turns them into PVs bound to the namespace.
    this.kube.volumes.set(`pv-${input.namespace}-1`, input.namespace);
  }

  async uninstall(release: string, namespace: string) {
    this.needBinding(namespace);
    this.uninstalls.push(`${namespace}/${release}`);
    this.releases.delete(`${namespace}/${release}`);
  }
}

export class FakeGateway implements Gateway {
  servers = new Map<string, ManagedServer>();
  statuses: string[] = []; // consumed per register call; empty means "connected"
  calls: string[] = [];

  async register(server: ManagedServer) {
    this.calls.push(`register:${server.slug}`);
    this.servers.set(server.slug, server);
    return { status: this.statuses.shift() ?? "connected" };
  }

  async unregister(slug: string) {
    this.calls.push(`unregister:${slug}`);
    this.servers.delete(slug);
  }
}
