# Experiments

An experiment is a trial whose result we do not already know. Examples: whether the pinned Bun version serves the MCP SDK's Streamable HTTP transport, which WordPress tag pairs cleanly with the WooCommerce plugin version, which tool-list timeout keeps a dead upstream from delaying the others, whether the laptop can schedule two replicas plus Grafana.

A decision we have already made is an ADR, not an experiment. If the experiment overturns an ADR, write a new ADR that supersedes the old one and link it from the result.

## How to add one

1. Copy the template below to `docs/experiments/NNNN-short-title.md`. Use the next number.
2. Fill in hypothesis and setup before running the trial.
3. The same day, fill in result and decision, and add a `docs/log.md` entry that links here.
4. Add a row to the index below.

## Index

| ID | Title | Result |
| --- | --- | --- |
| 0001 | Bun serves a stateless MCP initialize | Kept Bun. `initialize` returned `2025-06-18` as one JSON object. |

## Template

```markdown
# NNNN. Title

- Date:
- Related ADR:

## Hypothesis

What we expect, and what result would change our mind.

## Setup

Commands, versions, cluster, and what was deliberately kept constant.

## Result

What happened, including numbers or the error text. Link a log excerpt or a metric rather than paraphrasing only.

## Decision

What we kept, what we dropped, and the ADR created or superseded.
```
