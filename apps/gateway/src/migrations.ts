// Ordered, append-only. A migration that has run is never edited; a change is a new entry.
// The Drizzle schema in db/schema.ts is the typed query layer and migrations.test.ts fails if
// it names a table or column these migrations do not create.
export type Migration = { version: number; name: string; statements: string[] };

export const migrations: Migration[] = [
  {
    version: 1,
    name: "core tables",
    statements: [
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
    ],
  },
  {
    version: 2,
    name: "generic throttle, audit filters, tool annotations",
    statements: [
      // One token-bucket table for API keys, login attempts, and chat. The key is a string such as
      // key:<uuid>, login:<ip>, chat:<uuid>.
      `create table if not exists throttle (
        key text primary key,
        tokens double precision not null,
        updated_at timestamptz not null
      )`,
      `drop table if exists rate_buckets`,
      `create index if not exists audit_log_server_at_idx on audit_log (server_slug, at desc)`,
      `create index if not exists audit_log_outcome_at_idx on audit_log (outcome, at desc)`,
      // Upstream tool annotations (readOnlyHint, destructiveHint, title) feed the permission default.
      `alter table tool_cache add column if not exists annotations jsonb not null default '{}'::jsonb`,
    ],
  },
  {
    version: 3,
    name: "tool grants",
    statements: [
      `create table if not exists tool_grants (
        id uuid primary key,
        subject_type text not null check (subject_type in ('role','user')),
        subject text not null,
        server_slug text not null,
        tool_name text not null default '*',
        effect text not null check (effect in ('allow','deny')),
        created_by uuid,
        created_at timestamptz not null default now(),
        unique (subject_type, subject, server_slug, tool_name)
      )`,
    ],
  },
  {
    version: 4,
    name: "managed servers",
    statements: [
      // 'store' or 'hosted' when the provisioner owns the server; null when an admin added it by hand.
      // A managed server is removed with the thing that owns it, not from the server list.
      `alter table mcp_servers add column if not exists managed_by text`,
    ],
  },
  {
    version: 5,
    name: "oauth",
    statements: [
      // Clients registered by RFC 7591 (kind dcr) or fetched from a Client ID Metadata Document (kind cimd).
      `create table if not exists oauth_clients (
        client_id text primary key,
        name text not null,
        redirect_uris jsonb not null,
        kind text not null check (kind in ('dcr','cimd')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      // Authorization codes live ten minutes and are used once. Only the hash is stored.
      `create table if not exists oauth_codes (
        code_hash text primary key,
        client_id text not null references oauth_clients(client_id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        redirect_uri text not null,
        code_challenge text not null,
        resource text not null,
        family_id uuid not null,
        expires_at timestamptz not null,
        used_at timestamptz
      )`,
      // Access and refresh tokens, hashed. family_id ties a refresh chain together so that reuse of a
      // rotated refresh token revokes everything issued from that grant.
      `create table if not exists oauth_tokens (
        id uuid primary key,
        token_hash text not null unique,
        kind text not null check (kind in ('access','refresh')),
        family_id uuid not null,
        client_id text not null references oauth_clients(client_id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        resource text not null,
        expires_at timestamptz not null,
        revoked_at timestamptz,
        created_at timestamptz not null default now(),
        last_used_at timestamptz
      )`,
      `create index if not exists oauth_tokens_family_idx on oauth_tokens (family_id)`,
      `create index if not exists oauth_tokens_user_idx on oauth_tokens (user_id)`,
    ],
  },
];
