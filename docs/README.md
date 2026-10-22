# Documentation

This directory is the project record. It starts with the planning decisions and is updated on the same day as any later decision, experiment, or improvement.

`plan.md` at the repo root is the build plan. These files are the history of what we decided, what we tried, and what happened.

## What goes where

| Path | Holds |
| --- | --- |
| [adr/](adr/README.md) | One architecture decision record per decision that would be costly to reverse |
| [experiments/](experiments/README.md) | One file per trial whose result we do not already know |
| [log.md](log.md) | Append-only notes: improvements, surprises, rework, demo findings |
| [system-design.md](system-design.md) | The architecture as we currently intend to build and run it |
| [threat-model.md](threat-model.md) | Who can do what, and whether we have shown the control on a real cluster |
| [plan-round1-completion.md](plan-round1-completion.md) | The plan for everything after the first core build: audit findings, phases, status |
| [data-model.md](data-model.md) | Every table and value, its type and why |
| [api.md](api.md) | Every HTTP route and its auth |
| [mcp-internals.md](mcp-internals.md) | The path of one tool call, names, deadlines, the failure matrix |
| [dashboard.md](dashboard.md) | The React dashboard: pages, state, accessibility |
| [vps-deploy.md](vps-deploy.md) | Local to production-like VPS: what changes, TLS |
| [runbook-upgrade-rollback.md](runbook-upgrade-rollback.md) | Upgrade, rollback, rotate, back up, recover |
| [security-test-log.md](security-test-log.md) | The security claims tried against the cluster, with output |
| [demo-script.md](demo-script.md) | The video, section by section, with commands |
| [evidence/](evidence/) | Raw output of `scripts/e2e.ts`, `security-check.ts`, `oauth-demo.ts`, load test and rollback rehearsal |
| [study/](study/00-start-here.md) | Interview study material and verified learning resources |

The README at the repo root is the operator guide (local setup, VPS, checkout, MCP client, chat). It is written when there is a system to operate. Until then, start here.

## Rules

- A decision is recorded in `docs/adr/` in the same change that adopts it. The outcome line is updated when a test, smoke script, or demo shows what actually happened.
- An accepted ADR is not edited into a different decision. A reversal is a new ADR with status `accepted` that points at the old one, and the old one is marked `superseded`.
- An experiment file is created before the trial and closed the same day with the result and what we kept.
- `docs/log.md` gets an entry on the same day as an improvement, a failed attempt, or a change in course. The entry links to the ADR or experiment.
- `system-design.md` and `threat-model.md` stay aligned with the latest accepted ADRs. When the running cluster differs from those files, the files change in that same change.

## Status words

| Status | Meaning |
| --- | --- |
| `proposed` | Written, not yet adopted |
| `accepted` | We are building or running this |
| `superseded` | A later ADR replaced it; the file stays |
| `rejected` | We considered it and did not adopt it |

Outcome is separate from status. A new decision starts as `accepted` with outcome `not yet built`. After verification the outcome names the evidence.
