# 0009. Versioned migrations, one throttle table

- Status: accepted
- Date: 2026-10-20
- Outcome: `postgres.test.ts` runs the migrations on an empty database from two connections at once, runs them again (applies nothing), and fails if a table or column in the Drizzle schema is missing from the migrated database. Seven store tests pass against Postgres 16.

## Context

The first gateway build created tables with `create table if not exists` on every start and kept a second copy of each table in the Drizzle schema. Nothing recorded what had run, so adding a column to a live database was impossible, and the two copies could disagree without anyone noticing. Two gateway replicas run the init container at the same time, so concurrent runs also had to be safe. Rate limiting existed only for API keys (`rate_buckets`, keyed by a uuid); login throttling, chat limits and OAuth endpoint limits needed the same mechanism with string keys.

## Options

1. Keep `create table if not exists` and add `alter table ... if not exists` lines forever.
2. Adopt drizzle-kit migrations generated from the schema.
3. A small ordered list of migrations in code, a `schema_migrations` table, an advisory lock, and a test that compares the Drizzle schema with the migrated database.

## Decision

Option 3. `apps/gateway/src/migrations.ts` is append-only. `migrate.ts` takes `pg_advisory_xact_lock`, creates `schema_migrations`, and applies the migrations that are missing, each in the same transaction as its version row. The Drizzle schema stays as the typed query layer. A new `throttle(key text primary key, tokens, updated_at)` replaces `rate_buckets`; keys are `key:<uuid>`, `login:ip:<ip>`, `login:user:<name>`, `chat:<uuid>`, `oauth-token:<ip>`, `oauth-register:<ip>`.

## Why

drizzle-kit would add a generator and a config file to an image that only needs to run a few statements, and its output is harder to read in an interview than SQL. The advisory lock is the standard way to serialise concurrent migrators on Postgres. A test that diffs the schema against the real database is the cheapest guard against the drift that caused the problem. A single bucket table keeps the token-bucket SQL in one place.

## Consequences

- A released migration is never edited; a fix is a new migration.
- There is no down migration. Rollback of the gateway image works because every migration so far only adds structure; the runbook says to check that before rolling back across a migration.
- The provisioner keeps its own version table (`provisioner_migrations`) so the two services never block each other.
