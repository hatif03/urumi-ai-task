# 0002. How Bun SQL binds JSON parameters

- Date: 2026-10-20
- Related ADR: [0013](../adr/0013-provisioner-reconciler.md)

## Hypothesis

`insert ... values (${JSON.stringify(obj)}::jsonb)` stores a JSON object in a `jsonb` column, the same way Drizzle does for the gateway. If a string parameter is stored as a JSON string instead, `Object.keys(row.env)` would return indices and the provisioner's hosted-server rows would be wrong.

## Setup

A temporary table `t(j jsonb)` in the test Postgres (16-alpine), three inserts through `Bun.SQL`: a `JSON.stringify`'d object with `::jsonb`, a bare object with `::jsonb`, and a `JSON.stringify`'d array with `::jsonb`. Read back `typeof j` and `jsonb_typeof(j)`.

## Result

The stringified object and array came back as strings (`jsonb_typeof` = `string`): Bun JSON-encodes a string parameter once more because the declared type is `jsonb`. The bare object came back as an object. The provisioner test for hosted servers failed with `envNames: ["0","1","2",...]` before the fix.

## Decision

Cast through text: `${JSON.stringify(value)}::text::jsonb`. Parameters of type `text` are sent as-is, and the explicit cast parses them. Applied in `apps/provisioner/src/hosted.ts`. The gateway is unaffected because it writes JSON columns through Drizzle, which passes objects. A test (`provisioner.test.ts`, "input validation and secret handling") asserts `envNames` and `secretNames` round-trip as arrays.
