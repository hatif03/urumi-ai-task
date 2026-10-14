---
name: urumi-stack
description: Boundaries for the Urumi MCP gateway project. Use when choosing a runtime, calling WooCommerce, writing Helm, or deciding whether to use WooCommerce's built-in MCP adapter.
---

# Urumi stack boundaries

Read `docs/adr/` and `docs/tooling.md` before changing the stack.

## Build this

- TypeScript on Bun. One `bun.lock`. Images from `oven/bun`. HTTP is Hono on `Bun.serve`.
- The WooCommerce integration is a Bun MCP server we write. It calls `wc/v3` with the consumer key and secret. Tools: list products, create product, list orders, get order, update order status. Streamable HTTP, stateless, JSON responses.
- The gateway is the only public MCP endpoint. It prefixes tools as `{slug}__{name}`.
- Deploy with the Helm chart in `deploy/helm/urumi` and kubectl. Local cluster is k3d. Production target is k3s.
- Ingress is ingress-nginx on both clusters, as in ADR 0005. The `kubernetes-helm` skill prefers the Gateway API because ingress-nginx maintenance changed in 2026. Do not switch this project to Gateway API unless a new ADR says so.

## Do not build this

- Do not enable WooCommerce `mcp_integration`.
- Do not add `@automattic/mcp-wordpress-remote` or `wp mcp-adapter serve` as the store's MCP server.
- Do not put the MCP server inside WordPress via the Abilities API. `wp-abilities-api` is background for the official preview described at https://developer.woocommerce.com/docs/features/mcp/.
- Do not switch the JavaScript toolchain to npm or pnpm.

## When a fact is missing

WooCommerce developer docs, including REST and CLI, are in https://developer.woocommerce.com/docs/llms-full.txt. A single page is the same URL with `.md` appended.

New decisions, experiments, and improvements go in `docs/adr/`, `docs/experiments/`, and `docs/log.md` in the same change.
