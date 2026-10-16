import { SQL } from "bun";
import { and, desc, eq, gte, isNull, lt, lte, sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./db/schema.ts";
import type { Grant } from "./policy.ts";
import type { OAuthClient, OAuthCode, OAuthGrantView, OAuthToken } from "./types.ts";
import type { ApiKey, AuditFilter, AuditRow, AuditView, CachedTool, McpServerRow, ServerStatus, ToolAnnotations, User } from "./types.ts";
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
    managedBy: row.managedBy,
    status: row.status as ServerStatus,
    statusDetail: row.statusDetail,
    lastCheckedAt: iso(row.lastCheckedAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  });

  const mapAudit = (row: typeof schema.auditLog.$inferSelect): AuditRow => ({
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
  });

  const mapCode = (row: typeof schema.oauthCodes.$inferSelect): OAuthCode => ({
    codeHash: row.codeHash, clientId: row.clientId, userId: row.userId, redirectUri: row.redirectUri, codeChallenge: row.codeChallenge,
    resource: row.resource, familyId: row.familyId, expiresAt: iso(row.expiresAt)!, usedAt: iso(row.usedAt),
  });
  const mapToken = (row: typeof schema.oauthTokens.$inferSelect): OAuthToken => ({
    id: row.id, tokenHash: row.tokenHash, kind: row.kind as OAuthToken["kind"], familyId: row.familyId, clientId: row.clientId, userId: row.userId,
    resource: row.resource, expiresAt: iso(row.expiresAt)!, revokedAt: iso(row.revokedAt), createdAt: iso(row.createdAt)!, lastUsedAt: iso(row.lastUsedAt),
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
    async setUserDisabled(id, disabled) {
      await db.update(schema.users).set({ disabledAt: disabled ? new Date() : null }).where(eq(schema.users.id, id));
    },
    async setUserRole(id, role) {
      await db.update(schema.users).set({ role }).where(eq(schema.users.id, id));
    },
    async setUserPassword(id, passwordHash) {
      await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, id));
    },
    async countActiveAdmins() {
      const [row] = await db.select({ n: dsql<number>`count(*)::int` }).from(schema.users).where(and(eq(schema.users.role, "admin"), isNull(schema.users.disabledAt)));
      return row?.n ?? 0;
    },
    async insertApiKey(input) {
      const [row] = await db.insert(schema.apiKeys).values({ id: crypto.randomUUID(), ...input }).returning();
      return mapKey(row!);
    },
    async listApiKeys(userId) {
      return (await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.userId, userId))).map(mapKey);
    },
    async listAllApiKeys() {
      const rows = await db.select({ key: schema.apiKeys, username: schema.users.username }).from(schema.apiKeys).innerJoin(schema.users, eq(schema.users.id, schema.apiKeys.userId)).orderBy(desc(schema.apiKeys.createdAt));
      return rows.map((row) => ({ ...mapKey(row.key), username: row.username }));
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
        managedBy: input.managedBy ?? null,
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
        annotations: (row.annotations ?? {}) as ToolAnnotations,
        fetchedAt: iso(row.fetchedAt)!,
      }));
    },
    // One transaction: a concurrent reader sees the old list or the new one, never the gap between the delete and
    // the insert (which answered "unknown tool" to a call that arrived at that moment).
    async replaceTools(serverId, tools) {
      await db.transaction(async (tx) => {
        await tx.delete(schema.toolCache).where(eq(schema.toolCache.serverId, serverId));
        if (tools.length) {
          await tx.insert(schema.toolCache).values(tools.map((tool) => ({
            serverId,
            upstreamName: tool.upstreamName,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          })));
        }
      });
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
      return mapAudit(row!);
    },
    async listAudit(filter: AuditFilter) {
      const where = and(
        filter.userId ? eq(schema.auditLog.userId, filter.userId) : undefined,
        filter.serverSlug ? eq(schema.auditLog.serverSlug, filter.serverSlug) : undefined,
        filter.toolName ? eq(schema.auditLog.toolName, filter.toolName) : undefined,
        filter.outcome ? eq(schema.auditLog.outcome, filter.outcome) : undefined,
        filter.from ? gte(schema.auditLog.at, new Date(filter.from)) : undefined,
        filter.to ? lte(schema.auditLog.at, new Date(filter.to)) : undefined,
        filter.beforeId ? lt(schema.auditLog.id, filter.beforeId) : undefined,
      );
      const rows = await db
        .select({ row: schema.auditLog, username: schema.users.username })
        .from(schema.auditLog)
        .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.userId))
        .where(where)
        .orderBy(desc(schema.auditLog.id))
        .limit(Math.min(filter.limit ?? 100, 500));
      return rows.map(({ row, username }): AuditView => ({ ...mapAudit(row), username }));
    },
    async upsertOAuthClient(client) {
      await db.insert(schema.oauthClients).values({ clientId: client.clientId, name: client.name, redirectUris: client.redirectUris, kind: client.kind })
        .onConflictDoUpdate({ target: schema.oauthClients.clientId, set: { name: client.name, redirectUris: client.redirectUris, updatedAt: new Date() } });
    },
    async getOAuthClient(clientId) {
      const [row] = await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.clientId, clientId)).limit(1);
      return row ? ({ clientId: row.clientId, name: row.name, redirectUris: row.redirectUris as string[], kind: row.kind as OAuthClient["kind"], createdAt: iso(row.createdAt)! }) : null;
    },
    async insertOAuthCode(code) {
      await db.insert(schema.oauthCodes).values({ ...code, expiresAt: new Date(code.expiresAt) });
    },
    async consumeOAuthCode(codeHash) {
      const used = await db.update(schema.oauthCodes).set({ usedAt: new Date() })
        .where(and(eq(schema.oauthCodes.codeHash, codeHash), isNull(schema.oauthCodes.usedAt), gte(schema.oauthCodes.expiresAt, new Date()))).returning();
      if (used[0]) return { status: "ok", code: mapCode(used[0]) } as const;
      const [row] = await db.select().from(schema.oauthCodes).where(eq(schema.oauthCodes.codeHash, codeHash)).limit(1);
      return row?.usedAt ? ({ status: "replayed", familyId: row.familyId } as const) : ({ status: "invalid" } as const);
    },
    async insertOAuthToken(token) {
      const [row] = await db.insert(schema.oauthTokens).values({ ...token, expiresAt: new Date(token.expiresAt) }).returning();
      return mapToken(row!);
    },
    async findOAuthToken(tokenHash) {
      const [row] = await db.select().from(schema.oauthTokens).where(eq(schema.oauthTokens.tokenHash, tokenHash)).limit(1);
      return row ? mapToken(row) : null;
    },
    async revokeOAuthToken(id) {
      return (await db.update(schema.oauthTokens).set({ revokedAt: new Date() }).where(and(eq(schema.oauthTokens.id, id), isNull(schema.oauthTokens.revokedAt))).returning()).length > 0;
    },
    async revokeOAuthFamily(familyId) {
      await db.update(schema.oauthTokens).set({ revokedAt: new Date() }).where(and(eq(schema.oauthTokens.familyId, familyId), isNull(schema.oauthTokens.revokedAt)));
    },
    async touchOAuthToken(id) {
      await db.update(schema.oauthTokens).set({ lastUsedAt: new Date() }).where(eq(schema.oauthTokens.id, id));
    },
    async listOAuthGrants(userId) {
      const rows = await client`
        select t.family_id, t.client_id, c.name, min(t.created_at) as created_at, max(t.last_used_at) as last_used_at
        from oauth_tokens t join oauth_clients c on c.client_id = t.client_id
        where t.user_id = ${userId}::uuid and t.kind = 'refresh' and t.revoked_at is null and t.expires_at > now()
        group by t.family_id, t.client_id, c.name order by min(t.created_at) desc
      `;
      return rows.map((r: Record<string, unknown>): OAuthGrantView => ({ familyId: String(r.family_id), clientId: String(r.client_id), clientName: String(r.name), createdAt: iso(r.created_at as Date)!, lastUsedAt: iso(r.last_used_at as Date | null) }));
    },
    async listGrants() {
      return (await db.select().from(schema.toolGrants)).map((row): Grant => ({ id: row.id, subjectType: row.subjectType as Grant["subjectType"], subject: row.subject, serverSlug: row.serverSlug, toolName: row.toolName, effect: row.effect as Grant["effect"] }));
    },
    async upsertGrant(input) {
      const [row] = await db.insert(schema.toolGrants).values({ id: crypto.randomUUID(), subjectType: input.subjectType, subject: input.subject, serverSlug: input.serverSlug, toolName: input.toolName, effect: input.effect, createdBy: input.createdBy })
        .onConflictDoUpdate({ target: [schema.toolGrants.subjectType, schema.toolGrants.subject, schema.toolGrants.serverSlug, schema.toolGrants.toolName], set: { effect: input.effect } }).returning();
      return { id: row!.id, subjectType: row!.subjectType as Grant["subjectType"], subject: row!.subject, serverSlug: row!.serverSlug, toolName: row!.toolName, effect: row!.effect as Grant["effect"] };
    },
    async deleteGrant(id) {
      return (await db.delete(schema.toolGrants).where(eq(schema.toolGrants.id, id)).returning()).length > 0;
    },
    async consumeToken(key, perMinute) {
      const rows = await client`
        insert into throttle (key, tokens, updated_at)
        values (${key}, ${perMinute - 1}, now())
        on conflict (key) do update
        set tokens = least(${perMinute}::float8, throttle.tokens + extract(epoch from (now() - throttle.updated_at)) * (${perMinute}::float8 / 60.0)) - 1,
            updated_at = now()
        where least(${perMinute}::float8, throttle.tokens + extract(epoch from (now() - throttle.updated_at)) * (${perMinute}::float8 / 60.0)) >= 1
        returning tokens
      `;
      return rows.length > 0;
    },
  };
}
