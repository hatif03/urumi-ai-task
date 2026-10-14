# 0008. Dev tooling and agent skills

- Status: accepted
- Date: 2026-10-14
- Outcome: Helm 4.3.0 and k3d 5.9.0 installed. WordPress, React, Kubernetes/Helm, and Bun/Hono skills copied into this repo for Cursor and Claude Code. Docker Desktop was installed but its engine was not running, so no cluster was created. Host WP-CLI was not installed.

## Context

The [WooCommerce AI guide](https://developer.woocommerce.com/docs/getting-started/ai/) points at a native MCP server, `llms-full.txt`, WP-CLI, and agent skills in `WordPress/agent-skills` and `woocommerce/agent-skills`. The assignment also forbids submitting an existing WooCommerce MCP server. The build needs Helm, k3d, Bun, and a way for both Cursor and Claude Code to follow the same stack rules.

## Options

1. Enable WooCommerce's MCP adapter and `@automattic/mcp-wordpress-remote` as the store connection.
2. Install every related skill pack, including merchant-operation skills and the in-process Abilities playbook.
3. Install the CLIs the chart needs, install the skills that match the ADRs, and keep WooCommerce's MCP as documentation only.

## Decision

Option 3. The inventory and the commands are in [docs/tooling.md](../tooling.md).

- Helm and k3d are installed on the machine. kubectl, Docker, and Bun were already there.
- WP-CLI runs from the `wordpress:cli` image in the bootstrap Job, not from a host PHP install.
- Skills are project-scoped copies for the `cursor` and `claude-code` agents: `wp-wpcli-and-ops`, `wp-rest-api`, `wp-abilities-api`, `vercel-react-best-practices`, `kubernetes-helm`, `bun-hono-integration`, plus `urumi-stack` written in this repo.
- `mcp_integration` stays off. MCP Inspector is the client for our gateway.

## Why

The official MCP endpoint is a developer preview inside WordPress ([MCP integration](https://developer.woocommerce.com/docs/features/mcp/)). Shipping it would fail the "write it yourself" requirement. The WordPress skills still help with `wp` in the bootstrap Job and with reading REST and Abilities docs. The React, Helm, and Bun/Hono skills match ADR 0002, ADR 0004, and ADR 0005. One project install with `--agent cursor --agent claude-code` keeps both tools on the same instructions.

## Consequences

- A new shell is required before `helm` and `k3d` resolve, because winget changed `PATH`.
- `k3d cluster create` waits on Docker Desktop being started.
- `wp-abilities-api` describes the official adapter. `urumi-stack` tells agents not to implement our server that way. If those two conflict in practice, the conflict is recorded here and in the log, and `urumi-stack` wins.
