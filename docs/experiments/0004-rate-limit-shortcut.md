# 0004. Does the in-memory rate-limit shortcut hold the limit?

- Date: 2026-10-20
- Related ADR: [0007](../adr/0007-scale-and-observe-from-the-first-deploy.md)

## Hypothesis

ADR 0007 described "a one-second in-memory shadow for calls that are clearly inside the budget" next to the shared Postgres token bucket. If the shadow only skips the database when the bucket is far from empty, a caller limited to N per minute never exceeds N per minute by more than a small margin. If the shadow grants credit independent of the real bucket, the limit would not hold.

## Setup

A test with `rateLimitPerMinute: 2` and four immediate chat-actor calls to one tool through `ToolRouter.call`, expecting `ok, ok, rate_limited, rate_limited`.

## Result

The test got four `ok`. The shadow set `tokens: 20` after any allowed call whatever the limit was, so for the next second up to 20 calls were admitted without consulting the bucket: at the default limit of 60 per minute a caller could make about 1200 calls per minute by calling continuously. The limit existed only for slow callers.

## Decision

Delete the shadow. Every limited call performs the single `insert ... on conflict do update ... where` on the `throttle` table; at the call volumes of this system that is about a millisecond. The `hardening` test in `features.test.ts` pins the behaviour. ADR 0007's description of the shadow is superseded by this note and ADR 0009 (the table). Recorded in `docs/log.md`.
