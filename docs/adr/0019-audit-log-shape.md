# 0019. Audit log: one row per call, joined to the user, filtered in SQL, paged by id

- Status: accepted
- Date: 2026-10-20
- Outcome: `postgres.test.ts` shows the username joined, a filter applied before the limit (a single denied row is found although it is not among the newest), paging by `beforeId`, and a `from` filter. `features.test.ts` shows the same through the HTTP API and that a member gets 403.

## Context

The brief wants the audit log to show who, which server and tool, when, how long and whether it succeeded, visible in the dashboard. The first build stored all of those columns but returned user ids only, the table omitted the user and the duration, and the filters ran in JavaScript after `limit 100`, so filtering by an outcome that happened earlier than the newest hundred rows returned nothing. `from` and `to` were accepted and ignored.

## Decision

`audit_log` keeps one row per tool call and per rejected credential: `at`, `user_id`, `api_key_id`, `actor` (`mcp` or `chat`), `server_slug`, `tool_name`, `duration_ms` (double), `outcome` (success, error, timeout, unreachable, denied, unauthorized), `error_code`, `trace_id`. No arguments and no results are stored: arguments can contain personal data, and the WooCommerce results are orders. The API (`GET /api/audit`) joins `users` for the name, applies every filter in SQL (`user` by name or id, `server`, `tool`, `outcome`, `from`, `to`), orders by `id` descending and pages with `beforeId`; the page size is capped at 500. Indexes on `(at)`, `(user_id, at)`, `(server_slug, at)` and `(outcome, at)`. Search-surface calls are audited as `gateway / search_tools` and the executed tool as itself.

## Why

`id` is monotonic, so keyset paging is stable while rows are being inserted, unlike `offset`. `duration_ms` is a double because sub-millisecond tool calls exist. A user row is joined at read time, not copied into the log, so renaming a user does not leave a stale name; a deleted user shows as `null` (users are disabled, not deleted).

## Consequences

- Rows are kept forever. There is no retention job; at tens of calls a minute a year is millions of rows and the indexes still serve the dashboard. A retention policy is a follow-up.
- Because arguments are not logged, the audit answers "who called what", not "with which values". The trace id links to a trace when tracing is on.
