export type Role = "admin" | "member";
export type ServerStatus = "connected" | "unreachable" | "disabled";
export type CredentialType = "none" | "bearer" | "header";
export type Outcome = "success" | "error" | "timeout" | "unreachable" | "denied" | "unauthorized";
export type Actor = "chat" | "mcp";

export type User = {
  id: string;
  username: string;
  passwordHash: string;
  role: Role;
  disabledAt: string | null;
  createdAt: string;
};

export type ApiKey = {
  id: string;
  userId: string;
  prefix: string;
  keyHash: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

export type McpServerRow = {
  id: string;
  slug: string;
  displayName: string;
  url: string;
  enabled: boolean;
  credentialType: CredentialType;
  credentialHeaderName: string | null;
  credentialCiphertext: string | null;
  status: ServerStatus;
  statusDetail: string;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CachedTool = {
  serverId: string;
  upstreamName: string;
  description: string;
  inputSchema: unknown;
  fetchedAt: string;
};

export type AuditRow = {
  id: number;
  at: string;
  userId: string | null;
  apiKeyId: string | null;
  actor: Actor;
  serverSlug: string | null;
  toolName: string | null;
  durationMs: number | null;
  outcome: Outcome;
  errorCode: string | null;
  traceId: string;
};

export type AuditFilter = {
  userId?: string;
  serverSlug?: string;
  outcome?: Outcome;
  from?: string;
  to?: string;
  limit?: number;
};
