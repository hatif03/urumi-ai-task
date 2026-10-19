import type { SQL } from "bun";
import { isSlug } from "@urumi/mcp-names";
import type { Kube } from "./ports.ts";
import { Fail, Retry, type Config, type Step } from "./worker.ts";
import type { Work } from "./db.ts";

// A hosted MCP server is an image the admin names. The platform runs it in the namespace mcp-hosted
// as one Helm release (chart urumi-hosted-mcp): a Deployment, a Service, a NetworkPolicy that admits
// only the gateway, and an env Secret. Removing the server removes all of them and the registration.
//   provisioning: release -> register -> ready
//   deleting:     unregister -> uninstall -> secret -> forget

export const SIZES = {
  small: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "250m", memory: "128Mi" } },
  medium: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
  large: { requests: { cpu: "250m", memory: "256Mi" }, limits: { cpu: "1", memory: "512Mi" } },
} as const;
export type Size = keyof typeof SIZES;

export class HostedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// Repository path segments, then a tag or a digest. "latest" and untagged references are refused: the
// image that runs must be the image that was reviewed.
const IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127}|@sha256:[a-f0-9]{64})$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const FORBIDDEN_ENV = /^(PATH|HOME|LD_.*|NODE_OPTIONS|BUN_.*|.*_PROXY|PORT|METRICS_PORT|OTEL_.*|KUBERNETES_.*)$/i;

export function validateImage(image: string, registries: string[]): string | null {
  if (!IMAGE.test(image)) return "image must be a repository with an explicit tag or digest";
  if (/:latest$/.test(image)) return "the latest tag is not allowed; use a version tag or a digest";
  if (!registries.some((prefix) => image.startsWith(prefix))) return `image must come from one of: ${registries.join(", ")}`;
  return null;
}

function validateEnv(env: Record<string, string>, label: string): string | null {
  const entries = Object.entries(env);
  if (entries.length > 20) return `${label}: at most 20 variables`;
  for (const [key, value] of entries) {
    if (!ENV_NAME.test(key)) return `${label}: ${key} is not a valid variable name`;
    if (FORBIDDEN_ENV.test(key)) return `${label}: ${key} is reserved`;
    if (typeof value !== "string" || value.length > 4000) return `${label}: ${key} must be a string of at most 4000 characters`;
  }
  return null;
}

export type HostedInput = { slug: string; displayName: string; image: string; size: Size; port?: number; env?: Record<string, string>; secretEnv?: Record<string, string> };

export const secretNameFor = (slug: string) => `hosted-${slug.replace(/_/g, "-")}-env`;
export const releaseNameFor = (slug: string) => `hosted-${slug.replace(/_/g, "-")}`;
export const serviceNameFor = (slug: string) => `mcp-${slug.replace(/_/g, "-")}`;

