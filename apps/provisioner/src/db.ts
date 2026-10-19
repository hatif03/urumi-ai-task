import { SQL } from "bun";

// Provisioner-owned tables in the platform Postgres. Own version table so the gateway's migrations
// and these never interfere.
const LOCK_ID = 727_002;

const migrations: Array<{ version: number; statements: string[] }> = [
  {
    version: 1,
    statements: [
      `create table if not exists stores (
        id uuid primary key,
        owner_id uuid not null,
        owner_name text not null,
        name text not null,
        slug text not null unique,
        namespace text not null unique,
        host text not null,
        status text not null check (status in ('provisioning','ready','failed','deleting')),
        phase text not null,
        reason text not null default '',
        attempt int not null default 1,
        deadline_at timestamptz not null,
        lease_owner text,
        lease_until timestamptz,
        next_run_at timestamptz not null default now(),
        created_at timestamptz not null default now(),
        ready_at timestamptz,
        updated_at timestamptz not null default now(),
        unique (owner_id, name)
      )`,
      `create index if not exists stores_owner_idx on stores (owner_id)`,
      `create index if not exists stores_work_idx on stores (status) where status in ('provisioning','deleting')`,
      `create table if not exists hosted_servers (
        id uuid primary key,
        slug text not null unique,
        display_name text not null,
        image text not null,
        size text not null check (size in ('small','medium','large')),
        port int not null default 8080,
        env jsonb not null default '{}'::jsonb,
        secret_keys jsonb not null default '[]'::jsonb,
        created_by uuid not null,
        status text not null check (status in ('provisioning','ready','failed','deleting')),
        phase text not null,
        reason text not null default '',
        attempt int not null default 1,
        deadline_at timestamptz not null,
        lease_owner text,
        lease_until timestamptz,
        next_run_at timestamptz not null default now(),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create index if not exists hosted_work_idx on hosted_servers (status) where status in ('provisioning','deleting')`,
    ],
  },
];

export async function migrate(sql: SQL): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK_ID})`;
    await tx`create table if not exists provisioner_migrations (version int primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await tx`select version from provisioner_migrations`).map((row: { version: number }) => Number(row.version)));
    for (const migration of migrations) {
      if (done.has(migration.version)) continue;
      for (const statement of migration.statements) await tx.unsafe(statement);
      await tx`insert into provisioner_migrations (version) values (${migration.version})`;
    }
  });
}

export type Table = "stores" | "hosted_servers";
export type WorkStatus = "provisioning" | "ready" | "failed" | "deleting";

export type Work = {
  id: string;
  status: WorkStatus;
  phase: string;
  reason: string;
  attempt: number;
  deadlineAt: Date;
  createdAt: Date;
  raw: Record<string, unknown>;
};

export function toWork(row: Record<string, unknown>): Work {
  return {
    id: String(row.id),
    status: row.status as WorkStatus,
    phase: String(row.phase),
    reason: String(row.reason ?? ""),
    attempt: Number(row.attempt),
    deadlineAt: new Date(row.deadline_at as string),
    createdAt: new Date(row.created_at as string),
    raw: row,
  };
}

// Claims one unit of work whose lease is free or expired and whose backoff has passed. skip locked
// lets several provisioner pods (or several workers in one pod) take different rows without waiting.
export async function claim(sql: SQL, table: Table, owner: string, leaseSeconds: number): Promise<Work | null> {
  const rows = await sql.unsafe(
    `update ${table} set lease_owner = $1, lease_until = now() + ($2 * interval '1 second')
     where id = (select id from ${table}
                 where status in ('provisioning','deleting') and next_run_at <= now() and (lease_until is null or lease_until < now())
                 order by updated_at limit 1 for update skip locked)
     returning *`,
    [owner, leaseSeconds],
  );
  return rows[0] ? toWork(rows[0]) : null;
}

export async function heartbeat(sql: SQL, table: Table, id: string, owner: string, leaseSeconds: number): Promise<Work | null> {
  const rows = await sql.unsafe(
    `update ${table} set lease_until = now() + ($3 * interval '1 second') where id = $1 and lease_owner = $2 returning *`,
    [id, owner, leaseSeconds],
  );
  return rows[0] ? toWork(rows[0]) : null;
}

export async function release(sql: SQL, table: Table, id: string, owner: string, delaySeconds = 0): Promise<void> {
  await sql.unsafe(
    `update ${table} set lease_owner = null, lease_until = null, next_run_at = now() + ($3 * interval '1 second') where id = $1 and lease_owner = $2`,
    [id, owner, delaySeconds],
  );
}

// Compare-and-set: moves the machine only if it is still in the state this worker last saw. A delete
// request that arrived meanwhile changes status, the update matches nothing, and the worker stops.
export async function advance(sql: SQL, table: Table, work: Work, patch: { status?: WorkStatus; phase?: string; reason?: string; ready?: boolean }): Promise<boolean> {
  const rows = await sql.unsafe(
    `update ${table} set status = $3, phase = $4, reason = $5, updated_at = now(), next_run_at = now()
       ${table === "stores" && patch.ready ? ", ready_at = now()" : ""}
     where id = $1 and status = $2 returning id`,
    [work.id, work.status, patch.status ?? work.status, patch.phase ?? work.phase, patch.reason ?? ""],
  );
  return rows.length > 0;
}

export async function setReason(sql: SQL, table: Table, id: string, reason: string): Promise<void> {
  await sql.unsafe(`update ${table} set reason = $2, updated_at = now() where id = $1`, [id, reason]);
}

export async function statusCounts(sql: SQL, table: Table): Promise<Record<string, number>> {
  const rows = await sql.unsafe(`select status, count(*)::int as n from ${table} group by status`);
  return Object.fromEntries(rows.map((row: { status: string; n: number }) => [row.status, row.n]));
}
