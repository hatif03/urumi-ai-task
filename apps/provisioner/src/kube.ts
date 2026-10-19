import { readFileSync } from "node:fs";
import type { Kube } from "./ports.ts";

// A deliberately small Kubernetes REST client: only the calls the provisioner makes, using the pod's
// service-account token. No kubectl binary and no client library, so the image stays small and the
// list of API calls (and therefore the RBAC the chart grants) is the list below.

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";

type Options = { host?: string; token?: string; ca?: string; fetchImpl?: typeof fetch };

export class KubeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function createKube(options: Options = {}): Kube {
  const host = options.host ?? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT ?? 443}`;
  const read = (path: string) => readFileSync(path, "utf8");
  const ca = options.ca ?? (() => { try { return read(`${SA}/ca.crt`); } catch { return undefined; } })();
  const doFetch = options.fetchImpl ?? fetch;

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    // The token is re-read each call: projected service-account tokens rotate.
    const token = options.token ?? read(`${SA}/token`).trim();
    const response = await doFetch(`${host}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
      ...(ca ? { tls: { ca } } : {}),
    } as RequestInit);
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    return { status: response.status, json };
  }

  const fail = (what: string, status: number, json: { message?: string }) => new KubeError(`${what}: ${status} ${json.message ?? ""}`.trim(), status);

  return {
    async getNamespace(name) {
      const { status, json } = await call("GET", `/api/v1/namespaces/${name}`);
      if (status === 404) return null;
      if (status !== 200) throw fail(`get namespace ${name}`, status, json);
      // A namespace that is being deleted still exists; treat Terminating as present so callers wait.
      return { labels: json.metadata?.labels ?? {} };
    },

    async createNamespace(name, labels) {
      const { status, json } = await call("POST", "/api/v1/namespaces", { apiVersion: "v1", kind: "Namespace", metadata: { name, labels } });
      if (status !== 201 && status !== 409) throw fail(`create namespace ${name}`, status, json);
    },

    async deleteNamespace(name) {
      const { status, json } = await call("DELETE", `/api/v1/namespaces/${name}`);
      if (status !== 200 && status !== 202 && status !== 404) throw fail(`delete namespace ${name}`, status, json);
    },

    async ensureRoleBinding(namespace, name, clusterRole) {
      const { status, json } = await call("POST", `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`, {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: { name },
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: clusterRole },
        subjects: [{ kind: "ServiceAccount", name: process.env.PROVISIONER_SERVICE_ACCOUNT ?? "provisioner", namespace: process.env.POD_NAMESPACE ?? "platform" }],
      });
      if (status !== 201 && status !== 409) throw fail(`bind ${clusterRole} in ${namespace}`, status, json);
    },

    async getSecret(namespace, name) {
      const { status, json } = await call("GET", `/api/v1/namespaces/${namespace}/secrets/${name}`);
      if (status === 404) return null;
      if (status !== 200) throw fail(`get secret ${name}`, status, json);
      return Object.fromEntries(Object.entries((json.data ?? {}) as Record<string, string>).map(([key, value]) => [key, Buffer.from(value, "base64").toString()]));
    },

    async createSecret(namespace, name, data, labels) {
      const { status, json } = await call("POST", `/api/v1/namespaces/${namespace}/secrets`, {
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        metadata: { name, labels },
        stringData: data,
      });
      if (status !== 201 && status !== 409) throw fail(`create secret ${name}`, status, json);
    },

    async deleteSecret(namespace, name) {
      const { status, json } = await call("DELETE", `/api/v1/namespaces/${namespace}/secrets/${name}`);
      if (status !== 200 && status !== 202 && status !== 404) throw fail(`delete secret ${name}`, status, json);
    },

    async volumesFor(namespace) {
      const { status, json } = await call("GET", "/api/v1/persistentvolumes");
      if (status !== 200) throw fail("list volumes", status, json);
      return (json.items ?? []).filter((pv: any) => pv.spec?.claimRef?.namespace === namespace).map((pv: any) => pv.metadata.name as string);
    },

    async podProblems(namespace) {
      const { status, json } = await call("GET", `/api/v1/namespaces/${namespace}/pods`);
      if (status !== 200) return "";
      const lines: string[] = [];
      for (const pod of json.items ?? []) {
        const ready = (pod.status?.conditions ?? []).some((c: any) => c.type === "Ready" && c.status === "True");
        if (ready || pod.status?.phase === "Succeeded") continue;
        const waiting = (pod.status?.containerStatuses ?? []).map((c: any) => c.state?.waiting?.reason).filter(Boolean)[0];
        lines.push(`${pod.metadata.name}: ${waiting ?? pod.status?.phase ?? "unknown"}`);
      }
      return lines.slice(0, 5).join("; ");
    },
  };
}
