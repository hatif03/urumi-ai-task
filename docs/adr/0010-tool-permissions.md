# 0010. Tool permissions: most specific rule wins, read-only by default for members

- Status: accepted
- Date: 2026-10-20
- Outcome: `policy.test.ts` covers the decision table. `features.test.ts` shows a member's `tools/list` omits write tools, a direct `tools/call` returns -32003 and an audit row with outcome `denied`, a per-user allow lifts one tool for one member, and chat offers the model only permitted tools.

## Context

The brief's example is that members can read orders and only admins can create products or change order status, with restricted tools hidden from the list and rejected when called directly. The WooCommerce key is shared, so the gateway is the only place a distinction between users can exist.

## Options

1. Hard-code "admin only" tool names.
2. A grant table with role and user rules, most specific wins, plus a default.
3. A full policy language (Cedar, OPA).

## Decision

Option 2. `tool_grants(subject_type role|user, subject, server_slug, tool_name, effect allow|deny)`, unique on its natural key. `decide()` in `apps/gateway/src/policy.ts`: the matching rule with the highest specificity wins; a user rule beats a role rule; a tool rule beats a server rule beats a global rule; a deny beats an allow at equal specificity. With no matching rule an admin may call anything and a member may call tools whose upstream annotation says `readOnlyHint: true`. An unannotated tool counts as a write (the MCP default). A tool name other than `*` is allowed only together with an exact server. The same function filters `tools/list` and chat (`catalogFor`) and guards `ToolRouter.call`, so a hidden tool is also rejected.

## Why

The MCP spec already gives servers a way to say what a tool does (`readOnlyHint`, `destructiveHint`), so the default needs no per-tool configuration and a new upstream is safe before an admin looks at it. A list of rules is something an admin can read in a table; user-over-role precedence is what people expect from an exception. Doing the check in `call()` and not only in the list is the point of the brief's "rejected if called directly": hiding is not a control.

## Consequences

- An unannotated third-party tool is invisible to members until an admin allows it. That is safe and sometimes surprising; the dashboard shows the reason for each tool.
- Decisions read grants from Postgres on each call (a scan of a few rows). A cache would make revocation lag.
- Grants are per server slug, so a store created later (`store_alpha`) inherits the global rules but needs its own rule for exceptions.
- Annotations come from the upstream and are untrusted input: a malicious server can claim `readOnlyHint` on a write. The threat model says so; an admin can add an explicit deny.
