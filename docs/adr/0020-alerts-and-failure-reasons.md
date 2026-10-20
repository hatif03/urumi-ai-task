# 0020. Alerts, and a reason with every failure

- Status: accepted
- Date: 2026-10-20
- Outcome: `rules.yml` is part of the Prometheus ConfigMap and is loaded by Prometheus; `explainFailure()` is covered by the router tests (unreachable upstream shows a `connection refused` or `timeout` reason). The alert firing on a killed upstream is recorded in `docs/log.md`.

## Context

The brief's observability item asks for metrics (calls, error rate, latency per server) and clear reporting of why an upstream is unreachable or why a call failed. ADR 0007 added the metrics and traces; there were no alert rules, and the dashboard showed "Unreachable" with the raw exception text.

## Decision

- `explainFailure()` in the router classifies an error into one short sentence an admin can act on: `blocked by SSRF policy`, `timeout`, `dns`, `connection refused`, `tls`, `upstream rejected the credential`, `connection dropped`, or `protocol or upstream error`, followed by the message (200 characters). That is stored in `mcp_servers.status_detail` and shown on the server card.
- Prometheus rules in the chart: `UpstreamDown` (`upstream_up == 0` for a minute), `ToolErrorRatioHigh` (over 20% of calls to a server failing for five minutes), `GatewayToolLatencyP95High` (over three seconds), `RateLimitRejections`, `StoreProvisioningFailed`, `StoreProvisioningStuck`.
- Provisioner metrics: `stores_by_status`, `hosted_by_status`, `store_provision_duration_seconds`, `provision_failed_total{phase}`, `provisioner_step_errors_total{phase}`.
- A failed store keeps the phase it failed in and the last error (Helm's message plus the names of pods that are not Ready).

## Why

An alert nobody can act on is noise; each rule's annotation says where to look. Classifying at the point of failure is cheaper and more reliable than parsing strings later.

## Consequences

- There is no Alertmanager, so an alert is visible in the Prometheus UI and Grafana but nothing pages anyone. The notification path (Alertmanager with a webhook or email receiver, or Grafana alerting contact points) is documented in the runbook as the next step; it needs a destination the operator owns.
- Classification is regex over messages, so a new error text falls into "protocol or upstream error" until someone adds a case.
