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
  managedBy: string | null;
  status: ServerStatus;
  statusDetail: string;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ToolAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };

export type CachedTool = {
  serverId: string;
  upstreamName: string;
  description: string;
  inputSchema: unknown;
  annotations: ToolAnnotations;
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

// Audit rows as shown to an admin: the user's name is joined in, so the log answers "who".
export type AuditView = AuditRow & { username: string | null };

export type AuditFilter = {
  userId?: string;
  serverSlug?: string;
  toolName?: string;
  outcome?: Outcome;
  from?: string;
  to?: string;
  beforeId?: number;
  limit?: number;
};

export type OAuthClient = { clientId: string; name: string; redirectUris: string[]; kind: "dcr" | "cimd"; createdAt: string };

export type OAuthCode = {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  familyId: string;
  expiresAt: string;
  usedAt: string | null;
};

export type OAuthToken = {
  id: string;
  tokenHash: string;
  kind: "access" | "refresh";
  familyId: string;
  clientId: string;
  userId: string;
  resource: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

export type OAuthGrantView = { familyId: string; clientId: string; clientName: string; createdAt: string; lastUsedAt: string | null };
