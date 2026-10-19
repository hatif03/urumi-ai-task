import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Helm } from "./ports.ts";

// Thin wrapper over the helm binary. Helm talks to the API server with the pod's service account
// (in-cluster config) and keeps release state in Secrets inside the release's own namespace.

async function run(args: string[], signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["helm", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: "/tmp", HELM_CACHE_HOME: "/tmp/helm/cache", HELM_CONFIG_HOME: "/tmp/helm/config", HELM_DATA_HOME: "/tmp/helm/data" },
  });
  const kill = () => proc.kill();
  signal?.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } finally {
    signal?.removeEventListener("abort", kill);
  }
}

export function createHelm(): Helm {
  return {
    async status(release, namespace) {
      const result = await run(["status", release, "-n", namespace, "-o", "json"]);
      if (result.code !== 0) {
        if (/not found/i.test(result.stderr)) return null;
        throw new Error(`helm status: ${result.stderr.trim().slice(-300)}`);
      }
      return { status: String(JSON.parse(result.stdout).info?.status ?? "unknown") };
    },

    async upgradeInstall({ release, namespace, chart, values, timeoutSeconds, signal }) {
      // Values go through a 0600 temp file so they never appear in the process list.
      const dir = await mkdtemp(join(tmpdir(), "values-"));
      const file = join(dir, "values.json");
      try {
        await writeFile(file, JSON.stringify(values), { mode: 0o600 });
        const result = await run(["upgrade", "--install", release, chart, "-n", namespace, "-f", file, "--wait", "--wait-for-jobs", "--timeout", `${timeoutSeconds}s`], signal);
        if (result.code !== 0) throw new Error(result.stderr.trim().slice(-600) || `helm exited ${result.code}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },

    async uninstall(release, namespace) {
      const result = await run(["uninstall", release, "-n", namespace, "--wait", "--timeout", "120s"]);
      if (result.code !== 0 && !/not found/i.test(result.stderr)) throw new Error(`helm uninstall: ${result.stderr.trim().slice(-300)}`);
    },
  };
}
