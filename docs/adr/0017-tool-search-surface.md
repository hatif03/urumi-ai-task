# 0017. Many tools: a three-tool search surface, BM25 ranking, one execution path

- Status: accepted
- Date: 2026-10-20
- Outcome: `features.test.ts` registers 300 filler tools on one upstream plus a real one: the search surface lists exactly `search_tools`, `describe_tool`, `call_tool`; the right tool ranks first; `call_tool` runs it and the audit row names the real tool; a member neither finds nor can run a write tool. `chat.test.ts` shows the chat agent switching to the three tools above 20. `scripts/e2e.ts` repeats the search against the cluster.

## Context

Ten servers can mean hundreds of tools. Handing every definition to a model costs tokens on every turn, degrades tool selection, and some providers cap the number of tools. The brief asks for an approach, such as tools that search for and then execute other tools.

## Options

1. Truncate the tool list.
2. Embed tool descriptions and search by vector similarity.
3. Keyword ranking over name, description and parameter names, exposed as meta-tools.

## Decision

Option 3. `/mcp?surface=search` serves three tools: `search_tools(query, limit)` returns names, short descriptions and a read-only flag; `describe_tool(name)` returns the full schema; `call_tool(name, arguments)` executes through `ToolRouter.call`. Ranking is BM25 over the caller's permitted catalog (`apps/gateway/src/search.ts`): names weigh three times a description word, plurals are stripped, results are capped at 25. The chat agent uses the same three tools when the permitted catalog exceeds `CHAT_DIRECT_TOOL_LIMIT` (default 20). An MCP client that wants everything keeps using `/mcp`.

## Why

The catalog is already in memory and a few hundred short documents rank in microseconds; embeddings would add a model call and an index to keep fresh, and for tool names such as `list_orders` keyword matching is close to as good. Running `call_tool` through the router means permissions, rate limits, timeouts and audit are not duplicated: the audit row says `woocommerce / list_orders`, not `gateway / call_tool`.

## Consequences

- A model must make two or three calls (search, maybe describe, call) where a direct tool would take one. For small catalogs the direct surface is better, which is why chat switches on a threshold.
- Search quality depends on tool descriptions. A server with poor descriptions is hard to find.
- A client that caches the tool list sees only the three meta-tools, so a tool that appears later needs no list-changed notification.
