# 0001. Bun serves a stateless MCP initialize

- Date: 2026-10-14
- Related ADR: [0002](../adr/0002-bun-runtime-and-workspaces.md)

## Hypothesis

Bun 1.2.19 can serve `@modelcontextprotocol/server` 2.3.1 as stateless Streamable HTTP and answer `initialize` with one JSON object negotiated as `2025-06-18`. A failure would supersede ADR 0002 instead of quietly switching the runtime.

## Setup

`bun --version` is 1.2.19. The shared adapter in `apps/mcp-http` builds an `McpServer` and a `WebStandardStreamableHTTPServerTransport` with `sessionIdGenerator: undefined` and `enableJsonResponse: true`. A one-off process listened on `127.0.0.1:8799`. curl posted a single JSON-RPC `initialize` for `2025-06-18` with `Accept: application/json, text/event-stream`.

## Result

HTTP 200, `Content-Type: application/json`, one object, `result.protocolVersion` `2025-06-18`, no `Mcp-Session-Id`. The response also carried a `traceparent` header. `bun test` covered the same adapter: a JSON array body returns 400, `GET /mcp` returns 405, and a `tools/call` with a bad schema returns `-32602`.

## Decision

Keep Bun and the stateless JSON transport. ADR 0002 stays accepted.
