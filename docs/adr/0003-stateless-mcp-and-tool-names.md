# 0003. Stateless Streamable HTTP and prefixed tool names

- Status: accepted
- Date: 2026-10-14
- Outcome: On the k3d cluster, `tools/list` returned nine prefixed tools from utility, policy, and WooCommerce. A disabled utility server dropped `utility__*` from the next list. Protocol tests cover one JSON object, a 400 for a batch body, and 405 for GET.

## Context

Clients (Cursor, Claude Code, MCP Inspector) talk to one gateway endpoint. The gateway talks to every enabled upstream. The assignment requires Streamable HTTP, a single tool list, routing to the right server, a documented collision scheme, and a dead upstream that does not take the others down.

The 2025-06-18 transport uses one HTTP endpoint. A request is one JSON-RPC object. Batches are not part of that revision; clients such as Claude Code reject array responses. Session ids are optional.

## Options

1. Stateful sessions with affinity, as Kuadrant does: a client session mapped to a backend session.
2. Stateless JSON responses: `POST /mcp` returns one JSON object, `GET` and `DELETE` return 405, no `Mcp-Session-Id`.
3. Tool identity: flat names, a `server` argument on every tool, or a name prefix.

## Decision

Option 2 for the transport. Prefixed names `{serverSlug}__{toolName}` for identity, stripped before the upstream call. The slug is fixed at registration.

Three upstreams are deployed in-cluster and seeded: `woocommerce`, `utility` (`get_current_time`, `echo`), and `policy` (`get_return_policy`, `list_shipping_options`). `tools/list` fans out in parallel with a 3 second deadline per server and returns whichever servers answered. A 30 second Postgres cache absorbs repeated lists. Idempotent reads retry once. Creates and order updates do not.

## Why

Microsoft's MCP Gateway moved to per-request routing so any replica can answer. Our tools do not need server memory, so a session map would add affinity without a benefit. Kuadrant's prefix is the collision scheme that keeps `list_orders` unambiguous when two servers export it. In-cluster extra servers keep the two-server prompt and the kill-pod test independent of a public MCP host.

## Consequences

- A third-party upstream that requires a session still works on the replica that opened the client. The warm client is a per-replica cache, not shared state. A broken client is dropped and opened again.
- Upstream tool names that themselves contain `__` are skipped and reported on that server's status.
- The chat agent and external clients see the same prefixed names, because both go through the gateway catalog.
