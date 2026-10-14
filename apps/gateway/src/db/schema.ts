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
]);

export const rateBuckets = pgTable("rate_buckets", {
  apiKeyId: uuid("api_key_id").primaryKey(),
  tokens: doublePrecision("tokens").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
