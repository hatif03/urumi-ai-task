# 0001. Keep ADRs, experiments, and an engineering log from day one

- Status: accepted
- Date: 2026-10-14
- Outcome: the `docs/` record set exists. No cluster has been built yet, so there is no runtime evidence.

## Context

The internship submission asks for a README, a system-design note, and a threat model, and the interview will ask us to defend choices. Those three files describe the system at the end. They do not preserve the path: options rejected, trials that failed, and small improvements along the way.

Writing that history at the end means reconstructing it. Decisions already taken in planning (runtime, protocol, cluster shape) would otherwise live only in `plan.md`.

## Options

1. A single `plan.md` that is edited in place as we learn.
2. The three submission documents only, written just before the video.
3. Decision records, an experiment folder, and an append-only log, plus living copies of the system design and threat model.

## Decision

Option 3. The rules are in [docs/README.md](../README.md).

- Hard-to-reverse choices get `docs/adr/NNNN-title.md` when they are made.
- A trial whose result is unknown gets `docs/experiments/NNNN-title.md` before it runs, and a result the same day.
- Improvements, surprises, and reversals get a same-day entry in `docs/log.md`.
- `system-design.md` and `threat-model.md` track the current design and gain evidence notes once the cluster exists.
- An accepted ADR is superseded by a new file rather than rewritten.

## Why

Nygard's architecture decision records keep the context and the consequences next to the decision, and leave superseded records in place so a reversal is visible. An append-only log is the same habit as a lab notebook: the improvement is dated and linked to the record that explains it. Splitting experiments from decisions keeps a failed trial from looking like a flaky requirement.

## Consequences

- Every design change includes a documentation edit in the same work.
- `plan.md` can drift if we forget to update it after an ADR. The log entry is the reminder, and the plan is corrected to match the ADR.
- The submission docs stay short because the history is in `adr/`, `experiments/`, and `log.md`.
