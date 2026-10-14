import type { Actor, ApiKey, AuditFilter, AuditRow, CachedTool, CredentialType, McpServerRow, Outcome, Role, ServerStatus, User } from "./types.ts";

export type NewServer = {
  slug: string;
  displayName: string;
  url: string;
  enabled?: boolean;
  credentialType?: CredentialType;
  credentialHeaderName?: string | null;
  credentialCiphertext?: string | null;
};

export interface Store {
  ping(): Promise<void>;
  getUserByUsername(username: string): Promise<User | null>;
  getUser(id: string): Promise<User | null>;
  listUsers(): Promise<User[]>;
  insertUser(input: { username: string; passwordHash: string; role: Role }): Promise<User>;
  disableUser(id: string): Promise<void>;
  insertApiKey(input: { userId: string; prefix: string; keyHash: string; label: string }): Promise<ApiKey>;
  listApiKeys(userId: string): Promise<ApiKey[]>;
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
  listAudit(filter: AuditFilter): Promise<AuditRow[]>;
  consumeToken(apiKeyId: string, perMinute: number): Promise<boolean>;
}

export type { Actor, Outcome };
