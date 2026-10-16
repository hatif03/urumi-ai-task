import { pgTable, uuid, text, timestamp, boolean, jsonb, bigserial, doublePrecision, primaryKey, index } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
}, (table) => [index("api_keys_prefix_idx").on(table.prefix)]);

export const mcpServers = pgTable("mcp_servers", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  displayName: text("display_name").notNull(),
  url: text("url").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  credentialType: text("credential_type").notNull().default("none"),
  credentialHeaderName: text("credential_header_name"),
  credentialCiphertext: text("credential_ciphertext"),
  managedBy: text("managed_by"),
  status: text("status").notNull().default("connected"),
  statusDetail: text("status_detail").notNull().default(""),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const toolCache = pgTable("tool_cache", {
  serverId: uuid("server_id").notNull().references(() => mcpServers.id, { onDelete: "cascade" }),
  upstreamName: text("upstream_name").notNull(),
  description: text("description").notNull(),
  inputSchema: jsonb("input_schema").notNull(),
  annotations: jsonb("annotations").notNull().default({}),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.serverId, table.upstreamName] })]);

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  userId: uuid("user_id"),
  apiKeyId: uuid("api_key_id"),
  actor: text("actor").notNull(),
  serverSlug: text("server_slug"),
  toolName: text("tool_name"),
  durationMs: doublePrecision("duration_ms"),
  outcome: text("outcome").notNull(),
  errorCode: text("error_code"),
  traceId: text("trace_id").notNull(),
}, (table) => [
  index("audit_log_at_idx").on(table.at),
  index("audit_log_user_at_idx").on(table.userId, table.at),
  index("audit_log_server_at_idx").on(table.serverSlug, table.at),
  index("audit_log_outcome_at_idx").on(table.outcome, table.at),
]);

export const throttle = pgTable("throttle", {
  key: text("key").primaryKey(),
  tokens: doublePrecision("tokens").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const toolGrants = pgTable("tool_grants", {
  id: uuid("id").primaryKey(),
  subjectType: text("subject_type").notNull(),
  subject: text("subject").notNull(),
  serverSlug: text("server_slug").notNull(),
  toolName: text("tool_name").notNull().default("*"),
  effect: text("effect").notNull(),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const oauthClients = pgTable("oauth_clients", {
  clientId: text("client_id").primaryKey(),
  name: text("name").notNull(),
  redirectUris: jsonb("redirect_uris").notNull(),
  kind: text("kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const oauthCodes = pgTable("oauth_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id").notNull().references(() => oauthClients.clientId, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  resource: text("resource").notNull(),
  familyId: uuid("family_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export const oauthTokens = pgTable("oauth_tokens", {
  id: uuid("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  kind: text("kind").notNull(),
  familyId: uuid("family_id").notNull(),
  clientId: text("client_id").notNull().references(() => oauthClients.clientId, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  resource: text("resource").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});
