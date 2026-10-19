// The three things the provisioner talks to, as interfaces. The real implementations are in kube.ts,
// helm.ts and gateway.ts; tests use in-memory fakes so a crash can be injected at any step.

export type ReleaseStatus = { status: string };

export interface Helm {
  status(release: string, namespace: string): Promise<ReleaseStatus | null>;
  upgradeInstall(input: { release: string; namespace: string; chart: string; values: Record<string, unknown>; timeoutSeconds: number; signal?: AbortSignal }): Promise<void>;
  // "release not found" is success: deleting twice is the same as deleting once.
  uninstall(release: string, namespace: string): Promise<void>;
}

export interface Kube {
  getNamespace(name: string): Promise<{ labels: Record<string, string> } | null>;
  // Already exists is success.
  createNamespace(name: string, labels: Record<string, string>): Promise<void>;
  deleteNamespace(name: string): Promise<void>;
  // Grants the provisioner's own service account a ClusterRole inside one namespace, nowhere else.
  ensureRoleBinding(namespace: string, name: string, clusterRole: string): Promise<void>;
  getSecret(namespace: string, name: string): Promise<Record<string, string> | null>;
  // Already exists is success and the stored values are left alone.
  createSecret(namespace: string, name: string, data: Record<string, string>, labels: Record<string, string>): Promise<void>;
  deleteSecret(namespace: string, name: string): Promise<void>;
  // Names of PersistentVolumes still bound to a claim in this namespace.
  volumesFor(namespace: string): Promise<string[]>;
  // One line per pod that is not Ready, for a failure message.
  podProblems(namespace: string): Promise<string>;
}

export type ManagedServer = { slug: string; displayName: string; url: string; managedBy: "store" | "hosted"; secret?: string };

export interface Gateway {
  // Idempotent. Returns the status the gateway measured after probing the server.
  register(server: ManagedServer): Promise<{ status: string }>;
  unregister(slug: string): Promise<void>;
}
