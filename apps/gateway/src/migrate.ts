import { SQL } from "bun";
import { hashPassword } from "./crypto.ts";
import { migrations } from "./migrations.ts";

// Two gateway replicas run this init container at the same time. The advisory lock serialises them.
const LOCK_ID = 727_001;

export async function runMigrations(sql: SQL): Promise<number[]> {
  const applied: number[] = [];
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK_ID})`;
    await tx`create table if not exists schema_migrations (version int primary key, name text not null, applied_at timestamptz not null default now())`;
    const done = new Set((await tx`select version from schema_migrations`).map((row: { version: number }) => Number(row.version)));
    for (const migration of migrations) {
      if (done.has(migration.version)) continue;
      for (const statement of migration.statements) await tx.unsafe(statement);
      await tx`insert into schema_migrations (version, name) values (${migration.version}, ${migration.name})`;
      applied.push(migration.version);
    }
  });
  return applied;
}

export async function migrate(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const sql = new SQL(databaseUrl);
  const applied = await runMigrations(sql);
  if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);

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
    await sql`
      insert into mcp_servers (id, slug, display_name, url, enabled, credential_type, status)
      values (${crypto.randomUUID()}::uuid, ${slug}, ${displayName}, ${url}, true, 'none', 'connected')
      on conflict (slug) do nothing
    `;
  }
  await sql.end();
}

if (import.meta.main) {
  migrate().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
