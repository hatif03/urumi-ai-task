# 0021. Upgrades and rollback with Helm: what is safe to roll back and what is not

- Status: accepted
- Date: 2026-10-20
- Outcome: `scripts/rollback-rehearsal.sh` on the k3d cluster (`docs/evidence/rollback-rehearsal-2026-10-20.txt`): upgrading to a gateway image that exits on start with `--atomic` left revision 12 `failed` and revision 13 `Rollback to 11`; a probe of `/mcp` every second during the failed rollout got 150 answers and 0 failures; the audit table kept its rows (83 before, 233 after, the growth being the probe's own rejected calls); `helm test` succeeded. Helm 4 deprecates `--atomic` in favour of `--rollback-on-failure`.

## Context

The brief asks to show or document how the store, the MCP server and the gateway are upgraded with Helm and how to roll back safely.

## Decision

- Platform release (`urumi`): `helm upgrade --install` with `--atomic --wait --timeout 10m` in production, so a failed rollout reverts itself. `helm history urumi -n platform` lists revisions; `helm rollback urumi <revision> -n platform --wait` returns to one.
- The images are tagged by version in production values, never by a moving tag, so a rollback restores the image that ran. (Locally the tag is `local` and `dev-up.sh` restarts pods after a rebuild.)
- Database changes ship as append-only migrations (ADR 0009). A rollback across a migration is safe only when the older code tolerates the newer schema; every migration so far only adds tables or columns, which the older gateway ignores. The runbook says to read the migration list between the two revisions first.
- Stores: each store is its own release, `helm upgrade store-<slug> -n store-<slug>` with the new chart; rolling back is `helm rollback`. WooCommerce plugin upgrades run database migrations that are forward-only, so snapshot the two PVCs first (VolumeSnapshot where the StorageClass supports it, otherwise `mysqldump` and a tar of `wp-content`) and restore from the snapshot, not by rolling the chart back.
- A `helm test` hook (`templates/tests/smoke.yaml`) runs the smoke script against the release.
- PodDisruptionBudgets and `maxUnavailable: 0` rolling updates keep at least one gateway replica serving during an upgrade; MCP sessions are not affected because they carry no server state (ADR 0003).

## Why

`--atomic` turns the common failure (a pod that never becomes Ready) into an automatic rollback. Pinning image tags is what makes a rollback mean something. Naming the forward-only parts is more useful than claiming everything rolls back.

## Consequences

- `helm rollback` does not undo a deleted PVC or a dropped column; deleting the release does not delete PVCs (they are kept by default), which is the safety net for the store.
- Upgrading the provisioner while a store is mid-install is safe: the new pod resumes the row after the old lease expires.
