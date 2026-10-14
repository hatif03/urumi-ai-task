import { SQL } from "bun";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./db/schema.ts";
import type { ApiKey, AuditFilter, AuditRow, CachedTool, McpServerRow, ServerStatus, User } from "./types.ts";
import type { NewServer, Store } from "./store.ts";

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function createPostgresStore(databaseUrl: string): Store & { close(): Promise<void> } {
  const client = new SQL(databaseUrl);
  const db = drizzle(client, { schema });

  const mapUser = (row: typeof schema.users.$inferSelect): User => ({
    id: row.id,
    username: row.username,
    passwordHash: row.passwordHash,
    role: row.role as User["role"],
    disabledAt: iso(row.disabledAt),
    createdAt: iso(row.createdAt)!,
  });

  const mapKey = (row: typeof schema.apiKeys.$inferSelect): ApiKey => ({
    id: row.id,
    userId: row.userId,
    prefix: row.prefix,
    keyHash: row.keyHash,
    label: row.label,
    createdAt: iso(row.createdAt)!,
    revokedAt: iso(row.revokedAt),
    lastUsedAt: iso(row.lastUsedAt),
  });

  const mapServer = (row: typeof schema.mcpServers.$inferSelect): McpServerRow => ({
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    url: row.url,
    enabled: row.enabled,
    credentialType: row.credentialType as McpServerRow["credentialType"],
    credentialHeaderName: row.credentialHeaderName,
    credentialCiphertext: row.credentialCiphertext,
    status: row.status as ServerStatus,
    statusDetail: row.statusDetail,
    lastCheckedAt: iso(row.lastCheckedAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  });

  const locks = new Map<string, Promise<unknown>>();

  return {
    async close() { await client.end(); },
    async ping() { await client`select 1`; },
    async getUserByUsername(username) {
      const [row] = await db.select().from(schema.users).where(eq(schema.users.username, username)).limit(1);
      return row ? mapUser(row) : null;
    },
    async getUser(id) {
      const [row] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
      return row ? mapUser(row) : null;
    },
    async listUsers() {
      return (await db.select().from(schema.users)).map(mapUser);
    },
    async insertUser(input) {
      const [row] = await db.insert(schema.users).values({ id: crypto.randomUUID(), username: input.username, passwordHash: input.passwordHash, role: input.role }).returning();
      return mapUser(row!);
    },
    async disableUser(id) {
      await db.update(schema.users).set({ disabledAt: new Date() }).where(eq(schema.users.id, id));
    },
    async insertApiKey(input) {
      const [row] = await db.insert(schema.apiKeys).values({ id: crypto.randomUUID(), ...input }).returning();
      return mapKey(row!);
    },
    async listApiKeys(userId) {
      return (await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.userId, userId))).map(mapKey);
    },
    async findLiveKeyByPrefix(prefix) {
      const [row] = await db.select().from(schema.apiKeys).where(and(eq(schema.apiKeys.prefix, prefix), isNull(schema.apiKeys.revokedAt))).limit(1);
      return row ? mapKey(row) : null;
    },
    async revokeApiKey(id, userId) {
      const filter = userId ? and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.userId, userId)) : eq(schema.apiKeys.id, id);
      const rows = await db.update(schema.apiKeys).set({ revokedAt: new Date() }).where(and(filter, isNull(schema.apiKeys.revokedAt))).returning();
      return rows.length > 0;
    },
    async touchApiKey(id) {
      await db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, id));
    },
    async listServers() {
      return (await db.select().from(schema.mcpServers)).map(mapServer);
    },
    async getServer(id) {
      const [row] = await db.select().from(schema.mcpServers).where(eq(schema.mcpServers.id, id)).limit(1);
      return row ? mapServer(row) : null;
    },
    async getServerBySlug(slug) {
      const [row] = await db.select().from(schema.mcpServers).where(eq(schema.mcpServers.slug, slug)).limit(1);
      return row ? mapServer(row) : null;
    },
    async insertServer(input: NewServer) {
      const [row] = await db.insert(schema.mcpServers).values({
        id: crypto.randomUUID(),
        slug: input.slug,
        displayName: input.displayName,
        url: input.url,
        enabled: input.enabled ?? true,
        credentialType: input.credentialType ?? "none",
        credentialHeaderName: input.credentialHeaderName ?? null,
        credentialCiphertext: input.credentialCiphertext ?? null,
        status: input.enabled === false ? "disabled" : "connected",
        statusDetail: "",
      }).returning();
      return mapServer(row!);
    },
    async updateServer(id, patch) {
      const [row] = await db.update(schema.mcpServers).set({
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled, status: patch.enabled ? "connected" : "disabled" } : {}),
        ...(patch.credentialType !== undefined ? { credentialType: patch.credentialType } : {}),
        ...(patch.credentialHeaderName !== undefined ? { credentialHeaderName: patch.credentialHeaderName } : {}),
        ...(patch.credentialCiphertext !== undefined ? { credentialCiphertext: patch.credentialCiphertext } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.statusDetail !== undefined ? { statusDetail: patch.statusDetail } : {}),
        updatedAt: new Date(),
      }).where(eq(schema.mcpServers.id, id)).returning();
      return row ? mapServer(row) : null;
    },
    async deleteServer(id) {
      await db.delete(schema.toolCache).where(eq(schema.toolCache.serverId, id));
      await db.delete(schema.mcpServers).where(eq(schema.mcpServers.id, id));
    },
    async claimProbe(id, staleMs) {
      const rows = await client`
        update mcp_servers
        set last_checked_at = now()
        where id = ${id}::uuid
          and enabled = true
          and (last_checked_at is null or last_checked_at < now() - (${staleMs} * interval '1 millisecond'))
        returning id
      `;
      return rows.length > 0;
    },
    async setStatus(id, status, detail) {
      await db.update(schema.mcpServers).set({ status, statusDetail: detail, updatedAt: new Date() }).where(and(eq(schema.mcpServers.id, id), eq(schema.mcpServers.enabled, true)));
    },
    async getCachedTools(serverId) {
      const rows = await db.select().from(schema.toolCache).where(eq(schema.toolCache.serverId, serverId));
      return rows.map((row): CachedTool => ({
        serverId: row.serverId,
        upstreamName: row.upstreamName,
        description: row.description,
        inputSchema: row.inputSchema,
        fetchedAt: iso(row.fetchedAt)!,
      }));
    },
    async replaceTools(serverId, tools) {
      await db.delete(schema.toolCache).where(eq(schema.toolCache.serverId, serverId));
      if (tools.length) {
        await db.insert(schema.toolCache).values(tools.map((tool) => ({
          serverId,
          upstreamName: tool.upstreamName,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })));
      }
    },
    async withServerLock<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
      const previous = locks.get(serverId) ?? Promise.resolve();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      locks.set(serverId, previous.then(() => gate));
      await previous;
      try {
        return await fn();
      } finally {
        release();
      }
    },
    async insertAudit(input) {
      const [row] = await db.insert(schema.auditLog).values({
        userId: input.userId,
        apiKeyId: input.apiKeyId,
        actor: input.actor,
        serverSlug: input.serverSlug,
        toolName: input.toolName,
        durationMs: input.durationMs,
        outcome: input.outcome,
        errorCode: input.errorCode,
        traceId: input.traceId,
      }).returning();
      return {
        id: row!.id,
        at: iso(row!.at)!,
        userId: row!.userId,
        apiKeyId: row!.apiKeyId,
        actor: row!.actor as AuditRow["actor"],
        serverSlug: row!.serverSlug,
        toolName: row!.toolName,
        durationMs: row!.durationMs,
        outcome: row!.outcome as AuditRow["outcome"],
        errorCode: row!.errorCode,
        traceId: row!.traceId,
      };
    },
    async listAudit(filter: AuditFilter) {
      const rows = await db.select().from(schema.auditLog).orderBy(desc(schema.auditLog.at)).limit(filter.limit ?? 100);
      return rows.map((row) => ({
        id: row.id,
        at: iso(row.at)!,
        userId: row.userId,
        apiKeyId: row.apiKeyId,
        actor: row.actor as AuditRow["actor"],
        serverSlug: row.serverSlug,
        toolName: row.toolName,
        durationMs: row.durationMs,
        outcome: row.outcome as AuditRow["outcome"],
        errorCode: row.errorCode,
        traceId: row.traceId,
      })).filter((row) => !filter.userId || row.userId === filter.userId)
        .filter((row) => !filter.serverSlug || row.serverSlug === filter.serverSlug)
        .filter((row) => !filter.outcome || row.outcome === filter.outcome);
    },
    async consumeToken(apiKeyId, perMinute) {
      const rows = await client`
        insert into rate_buckets (api_key_id, tokens, updated_at)
        values (${apiKeyId}::uuid, ${perMinute - 1}, now())
        on conflict (api_key_id) do update
        set tokens = least(${perMinute}::float8, rate_buckets.tokens + extract(epoch from (now() - rate_buckets.updated_at)) * (${perMinute}::float8 / 60.0)) - 1,
            updated_at = now()
        where least(${perMinute}::float8, rate_buckets.tokens + extract(epoch from (now() - rate_buckets.updated_at)) * (${perMinute}::float8 / 60.0)) >= 1
        returning tokens
      `;
      return rows.length > 0;
    },
  };
}