export function presentHosted(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    slug: String(row.slug),
    displayName: String(row.display_name),
    image: String(row.image),
    size: String(row.size),
    port: Number(row.port),
    envNames: Object.keys((row.env ?? {}) as object),
    secretNames: (row.secret_keys ?? []) as string[],
    status: String(row.status),
    phase: String(row.phase),
    reason: String(row.reason ?? ""),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

export async function createHosted(sql: SQL, kube: Kube, config: Config, adminId: string, input: HostedInput) {
  if (!input.slug || !isSlug(input.slug)) throw new HostedError("slug must be lowercase words joined by single underscores, 2-32 characters", 400);
  if (!input.displayName?.trim()) throw new HostedError("display name is required", 400);
  if (!(input.size in SIZES)) throw new HostedError("size must be small, medium or large", 400);
  const imageProblem = validateImage(input.image ?? "", config.hostedRegistries);
  if (imageProblem) throw new HostedError(imageProblem, 400);
  const port = input.port ?? 8080;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new HostedError("port must be between 1024 and 65535", 400);
  const env = input.env ?? {};
  const secretEnv = input.secretEnv ?? {};
  const envProblem = validateEnv(env, "env") ?? validateEnv(secretEnv, "secretEnv");
  if (envProblem) throw new HostedError(envProblem, 400);
  if (Object.keys(env).some((key) => key in secretEnv)) throw new HostedError("a variable cannot be both plain and secret", 400);

  if ((await sql`select 1 from hosted_servers where slug = ${input.slug}`).length) throw new HostedError("a hosted server with that slug exists", 409);
  // Secret values go straight into a Kubernetes Secret and never into Postgres or the release values.
  const secretName = secretNameFor(input.slug);
  if (Object.keys(secretEnv).length) await kube.createSecret(config.hostedNamespace, secretName, secretEnv, { "urumi.io/hosted": input.slug });
  try {
    const row = (await sql`
      insert into hosted_servers (id, slug, display_name, image, size, port, env, secret_keys, created_by, status, phase, deadline_at)
      values (${crypto.randomUUID()}::uuid, ${input.slug}, ${input.displayName.trim().slice(0, 80)}, ${input.image}, ${input.size}, ${port}, ${JSON.stringify(env)}::text::jsonb,
              ${JSON.stringify(Object.keys(secretEnv))}::text::jsonb, ${adminId}::uuid, 'provisioning', 'release', now() + (${config.provisionTimeoutSeconds} * interval '1 second'))
      returning *`)[0];
    return presentHosted(row);
  } catch (error) {
    if (Object.keys(secretEnv).length) await kube.deleteSecret(config.hostedNamespace, secretName).catch(() => undefined);
    throw error;
  }
}

export async function listHosted(sql: SQL) {
  return (await sql`select * from hosted_servers order by created_at desc`).map(presentHosted);
}

export async function deleteHosted(sql: SQL, id: string) {
  const row = (await sql`select * from hosted_servers where id = ${id}::uuid`.catch(() => []))[0];
  if (!row) throw new HostedError("hosted server not found", 404);
  if (row.status === "deleting") return presentHosted(row);
  return presentHosted((await sql`update hosted_servers set status = 'deleting', phase = 'unregister', reason = '', next_run_at = now(), updated_at = now() where id = ${id}::uuid returning *`)[0]);
}

export async function retryHosted(sql: SQL, config: Config, id: string) {
  const row = (await sql`
    update hosted_servers set status = 'provisioning', phase = 'release', reason = '', attempt = attempt + 1, next_run_at = now(),
      deadline_at = now() + (${config.provisionTimeoutSeconds} * interval '1 second'), updated_at = now()
    where id = ${id}::uuid and status = 'failed' returning *`.catch(() => []))[0];
  if (!row) throw new HostedError("only a failed hosted server can be retried", 409);
  return presentHosted(row);
}

type HostedRow = { slug: string; image: string; size: Size; port: number; env: Record<string, string>; secret_keys: string[] };
const rowOf = (work: Work) => work.raw as unknown as HostedRow;

export function hostedSteps(): Record<string, Step> {
  return {
    "provisioning:release": async ({ work, deps, signal }) => {
      const row = rowOf(work);
      const { config } = deps;
      const release = releaseNameFor(row.slug);
      const current = await deps.helm.status(release, config.hostedNamespace);
      if (current && current.status !== "deployed") await deps.helm.uninstall(release, config.hostedNamespace);
      if (row.secret_keys.length && !(await deps.kube.getSecret(config.hostedNamespace, secretNameFor(row.slug)))) {
        throw new Fail("the secret for this server is missing; delete the server and create it again");
      }
      const remaining = Math.floor((work.deadlineAt.getTime() - Date.now()) / 1000);
      if (remaining < 45) throw new Fail("not enough time left to deploy the server");
      try {
        await deps.helm.upgradeInstall({
          release,
          namespace: config.hostedNamespace,
          chart: config.hostedChart,
          timeoutSeconds: Math.min(remaining - 15, config.maxHelmSeconds),
          values: {
            ...config.hostedValues,
            server: { slug: row.slug, name: serviceNameFor(row.slug), image: row.image, pullPolicy: config.hostedPullPolicy, port: row.port, env: row.env, secretName: row.secret_keys.length ? secretNameFor(row.slug) : "", resources: SIZES[row.size] },
          },
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        const problems = await deps.kube.podProblems(config.hostedNamespace).catch(() => "");
        throw new Fail(`helm install failed: ${(error instanceof Error ? error.message : String(error)).slice(-400)}${problems ? ` | ${problems}` : ""}`);
      }
      return { next: "register" };
    },

    "provisioning:register": async ({ work, deps }) => {
      const row = rowOf(work);
      const url = `http://${serviceNameFor(row.slug)}.${deps.config.hostedNamespace}.svc.cluster.local:${row.port}/mcp`;
      const result = await deps.gateway.register({ slug: row.slug, displayName: String(work.raw.display_name), url, managedBy: "hosted" });
      if (result.status !== "connected") throw new Retry(`gateway cannot reach the hosted server yet (${result.status})`, 3);
      return { ready: true };
    },

    "deleting:unregister": async ({ work, deps }) => {
      await deps.gateway.unregister(rowOf(work).slug);
      return { next: "uninstall" };
    },

    "deleting:uninstall": async ({ work, deps }) => {
      await deps.helm.uninstall(releaseNameFor(rowOf(work).slug), deps.config.hostedNamespace);
      return { next: "secret" };
    },

    "deleting:secret": async ({ work, deps }) => {
      await deps.kube.deleteSecret(deps.config.hostedNamespace, secretNameFor(rowOf(work).slug));
      return { forget: true };
    },
  };
}
