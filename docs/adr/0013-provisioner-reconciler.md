# 0013. A separate provisioner that drives Helm through a database-backed state machine

- Status: accepted
- Date: 2026-10-20
- Outcome: `apps/provisioner/src/provisioner.test.ts` (26 tests, real Postgres, fake cluster) covers the happy path, three stores at once, a restart in every phase, a killed install, a deadline, a failed install and retry, a foreign namespace, teardown order, a delete during an install, a delete that cannot finish, the per-user cap under parallel creates, and the HTTP contract. The cluster run is recorded in `docs/log.md` and `docs/evidence/`.

## Context

The bonus asks for create and delete from the dashboard, Kubernetes-native provisioning in a namespace per store, automatic MCP registration, clean teardown, parallel provisioning, a per-user cap, a timeout, and safe retry after a restart mid-provisioning.

## Options

1. Do it inside the gateway process.
2. A Kubernetes operator with a Store CRD and controller-runtime.
3. A small service with its own Deployment that stores desired state in Postgres and reconciles it, running `helm upgrade --install` and `helm uninstall`.

## Decision

Option 3. Why separate: the gateway parses untrusted upstream output and must hold no Kubernetes rights. `apps/provisioner` is the only workload with a service account that can touch the API.

State is the `stores` and `hosted_servers` tables: `status` (provisioning, ready, failed, deleting), `phase`, `reason`, `attempt`, `deadline_at`, a lease (`lease_owner`, `lease_until`) and `next_run_at` for backoff. A worker claims a row with `update ... where id = (select ... for update skip locked)`, runs that row's phases, and writes the phase after each one with a compare-and-set on `status`. Phases: `namespace, secrets, release, register, ready` and `unregister, uninstall, namespace, drain, forget`. Every phase is idempotent: namespaces and Secrets are created if missing and never overwritten (so a retry cannot change a password MariaDB already used), a release found in a pending or failed state is uninstalled before install, the gateway registration is an upsert, and deleting a missing thing is success. Past `deadline_at` a provisioning row becomes `failed` with the phase and the last error. A heartbeat extends the lease during `helm --wait` and cancels the step if a delete request changed the row. Create is idempotent on the slug and the per-owner limit is counted under an advisory lock.

## Why

Helm gives one reviewed definition of a store, `upgrade --install` as the retry primitive, `uninstall` as teardown, and `helm get values` as the record of what was applied. A database row survives a pod restart, and `skip locked` lets several workers (or pods) take different stores, which is how several stores provision at once. A CRD controller would be the Kubernetes-idiomatic form of the same loop; it adds a CRD, a code generator and a second source of truth next to the gateway's Postgres for no extra capability at this scale.

## Consequences

- A store's desired state lives in Postgres, not in the cluster. Losing the database loses the list of stores, not the stores; the namespaces carry `urumi.io/store` labels so they can be re-adopted by hand.
- `failed` is final until a user presses retry. A transient cluster error inside a step is retried with backoff until the deadline; a helm failure is not retried automatically.
- Deleting a namespace is asynchronous: the `drain` phase waits until the namespace and its PersistentVolumes are gone, and a delete that cannot finish stays `deleting` with its reason.
- One pod is enough; a second pod is safe because of the lease.
