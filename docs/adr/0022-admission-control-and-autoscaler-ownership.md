# 0022. Admission control in the gateway, batched span export, and the autoscaler owns replica counts

- Status: accepted
- Date: 2026-10-20
- Outcome: [`docs/evidence/loadtest-2026-10-20.txt`](../evidence/loadtest-2026-10-20.txt), 40 concurrent callers for 60 seconds through the ingress on one laptop node: 3508 calls, 58 a second, 99.46% success, p50 about 450 ms, no pod restarts, and the HPA took the gateway from 2 to 4 replicas (CPU 287% of target). The 0.54% that failed are the gateway answering `overloaded` (HTTP 200, JSON-RPC error -32005) once a replica reached its in-flight ceiling, which is the intended behaviour. The earlier collapse (2 calls a second, 31% to 47% failures) was a Bun 1.2.19 crash inside the pod, found afterwards ([experiment 0006](../experiments/0006-gateway-collapse-under-load.md)); the changes below were made on the way and are kept because each is right on its own.

## Context

The brief's scaling stand-out asks to run more than one gateway replica and show that sessions and upstream connections still work, with rate limits per user or key. Two replicas, a shared Postgres rate limit and an HPA existed. Pushing the system showed:
1. Each tool call costs a replica about 15 to 38 ms of CPU (the router, the MCP client library, span export). A replica therefore has a ceiling. Past it, queueing every request makes every request slow and the health probes queue behind them; Kubernetes restarts a pod that is merely busy and its load lands on the others.
2. One OTLP HTTP request per span (three or four per call) cost more CPU than some of the work it described.
3. Every Deployment set `replicas:` and also had an HPA. A value in the chart is reset by each `helm upgrade` and, under Helm 4's server-side apply, conflicts with the autoscaler's ownership of `.spec.replicas` ("conflict with k3s subresource scale").
4. A concurrency sweep exposed two races: a server's tool cache was replaced with a delete and an insert in two statements (a call between them got "unknown tool"), and concurrent calls on a cold replica each opened their own upstream connection.

## Options

1. Raise CPU limits and probe timeouts only.
2. Admission control per replica: a bounded number of calls in flight, a fast "busy" answer beyond it.
3. A queue with back-pressure in front of the router.

## Decision

- **Admission control** (`ToolRouter.call`): at most `MAX_INFLIGHT_CALLS` (default 24) calls in flight per replica; the next is answered at once with JSON-RPC `-32005`, `error.data.code = "overloaded"`, audited as `error`, counted in `calls_shed_total`, with `calls_inflight` as a gauge. A client can retry; the HPA sees the CPU and adds replicas; the probes keep answering.
- **Span batching** (`packages/obs/src/trace.ts`): spans are queued and sent in one OTLP request a second (or at 100 spans), with a cap of 1000 queued spans if the collector is down.
- **Fewer round trips per call**: one tool-cache read instead of two, the user loaded once during authentication, `last_used_at` written at most once a minute per key.
- **Races**: `replaceTools` is one transaction; concurrent cold calls share one connection attempt (`connecting` map). Regression tests in `postgres.test.ts` and `features.test.ts`.
- **Probe timeouts** of 3 seconds on gateway readiness and liveness.
- **Autoscaler ownership**: the three Deployments no longer set `replicas`; the HPA's `minReplicas` is `replicas.*` from values.

## Why

Bounded concurrency is the standard way to keep a latency-sensitive server alive past its capacity; it turns an unbounded queue into an explicit error the client can act on. A queue (option 3) would hide the same overload behind long waits. Removing `replicas` from a Deployment that has an HPA is the documented Kubernetes practice. Batching is what every OTLP SDK does by default. The transaction and the shared connect are the minimal fixes for the two races.

## Consequences

- Under sustained overload some calls fail fast with "busy". With two to four replicas the ceiling is 48 to 96 concurrent calls; the clients in the load test (40 workers) saw 0.54%.
- The first install creates each Deployment with one replica until the HPA raises it to the minimum of two (seconds); `maxUnavailable: 0` keeps rollouts safe afterwards.
- One laptop node cannot show throughput scaling: the replicas and the load generator share CPUs. The HPA decision is shown (2 to 4); linear throughput is not claimed.
- The MCP client library is a large part of the per-call cost (15 ms CPU against 5.5 ms for a raw request). A direct JSON-RPC call for stateless upstreams would roughly halve it; it was not done because third-party upstreams that need a session rely on the library.
