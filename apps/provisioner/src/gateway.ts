import type { Gateway } from "./ports.ts";

// The provisioner registers and removes the MCP servers it deploys through the gateway's internal API.
// It holds no database credentials for the gateway's tables and cannot read tool results or user data.
export function createGateway(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): Gateway {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return {
    async register(server) {
      const response = await fetchImpl(`${baseUrl}/internal/servers/${server.slug}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ displayName: server.displayName, url: server.url, managedBy: server.managedBy, secret: server.secret }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await response.json().catch(() => ({}))) as { status?: string; error?: string };
      // 4xx is a mistake no retry fixes (slug taken by a hand-made server, URL rejected).
      if (response.status >= 400 && response.status < 500) throw Object.assign(new Error(`gateway refused the server: ${body.error ?? response.status}`), { permanent: true });
      if (!response.ok) throw new Error(`gateway answered ${response.status}`);
      return { status: body.status ?? "unknown" };
    },

    async unregister(slug) {
      const response = await fetchImpl(`${baseUrl}/internal/servers/${slug}`, { method: "DELETE", headers, signal: AbortSignal.timeout(20_000) });
      // 409: the slug belongs to a server this provisioner did not create. Nothing to remove.
      if (!response.ok && response.status !== 409) throw new Error(`gateway answered ${response.status}`);
    },
  };
}
