# 0005. `expect(promise).rejects.toMatchObject(...)` on error objects under Bun 1.2.19

- Date: 2026-10-20
- Related ADR: none (test tooling)

## Hypothesis

`await expect(createStore(...)).rejects.toMatchObject({ status: 409 })` fails the test if the promise resolves and passes if it rejects with an object that has `status: 409`.

## Setup

The provisioner tests use a small `StoreError extends Error` with a `readonly status`. Several tests used the matcher above.

## Result

Most of the calls worked. One call hung until the test timeout (a rejection of `retryStore` for a store that was not failed), and swapping it for `promise.then(() => "resolved", (e) => `rejected ${e.status}`)` returned `rejected 409` immediately, so the production code was correct and the matcher was not. The cause was not isolated.

## Decision

The provisioner tests compare by hand through `expectStatus(promise, status)`. Not worth chasing the Bun internals; if the repository moves to a newer Bun, try the matcher again. Mentioned here so a future reader does not "simplify" the helper away.
