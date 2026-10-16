# 0011. SSRF: validate, resolve once, connect to the checked address, and deny at the network

- Status: accepted
- Date: 2026-10-20
- Outcome: `ssrf.test.ts` covers private IPv4 and IPv6 ranges, IPv4-mapped IPv6, NAT64, local-only names, userinfo and schemes, the regression for names starting with `ff`, and a pinned fetch that connects to the checked address with the original Host header. The cluster NetworkPolicy result is recorded in `docs/security-test-log.md`.

## Context

An admin can add an MCP server by URL, and the OAuth Client ID Metadata Document flow makes the gateway fetch a URL a stranger chose. Both are server-side request forgery risks: cluster-internal addresses, the node's metadata endpoint (169.254.169.254), the Kubernetes API. The first version had three defects: a hostname starting with `ff` was rejected as IPv6 multicast, IPv4-mapped IPv6 literals were not recognised, and the DNS answer was checked and then thrown away, so the connection resolved again (a DNS rebinding window).

## Options

1. A hostname deny list.
2. Resolve, check every address, connect to the checked address.
3. Option 2 plus a NetworkPolicy that denies private egress from the gateway.

## Decision

Option 3. `resolveUpstream()` parses the URL (http or https only, no userinfo), blocks known metadata names, local-only suffixes (`.local`, `.internal`, `localhost`), and every address in `node:net` BlockList ranges (private, loopback, link-local, CGNAT, multicast, documentation, IPv6 unique-local). It judges the IPv4 address embedded in `::ffff:` and `64:ff9b::` literals. Every DNS answer must be public, except for names ending `.svc.cluster.local` (other than the Kubernetes API) and exact hosts on an operator allowlist. For http upstreams `pinnedFetch` connects to the checked IP and keeps the Host header. Names are re-resolved on every new connection. The gateway's NetworkPolicy allows egress to the internet except 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10 and 127/8, and to specific in-cluster targets.

## Why

A deny list of names cannot see what a name resolves to. Checking and then connecting separately leaves a window where a hostile DNS server answers differently. For https, connecting by IP breaks the certificate name check, so pinning is not applied there; the NetworkPolicy is the control that still holds, because it works on the packet, not on the name.

## Consequences

- https upstreams rely on the network layer for the rebinding case. On a cluster without a NetworkPolicy controller that layer is absent; the docs say so.
- `*.svc.cluster.local` is trusted by name. Another tenant's namespace is reachable only if its NetworkPolicy admits the gateway.
- Redirects are never followed from an upstream.
