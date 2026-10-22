# 0003. Why the WooCommerce MCP pods went NotReady during a busy rebuild

- Date: 2026-10-20
- Related ADR: [0005](../adr/0005-one-helm-chart-two-value-files.md), [0007](../adr/0007-scale-and-observe-from-the-first-deploy.md)

## Hypothesis

A readiness probe that performs a WooCommerce REST call inside the probe handler fails when WordPress takes longer than the probe's one-second default timeout, which is easy to hit on a laptop that is also building images. The pods would then be marked NotReady, the Service would lose its endpoints, and the gateway would report the store as unreachable although nothing is broken. If instead the pods are NotReady for another reason (a crash, a policy), the logs would say so.

## Setup

During the second image rebuild (six `docker build`s and `k3d image import`s running, the k3d node at about 165% CPU) the first end-to-end run showed a member's `woocommerce__list_orders` failing with "Unable to connect" while the same call had worked minutes earlier. `kubectl -n store get pods` showed both `woocommerce-mcp` pods `0/1 Running`. Their logs showed `/wp-json/wc/v3/products?per_page=1` answering 200 in 0.9 to 2.0 seconds every ten seconds. WordPress itself had restarted twice.

## Result

Confirmed. `ready()` called WooCommerce synchronously, took 1 to 2 seconds under load, and exceeded the default `timeoutSeconds: 1`. Grafana showed the same family of problem: ~200 database migrations on every start (its SQLite file is not persisted) outlast the default liveness window and the pod was killed in a loop (25 restarts in six days).

## Decision

- The WooCommerce MCP server answers `/readyz` from a background check that runs every ten seconds and is considered fresh for 45 seconds; the probe itself returns in milliseconds. Readiness still reflects the store, within seconds.
- `timeoutSeconds: 3` on the MCP probes and `5` on WordPress probes, in both charts.
- Grafana gets a startup probe (36 attempts, 5 seconds apart).
- No ADR supersession: ADR 0007's two-replica, probe-everything position stands; this is a parameter correction. Recorded in `docs/log.md`.
