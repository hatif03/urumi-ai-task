# 0002. Use Bun as the package manager and the runtime

- Status: accepted
- Date: 2026-10-14
- Supersedes: the earlier planning choice of a pnpm workspace on Node 22, which was never implemented
- Outcome: Bun 1.2.19 and `@modelcontextprotocol/server` 2.3.1 answered `initialize` as one JSON object with protocol `2025-06-18`. See [experiment 0001](../experiments/0001-bun-initialize.md).

## Context

The services we write are TypeScript: three MCP servers, the gateway, and a React dashboard. The MCP TypeScript SDK v2 (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`) documents Bun as a supported runtime and ships `test/integration/test/server/bun.test.ts`, which serves Streamable HTTP with `Bun.serve` and `WebStandardStreamableHTTPServerTransport`.

An earlier draft of the plan used pnpm and Node 22. That was changed before any code was written, because the project should have one fast toolchain and because the SDK already tests the Bun path we need.

## Options

1. pnpm for installs, Node 22 as the process.
2. Bun for installs only, Node as the process.
3. Bun for installs and as the process (`bun src/index.ts` in an `oven/bun` image).

## Decision

Option 3.

- One workspace, one `bun.lock`, `bun install --frozen-lockfile` in image builds.
- Tests are `bun test`. The dashboard is built with Vite via Bun and served by nginx.
- HTTP is Hono on `Bun.serve`.
- Passwords use `Bun.password` (argon2id). Hashes and AES-GCM use Web Crypto. Postgres uses Drizzle on `Bun.sql`.
- Images are a pinned `oven/bun` Alpine tag, user `bun` (uid 1000).

The supported MCP protocol versions include `2025-06-18` and the newer revisions the pinned SDK accepts. Unknown versions are rejected.

## Why

One installer and one runtime removes a class of "works in the package manager, fails in the container" bugs. The SDK's own Bun test is the compatibility evidence for Streamable HTTP. `Bun.password` avoids a native addon on Alpine. Frozen lockfile installs are what makes an image build repeatable.

## Consequences

- Node-only libraries need a check before we depend on them. OpenTelemetry auto-instrumentation for Node is one of those; tracing is manual spans plus an OTLP HTTP exporter (see ADR 0007).
- The first implementation day includes a short experiment: boot the SDK's Streamable HTTP server under the pinned Bun version and call `initialize` from curl. That experiment gets its own file when it is run.
- If that experiment fails, this ADR is superseded rather than quietly switched back to Node.

## Update 2026-10-20

The pinned image moved from `oven/bun:1.2.19-alpine` to `oven/bun:1.4.3-alpine`. Under load the gateway's Bun 1.2.19 process crashed (`panic: index out of bounds`, multi-gigabyte core dumps, pod restarts); the same suites run clean on 1.4.3 ([experiment 0006](../experiments/0006-gateway-collapse-under-load.md)). The decision to use Bun stands. The lockfile is unchanged and `--frozen-lockfile` accepts it.
