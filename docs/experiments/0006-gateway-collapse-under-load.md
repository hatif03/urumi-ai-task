# 0006. Why the gateway collapsed under 40 concurrent callers

- Date: 2026-10-20
- Related ADR: [0022](../adr/0022-admission-control-and-autoscaler-ownership.md), [0002](../adr/0002-bun-runtime-and-workspaces.md)

## Hypothesis

The gateway keeps up with a few dozen concurrent tool calls on one laptop node: each call is a handful of one-millisecond database queries and one call to an in-cluster upstream. If throughput collapses, the cause is CPU per call (the OTLP span export and the MCP client library were the suspects) or an unbounded queue that starves the health probes.

## Setup

`scripts/loadtest.ts` through the ingress (40 workers, `utility__echo`, rate limit raised, HPA max 4), then an in-cluster load generator hitting `gateway.platform.svc` directly, then in-pod timing of each stage (`process.cpuUsage()` around 40 sequential calls), then the same load against a local gateway process with the real Postgres.

## Result

1. Through the ingress, throughput fell to about 2 calls a second and 31% to 47% of calls failed with 502 or timed out. The gateway pods showed restarts, and `kubectl describe` showed liveness probe timeouts. Node CPU was about 8%.
2. In-pod timing: one call cost 38 ms CPU. Stage costs: database queries 0.6 to 1.2 ms CPU each (six per call), the MCP client library's `callTool` 15 ms CPU against 5.5 ms for a raw `fetch` of the same JSON-RPC, and an OTLP export request per span (three to four per call). Fixes made on that evidence: batched span export (one request a second), one fewer cache read and one fewer user lookup per call, `last_used_at` written once a minute, and a per-replica ceiling on calls in flight so a busy pod answers "busy" quickly instead of queueing the health probes behind the load ([ADR 0022](../adr/0022-admission-control-and-autoscaler-ownership.md)).
3. These helped (per-call CPU and the first-window latency improved) but did not remove the collapse. A local gateway process against the same Postgres handled 40 and 150 concurrent calls without trouble, which pointed away from the application logic.
4. The decisive finding was in `%LOCALAPPDATA%\Temp\wsl-crashes`: core dumps named `_usr_local_bin_bun`, 2 to 3.5 GB each, about 18 GB in all, written during the load runs. The Bun process in the gateway container was **crashing**; Kubernetes restarted the pod and the load fell on the others. The same panic reproduced outside the cluster while running the database-backed tests in one process: `panic(main thread): index out of bounds: index 0, len 0`. The dumps also filled the disk, which truncated a source file mid-write.
5. A smaller race was found on the way by the concurrency sweep: `replaceTools` deleted and re-inserted a server's tool cache in two statements, so a call arriving between them was answered "unknown tool", and concurrent cold calls each opened their own upstream connection. Fixed with a transaction and a shared connect attempt; both have regression tests.
6. The same test suites, run twice under Bun 1.4.3 (the current release; the project had pinned 1.2.19), passed 107 of 107 with no panic. The base image was moved to `oven/bun:1.4.3-alpine`, the lockfile was accepted unchanged under `--frozen-lockfile`, and the same load run through the ingress afterwards (40 workers, 60 seconds) completed 3508 calls at 58 a second with 99.46% success, no pod restarts, and the HPA taking the gateway from 2 to 4 replicas (`docs/evidence/loadtest-2026-10-20.txt`). The 0.54% of failures are the admission ceiling answering `overloaded`. An in-cluster sweep before the fix (1, 4, 8, 16, 24, 40 workers) had already shown 38 to 65 calls a second with p50 under 320 ms once the cold-start races were out of the way.

## Decision

- Pin `oven/bun:1.4.3-alpine`. The pin is a decision about a runtime bug, not a preference: ADR 0002 (Bun) stands, with an update note.
- Keep admission control, batching and the race fixes: each is correct independently of the crash, and the ceiling is what keeps a healthy pod from being restarted for being busy.
- Process lesson for the interview: a throughput problem with 8% node CPU, restarts and 502s is a crash and a queue before it is an algorithm. Look at `kubectl describe pod`, previous logs and node-level crash artefacts first.
