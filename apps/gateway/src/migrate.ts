import { SQL } from "bun";
import { hashPassword } from "./crypto.ts";

const statements = [
  `create table if not exists users (
    id uuid primary key,
    username text not null unique,
    password_hash text not null,
    role text not null,
    disabled_at timestamptz,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists api_keys (
    id uuid primary key,
    user_id uuid not null references users(id),
    prefix text not null,
    key_hash text not null,
    label text not null,
    created_at timestamptz not null default now(),
    revoked_at timestamptz,
    last_used_at timestamptz
  )`,
  `create index if not exists api_keys_prefix_live_idx on api_keys (prefix) where revoked_at is null`,
  `create table if not exists mcp_servers (
    id uuid primary key,
    slug text not null unique,
    display_name text not null,
    url text not null,
    enabled boolean not null default true,
    credential_type text not null default 'none',
    credential_header_name text,
    credential_ciphertext text,
    status text not null default 'connected',
    status_detail text not null default '',
    last_checked_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists tool_cache (
    server_id uuid not null references mcp_servers(id) on delete cascade,
    upstream_name text not null,
    description text not null,
    input_schema jsonb not null,
    fetched_at timestamptz not null default now(),
    primary key (server_id, upstream_name)
  )`,
  `create table if not exists audit_log (
    id bigserial primary key,
    at timestamptz not null default now(),
    user_id uuid,
    api_key_id uuid,
    actor text not null,
    server_slug text,
    tool_name text,
    duration_ms double precision,
    outcome text not null,
    error_code text,
    trace_id text not null
  )`,
  `create index if not exists audit_log_at_idx on audit_log (at desc)`,
  `create index if not exists audit_log_user_at_idx on audit_log (user_id, at desc)`,
  `create table if not exists rate_buckets (
    api_key_id uuid primary key,
    tokens double precision not null,
    updated_at timestamptz not null
  )`,
];

export async function migrate(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const sql = new SQL(databaseUrl);
  for (const statement of statements) await sql.unsafe(statement);

  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (username && password) {
    const existing = await sql`select id from users limit 1`;
    if (existing.length === 0) {
      await sql`insert into users (id, username, password_hash, role) values (${crypto.randomUUID()}::uuid, ${username}, ${await hashPassword(password)}, 'admin')`;
    }
  }

  const seeds = (process.env.SEED_MCP_SERVERS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  for (const seed of seeds) {
    const [slug, displayName, url] = seed.split("|");
    if (!slug || !displayName || !url) continue;
    const found = await sql`select id from mcp_servers where slug = ${slug}`;
    if (found.length === 0) {
      await sql`
        insert into mcp_servers (id, slug, display_name, url, enabled, credential_type, status)
        values (${crypto.randomUUID()}::uuid, ${slug}, ${displayName}, ${url}, true, 'none', 'connected')
      `;
    }
  }
  await sql.end();
}

if (import.meta.main) {
  migrate().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
