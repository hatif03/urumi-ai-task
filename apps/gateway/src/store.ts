import type { Grant } from "./policy.ts";
import type { OAuthClient, OAuthCode, OAuthGrantView, OAuthToken } from "./types.ts";
import type { Actor, ApiKey, AuditFilter, AuditRow, AuditView, CachedTool, CredentialType, McpServerRow, Outcome, Role, ServerStatus, User } from "./types.ts";

export type NewServer = {
  slug: string;
  displayName: string;
  url: string;
  enabled?: boolean;
  credentialType?: CredentialType;
  credentialHeaderName?: string | null;
  credentialCiphertext?: string | null;
  managedBy?: string | null;
};

export interface Store {
  ping(): Promise<void>;
  getUserByUsername(username: string): Promise<User | null>;
  getUser(id: string): Promise<User | null>;
  listUsers(): Promise<User[]>;
  insertUser(input: { username: string; passwordHash: string; role: Role }): Promise<User>;
  setUserDisabled(id: string, disabled: boolean): Promise<void>;
  setUserPassword(id: string, passwordHash: string): Promise<void>;
  setUserRole(id: string, role: Role): Promise<void>;
  countActiveAdmins(): Promise<number>;
  insertApiKey(input: { userId: string; prefix: string; keyHash: string; label: string }): Promise<ApiKey>;
  listApiKeys(userId: string): Promise<ApiKey[]>;
  listAllApiKeys(): Promise<Array<ApiKey & { username: string }>>;
  findLiveKeyByPrefix(prefix: string): Promise<ApiKey | null>;
  revokeApiKey(id: string, userId: string | null): Promise<boolean>;
  touchApiKey(id: string): Promise<void>;
  listServers(): Promise<McpServerRow[]>;
  getServer(id: string): Promise<McpServerRow | null>;
  getServerBySlug(slug: string): Promise<McpServerRow | null>;
  insertServer(input: NewServer): Promise<McpServerRow>;
  updateServer(id: string, patch: Partial<NewServer> & { enabled?: boolean; status?: ServerStatus; statusDetail?: string }): Promise<McpServerRow | null>;
  deleteServer(id: string): Promise<void>;
  claimProbe(id: string, staleMs: number): Promise<boolean>;
  setStatus(id: string, status: ServerStatus, detail: string): Promise<void>;
  getCachedTools(serverId: string): Promise<CachedTool[]>;
  replaceTools(serverId: string, tools: Array<Omit<CachedTool, "serverId" | "fetchedAt">>): Promise<void>;
  withServerLock<T>(serverId: string, fn: () => Promise<T>): Promise<T>;
  insertAudit(input: Omit<AuditRow, "id" | "at"> & { at?: string }): Promise<AuditRow>;
  listAudit(filter: AuditFilter): Promise<AuditView[]>;
  // Token bucket shared by every replica. key is "key:<id>", "login:<ip>", "chat:<userId>".
  upsertOAuthClient(client: Omit<OAuthClient, "createdAt">): Promise<void>;
  getOAuthClient(clientId: string): Promise<OAuthClient | null>;
  insertOAuthCode(code: Omit<OAuthCode, "usedAt">): Promise<void>;
  // Marks the code used if it was unused and unexpired. A second use reports "replayed" with the
  // family so the caller can revoke what the first use issued.
  consumeOAuthCode(codeHash: string): Promise<{ status: "ok"; code: OAuthCode } | { status: "replayed"; familyId: string } | { status: "invalid" }>;
  insertOAuthToken(token: Omit<OAuthToken, "revokedAt" | "createdAt" | "lastUsedAt">): Promise<OAuthToken>;
  findOAuthToken(tokenHash: string): Promise<OAuthToken | null>;
  // Revokes one token only if it is still live; false means it was already revoked (a refresh reuse).
  revokeOAuthToken(id: string): Promise<boolean>;
  revokeOAuthFamily(familyId: string): Promise<void>;
  touchOAuthToken(id: string): Promise<void>;
  listOAuthGrants(userId: string): Promise<OAuthGrantView[]>;
  listGrants(): Promise<Grant[]>;
  upsertGrant(input: Omit<Grant, "id"> & { createdBy: string | null }): Promise<Grant>;
  deleteGrant(id: string): Promise<boolean>;
  consumeToken(key: string, perMinute: number): Promise<boolean>;
}

export type { Actor, Outcome };
