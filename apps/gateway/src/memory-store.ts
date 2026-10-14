import type { ApiKey, AuditFilter, AuditRow, CachedTool, McpServerRow, ServerStatus, User } from "./types.ts";
import type { NewServer, Store } from "./store.ts";

function now(): string {
  return new Date().toISOString();
}

function id(): string {
  return crypto.randomUUID();
}

export class MemoryStore implements Store {
  users: User[] = [];
  keys: ApiKey[] = [];
  servers: McpServerRow[] = [];
  tools: CachedTool[] = [];
  audits: AuditRow[] = [];
  buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private locks = new Map<string, Promise<unknown>>();
  private auditId = 1;

  async ping(): Promise<void> {}

  async getUserByUsername(username: string): Promise<User | null> {
    return this.users.find((user) => user.username === username) ?? null;
  }

  async getUser(userId: string): Promise<User | null> {
    return this.users.find((user) => user.id === userId) ?? null;
  }

  async listUsers(): Promise<User[]> {
    return [...this.users];
  }

  async insertUser(input: { username: string; passwordHash: string; role: User["role"] }): Promise<User> {
    const user: User = { id: id(), username: input.username, passwordHash: input.passwordHash, role: input.role, disabledAt: null, createdAt: now() };
    this.users.push(user);
    return user;
  }

  async disableUser(userId: string): Promise<void> {
    const user = await this.getUser(userId);
    if (user) user.disabledAt = now();
  }

  async insertApiKey(input: { userId: string; prefix: string; keyHash: string; label: string }): Promise<ApiKey> {
    const key: ApiKey = { id: id(), ...input, createdAt: now(), revokedAt: null, lastUsedAt: null };
    this.keys.push(key);
    return key;
  }

  async listApiKeys(userId: string): Promise<ApiKey[]> {
    return this.keys.filter((key) => key.userId === userId);
  }

  async findLiveKeyByPrefix(prefix: string): Promise<ApiKey | null> {
    return this.keys.find((key) => key.prefix === prefix && key.revokedAt === null) ?? null;
  }

  async revokeApiKey(keyId: string, userId: string | null): Promise<boolean> {
    const key = this.keys.find((item) => item.id === keyId && (userId === null || item.userId === userId));
    if (!key || key.revokedAt) return false;
    key.revokedAt = now();
    return true;
  }

  async touchApiKey(keyId: string): Promise<void> {
    const key = this.keys.find((item) => item.id === keyId);
    if (key) key.lastUsedAt = now();
  }

  async listServers(): Promise<McpServerRow[]> {
    return [...this.servers];
  }

  async getServer(serverId: string): Promise<McpServerRow | null> {
    return this.servers.find((server) => server.id === serverId) ?? null;
  }

  async getServerBySlug(slug: string): Promise<McpServerRow | null> {
    return this.servers.find((server) => server.slug === slug) ?? null;
  }

  async insertServer(input: NewServer): Promise<McpServerRow> {
    const row: McpServerRow = {
      id: id(),
      slug: input.slug,
      displayName: input.displayName,
      url: input.url,
      enabled: input.enabled ?? true,
      credentialType: input.credentialType ?? "none",
      credentialHeaderName: input.credentialHeaderName ?? null,
      credentialCiphertext: input.credentialCiphertext ?? null,
      status: input.enabled === false ? "disabled" : "connected",
      statusDetail: "",
      lastCheckedAt: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.servers.push(row);
    return row;
  }

  async updateServer(serverId: string, patch: Partial<NewServer> & { enabled?: boolean; status?: ServerStatus; statusDetail?: string }): Promise<McpServerRow | null> {
    const server = await this.getServer(serverId);
    if (!server) return null;
    if (patch.displayName !== undefined) server.displayName = patch.displayName;
    if (patch.url !== undefined) server.url = patch.url;
    if (patch.enabled !== undefined) {
      server.enabled = patch.enabled;
      server.status = patch.enabled ? "connected" : "disabled";
    }
    if (patch.credentialType !== undefined) server.credentialType = patch.credentialType;
    if (patch.credentialHeaderName !== undefined) server.credentialHeaderName = patch.credentialHeaderName;
    if (patch.credentialCiphertext !== undefined) server.credentialCiphertext = patch.credentialCiphertext;
    if (patch.status !== undefined) server.status = patch.status;
    if (patch.statusDetail !== undefined) server.statusDetail = patch.statusDetail;
    server.updatedAt = now();
    return server;
  }

  async deleteServer(serverId: string): Promise<void> {
    this.servers = this.servers.filter((server) => server.id !== serverId);
    this.tools = this.tools.filter((tool) => tool.serverId !== serverId);
  }

  async claimProbe(serverId: string, staleMs: number): Promise<boolean> {
    const server = await this.getServer(serverId);
    if (!server || !server.enabled) return false;
    const last = server.lastCheckedAt ? Date.parse(server.lastCheckedAt) : 0;
    if (Date.now() - last < staleMs) return false;
    server.lastCheckedAt = now();
    return true;
  }

  async setStatus(serverId: string, status: ServerStatus, detail: string): Promise<void> {
    const server = await this.getServer(serverId);
    if (!server || !server.enabled) return;
    server.status = status;
    server.statusDetail = detail;
    server.updatedAt = now();
  }

  async getCachedTools(serverId: string): Promise<CachedTool[]> {
    return this.tools.filter((tool) => tool.serverId === serverId);
  }

  async replaceTools(serverId: string, tools: Array<Omit<CachedTool, "serverId" | "fetchedAt">>): Promise<void> {
    const fetchedAt = now();
    this.tools = this.tools.filter((tool) => tool.serverId !== serverId);
    for (const tool of tools) this.tools.push({ ...tool, serverId, fetchedAt });
  }

  async withServerLock<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(serverId) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(serverId, previous.then(() => gate));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async insertAudit(input: Omit<AuditRow, "id" | "at"> & { at?: string }): Promise<AuditRow> {
    const row: AuditRow = { id: this.auditId++, at: input.at ?? now(), userId: input.userId, apiKeyId: input.apiKeyId, actor: input.actor, serverSlug: input.serverSlug, toolName: input.toolName, durationMs: input.durationMs, outcome: input.outcome, errorCode: input.errorCode, traceId: input.traceId };
    this.audits.push(row);
    return row;
  }

  async listAudit(filter: AuditFilter): Promise<AuditRow[]> {
    return this.audits
      .filter((row) => !filter.userId || row.userId === filter.userId)
      .filter((row) => !filter.serverSlug || row.serverSlug === filter.serverSlug)
      .filter((row) => !filter.outcome || row.outcome === filter.outcome)
      .filter((row) => !filter.from || row.at >= filter.from)
      .filter((row) => !filter.to || row.at <= filter.to)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, filter.limit ?? 100);
  }

  async consumeToken(apiKeyId: string, perMinute: number): Promise<boolean> {
    const current = this.buckets.get(apiKeyId) ?? { tokens: perMinute, updatedAt: Date.now() };
    const elapsed = (Date.now() - current.updatedAt) / 1000;
    const refilled = Math.min(perMinute, current.tokens + elapsed * (perMinute / 60));
    if (refilled < 1) {
      this.buckets.set(apiKeyId, { tokens: refilled, updatedAt: Date.now() });
      return false;
    }
    this.buckets.set(apiKeyId, { tokens: refilled - 1, updatedAt: Date.now() });
    return true;
  }
}
