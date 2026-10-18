export type Role = "admin" | "member";

export type SessionUser = { id: string; username: string; role: Role; disabledAt: string | null; createdAt?: string };

export type ServerStatus = "connected" | "unreachable" | "disabled";

export type ServerRow = {
  id: string;
  slug: string;
  displayName: string;
  status: ServerStatus;
  statusDetail: string;
  enabled: boolean;
  toolCount: number;
  url?: string;
  credentialType: "none" | "bearer" | "header";
  credentialHeaderName: string | null;
  credentialSet: boolean;
  lastCheckedAt: string | null;
  // Not in the API yet; present once the provisioner registers servers.
  managedBy?: "store" | "hosted" | null;
};

export type ToolRow = { name: string; upstreamName: string; description: string; readOnly: boolean; allowed: boolean; reason: string };

export type KeyRow = { id: string; prefix: string; label: string; createdAt: string; revokedAt: string | null; lastUsedAt: string | null };

export type Member = SessionUser & { keys: KeyRow[] };

export type Grant = { id: string; subjectType: "role" | "user"; subject: string; serverSlug: string; toolName: string; effect: "allow" | "deny" };

export type AuditEntry = {
  id: number;
  at: string;
  userId: string | null;
  username: string | null;
  actor: "chat" | "mcp";
  serverSlug: string | null;
  toolName: string | null;
  durationMs: number | null;
  outcome: "success" | "error" | "timeout" | "unreachable" | "denied" | "unauthorized";
  errorCode: string | null;
  traceId: string;
};

export type OAuthGrant = { familyId: string; clientId: string; clientName: string; createdAt: string; lastUsedAt: string | null };

export type StoreStatus = "provisioning" | "ready" | "failed" | "deleting";
export type StoreRow = {
  id: string;
  name: string;
  slug: string;
  status: StoreStatus;
  phase: string;
  reason: string | null;
  url: string | null;
  mcpSlug: string | null;
  createdAt: string;
  updatedAt: string;
  ownerName?: string;
  attempt: number;
  deadlineAt: string | null;
};

export type HostedRow = { id: string; slug: string; displayName: string; image: string; size: string; status: string; reason: string | null; createdAt: string };

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

// 404 and 501 on the stores and hosted routes mean "this gateway does not provide that yet".
export const isUnavailable = (error: unknown) => error instanceof ApiError && (error.status === 404 || error.status === 501);

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    credentials: "include",
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    // A session that expired mid-use sends the user to the login page. /api/login and the initial
    // /api/me probe expect a 401, so they are left to their callers.
    if (response.status === 401 && path !== "/api/login" && path !== "/api/me") window.location.assign("/login");
    throw new ApiError(body.error || response.statusText || `request failed (${response.status})`, response.status);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const post = (body: unknown = {}): RequestInit => ({ method: "POST", ...json(body) });
const verb = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : json(body)) });

export const api = {
  me: () => request<{ user: SessionUser }>("/api/me"),
  login: (username: string, password: string) => request<{ user: SessionUser }>("/api/login", post({ username, password })),
  logout: () => request("/api/logout", post()),
  changePassword: (current: string, next: string) => request("/api/me/password", post({ current, next })),
  status: () => request<{ llmConfigured: boolean }>("/api/status"),

  servers: (signal?: AbortSignal) => request<{ servers: ServerRow[] }>("/api/servers", { signal }),
  serverTools: (id: string, signal?: AbortSignal) => request<{ tools: ToolRow[] }>(`/api/servers/${id}/tools`, { signal }),
  createServer: (body: unknown) => request("/api/servers", post(body)),
  updateServer: (id: string, body: unknown) => request(`/api/servers/${id}`, verb("PATCH", body)),
  deleteServer: (id: string) => request(`/api/servers/${id}`, verb("DELETE")),
  probe: (id: string) => request(`/api/servers/${id}/probe`, post()),

  keys: () => request<{ keys: KeyRow[] }>("/api/api-keys"),
  createKey: (label: string) => request<{ key: KeyRow; token: string }>("/api/api-keys", post({ label })),
  revokeKey: (id: string) => request(`/api/api-keys/${id}`, verb("DELETE")),
  oauthGrants: () => request<{ grants: OAuthGrant[] }>("/api/oauth/grants"),
  revokeOauthGrant: (familyId: string) => request(`/api/oauth/grants/${familyId}`, verb("DELETE")),

  members: () => request<{ members: Member[] }>("/api/members"),
  createMember: (username: string, password: string, role: Role) => request("/api/members", post({ username, password, role })),
  patchMember: (id: string, body: { disabled?: boolean; role?: Role }) => request(`/api/members/${id}`, verb("PATCH", body)),
  resetPassword: (id: string, password: string) => request(`/api/members/${id}/password`, post({ password })),

  grants: () => request<{ grants: Grant[] }>("/api/grants"),
  putGrant: (body: Omit<Grant, "id">) => request("/api/grants", verb("PUT", body)),
  deleteGrant: (id: string) => request(`/api/grants/${id}`, verb("DELETE")),

  audit: (query: URLSearchParams, signal?: AbortSignal) => request<{ audit: AuditEntry[]; nextBeforeId: number | null }>(`/api/audit?${query}`, { signal }),

  stores: (signal?: AbortSignal) => request<{ stores: StoreRow[]; limits: { maxPerUser: number; used: number } }>("/api/stores", { signal }),
  createStore: (name: string) => request<{ store: StoreRow }>("/api/stores", post({ name })),
  retryStore: (id: string) => request(`/api/stores/${id}/retry`, post()),
  deleteStore: (id: string) => request(`/api/stores/${id}`, verb("DELETE")),

  hosted: (signal?: AbortSignal) => request<{ hosted: HostedRow[]; registries: string[]; sizes: string[] }>("/api/hosted", { signal }),
  createHosted: (body: unknown) => request("/api/hosted", post(body)),
  deleteHosted: (id: string) => request(`/api/hosted/${id}`, verb("DELETE")),
};
