export type Role = "admin" | "member";

export type SessionUser = { id: string; username: string; role: Role; disabledAt: string | null };

export type ServerRow = {
  id: string;
  slug: string;
  displayName: string;
  status: "connected" | "unreachable" | "disabled";
  statusDetail: string;
  enabled: boolean;
  toolCount: number;
  url?: string;
  credentialType: string;
  credentialSet: boolean;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error || response.statusText);
  return body as T;
}

export const api = {
  me: () => request<{ user: SessionUser }>("/api/me"),
  login: (username: string, password: string) => request<{ user: SessionUser }>("/api/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request("/api/logout", { method: "POST", body: "{}" }),
  servers: () => request<{ servers: ServerRow[]; llmConfigured: boolean }>("/api/servers"),
  serverTools: (id: string) => request<{ tools: Array<{ name: string; description: string }> }>(`/api/servers/${id}/tools`),
  createServer: (body: unknown) => request("/api/servers", { method: "POST", body: JSON.stringify(body) }),
  updateServer: (id: string, body: unknown) => request(`/api/servers/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteServer: (id: string) => request(`/api/servers/${id}`, { method: "DELETE" }),
  probe: (id: string) => request(`/api/servers/${id}/probe`, { method: "POST", body: "{}" }),
  members: () => request<{ members: Array<SessionUser & { liveKey: boolean }> }>("/api/members"),
  createMember: (username: string, password: string) => request("/api/members", { method: "POST", body: JSON.stringify({ username, password }) }),
  disableMember: (id: string) => request(`/api/members/${id}/disable`, { method: "POST", body: "{}" }),
  keys: () => request<{ keys: Array<{ id: string; prefix: string; label: string; createdAt: string; revokedAt: string | null; lastUsedAt: string | null }> }>("/api/api-keys"),
  createKey: (label: string) => request<{ token: string }>("/api/api-keys", { method: "POST", body: JSON.stringify({ label }) }),
  revokeKey: (id: string) => request(`/api/api-keys/${id}`, { method: "DELETE" }),
  audit: (query: string) => request<{ audit: Array<Record<string, unknown>> }>(`/api/audit${query}`),
};
