# 0007. Two replicas, rate limits, metrics, and traces in the core

- Status: accepted
- Date: 2026-10-14
- Supersedes: the earlier planning choice to ship one gateway replica and add Prometheus after the demo
- Outcome: Two gateway replicas were Ready. Deleting one left `/readyz` at 200 on the other, and a replacement pod came back. `/metrics` on port 9090 includes `tool_calls_total`. Prometheus, Grafana, Tempo, and the collector were Running.

## Context

The first plan treated a second replica, rate limits, and Prometheus as optional stand-outs. The project priority is speed, reliability, scalability, and observability from the first deploy. A single replica with logs only cannot show that a second pod serves traffic, or why an upstream failed, except by reading a pod log during the video.

## Options

1. One replica, JSON logs, add metrics later.
2. Two replicas with logs and a `/metrics` port, scrape them during the demo with no stored dashboard.
3. Two replicas, a shared rate limit, Prometheus, Grafana, and OpenTelemetry traces, installed by the same Helm chart.

## Decision

Option 3.

- Gateway, dashboard, and the three MCP servers run at 2 replicas in local and production values. WordPress and MariaDB stay at 1 (ADR 0004).
- No session affinity. PodDisruptionBudget `minAvailable: 1`. HPA on CPU 70%, minimum 2, maximum 4 in production. Local values set maximum equal to minimum so a laptop does not scale during the demo.
- Probe ownership is a conditional update on `last_checked_at` so one replica probes an upstream at a time. Status in Postgres is what every replica reads.
- Per-key token bucket in Postgres, default 60 tool calls per minute, with a one-second in-memory shadow for calls that are clearly inside the budget.
- `packages/obs` provides JSON logs, a Prometheus registry, and W3C trace context. Trace id is on the log, the audit row, `traceparent` to upstreams and WooCommerce, and the HTTP response.
- `/metrics` is port 9090 and is not on the Ingress. The chart runs Prometheus (6h, 2Gi), Grafana with a committed dashboard, an OpenTelemetry Collector, and Tempo on 1Gi. Spans are manual, exported over OTLP HTTP, because Node auto-instrumentation is not the Bun path.

## Why

Microsoft's stateless router is what makes a second replica correct. A shared probe lease and a shared rate-limit bucket are what make the second replica agree with the first. Metrics and traces are how we see that agreement: `upstream_up`, latency per server, and a trace id that joins a Grafana view to an audit row. Installing them in the first chart avoids a second design once the demo is already wired to a single pod.

## Consequences

- The local cluster is heavier: two copies of each Bun service plus Prometheus, Grafana, Tempo, and the collector. Resource requests in `values-local.yaml` have to leave room for WordPress and MariaDB. If the laptop cannot start, the first knob is observability retention and Grafana memory, not dropping the gateway back to one replica. That tradeoff, if it happens, is an experiment and then either a values change or a superseding ADR.
- Alert rules and a load test that scales 2 to 4 stay optional depth on top of this, not a substitute for it.

## Update 2026-10-20

The "one-second in-memory shadow" described above was removed because it admitted far more calls than the limit ([experiment 0004](../experiments/0004-rate-limit-shortcut.md)). Trace propagation, which this ADR described, was only partly wired at the time; it now is (W3C `traceparent` through the gateway, the MCP adapter and the WooCommerce call, verified in Tempo by `scripts/trace-check.ts`). Alert rules were added ([ADR 0020](0020-alerts-and-failure-reasons.md)).
