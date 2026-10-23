# Runbook: upgrade, rollback, rotate, recover

Commands assume `-n platform` is the release namespace and `urumi` the release name. Decisions behind this are in [ADR 0021](adr/0021-upgrade-and-rollback.md) and [ADR 0009](adr/0009-versioned-migrations-and-shared-throttle.md).

## Before any upgrade

```sh
helm history urumi -n platform                      # which revision is live, what changed
helm get values urumi -n platform -o yaml > values-before.yaml
kubectl -n platform get pods                        # everything Ready before you start
git diff <old-tag>..<new-tag> -- apps/gateway/src/migrations.ts apps/provisioner/src/db.ts   # schema changes in this upgrade
```

Read the migration diff. Every migration so far only adds a table, a column or an index, which an older gateway ignores. If a migration drops or renames something, a rollback needs a restore from backup instead (below).

## Upgrade the gateway, the MCP servers, the dashboard or the provisioner

1. Build and push images with a **new version tag**. Never reuse a tag; a rollback restores the image that ran only if the tag still points at it.
2. Upgrade with automatic rollback on failure:
   ```sh
   helm upgrade urumi deploy/helm/urumi -n platform -f deploy/helm/urumi/values-prod.yaml \
     --set images.gateway.tag=1.4.0 --atomic --wait --timeout 10m
   ```
   `--atomic` reverts the release if a pod does not become Ready (Helm 4 renames it `--rollback-on-failure` and still accepts `--atomic` with a deprecation warning). Gateway, dashboard and the MCP servers roll with `maxUnavailable: 0, maxSurge: 1`, so at least the old number of pods keeps serving while a new one starts; a PodDisruptionBudget keeps one up during node drains.
3. Prove it: `helm test urumi -n platform` (checks gateway readiness, the OAuth challenge, the dashboard, the storefront and the provisioner), then `bun scripts/e2e.ts`.

MCP clients are not disturbed: the gateway keeps no per-client session, so a request that lands on a new pod works exactly like one on an old pod. A tool call in flight on a pod that is being replaced finishes within the 20 second termination grace period.

The provisioner can be upgraded while a store is provisioning: the new pod resumes the row once the old pod's lease (60 seconds) expires, and every phase is idempotent.

## Roll back

```sh
helm rollback urumi <revision> -n platform --wait --timeout 10m   # revision from `helm history`
helm test urumi -n platform
```

What a rollback does not undo: rows written by the newer version stay (the older gateway ignores new tables and columns), deleted data, and any migration that dropped something. The audit log is a table in Postgres and is untouched by a rollback.

Rehearsal (`bash scripts/rollback-rehearsal.sh`, output in `docs/evidence/rollback-rehearsal-2026-10-20.txt`): a gateway image that exits on start is rolled out with `--atomic`; Helm records revision 12 as failed and revision 13 as `Rollback to 11`; a probe hitting `/mcp` once a second during the failed rollout got 150 answers and 0 failures, because the old pods kept serving (`maxUnavailable: 0`); the audit table kept its rows; `helm test` succeeded afterwards.

## Upgrade or roll back one store

Each store is its own release in its own namespace.

```sh
helm upgrade store-alpha deploy/helm/urumi-store -n store-alpha --reuse-values --atomic --wait   # new chart or image values
helm rollback store-alpha <revision> -n store-alpha
```

Use `--reuse-values` so the values the provisioner passed (name, host, storage class) are kept. Do not upgrade a store by hand while its row in the dashboard says `provisioning`.

### WooCommerce or WordPress plugin upgrades

Plugin updates run database migrations that cannot be reversed by `helm rollback`. Before an upgrade:

1. Snapshot both claims (`wordpress` and `mariadb`). On a StorageClass with snapshot support create a `VolumeSnapshot` of each. On `local-path` there are no snapshots; instead run
   `kubectl -n <ns> exec deploy/mariadb -- sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --all-databases' > store.sql`
   and copy `/var/www/html/wp-content` with `kubectl cp`.
2. Upgrade (`wp plugin update woocommerce` through the bootstrap job image, or a new `images.wordpress` tag).
3. If it goes wrong, restore both from the snapshot or the dump. Rolling the chart back alone leaves a database the older plugin may not understand.

`helm uninstall urumi` keeps the PersistentVolumeClaims of the core store and the platform database (`helm.sh/resource-policy: keep`; the MariaDB claim comes from its StatefulSet and is kept by Kubernetes). A store created by the provisioner is the opposite on purpose: deleting it in the dashboard removes its namespace and volumes.

## Rotate secrets

| Secret | How |
| --- | --- |
| Admin password | Dashboard, Account, change password. For a lost password run `kubectl -n platform exec deploy/gateway -c gateway -- bun -e '...'` or delete the user row and let `migrate` re-seed only when the table is empty (documented limitation: there is no email reset). |
| A member's API key | The member or an admin revokes it in the dashboard; a new key is issued. Takes effect on the next request. |
| `SESSION` (cookie signing) | Change it in the env file, `urumi_apply_secrets`, `kubectl -n platform rollout restart deploy/gateway`. Everyone is signed out. |
| `INTERNAL_TOKEN`, `PROVISIONER_TOKEN` | Change in the env file, apply, restart gateway and provisioner together (`kubectl -n platform rollout restart deploy/gateway deploy/provisioner`). |
| `CREDENTIAL` (encrypts upstream credentials) | 1. Put the old value in `CREDENTIAL_PREVIOUS` and a new random value in `CREDENTIAL` in the env file. 2. `urumi_apply_secrets` and restart the gateway: it now decrypts with either key. 3. `kubectl -n platform exec deploy/gateway -c gateway -- bun apps/gateway/src/rekey.ts` re-encrypts every stored credential. 4. Remove `CREDENTIAL_PREVIOUS`, apply, restart. |
| LLM key | Edit `gateway-llm` (`LLM_API_KEY` in the env, rerun `dev-up.sh`, or `kubectl -n platform create secret generic gateway-llm ... --dry-run=client -o yaml | kubectl apply -f -`), then restart the gateway. |
| A store's database password | Do not change `store-db` of a running store; MariaDB initialised with it. Delete and recreate the store. |

## Back up and restore

- **Postgres** (users, keys, servers, audit, stores): `kubectl -n platform exec deploy/postgres -- pg_dump -U urumi urumi > urumi.sql`. Restore into an empty database before starting the gateway (`psql -U urumi urumi < urumi.sql`); migrations then apply nothing.
- **Secrets env file** (`deploy/secrets/generated.env` locally, `/root/urumi-secrets.env` on a VPS): back it up with the dump. A dump without `CREDENTIAL` cannot decrypt stored upstream credentials.
- **Stores**: the namespace labels and the `stores` table are enough to see what existed; content comes from the volume snapshots or dumps above.

## Failure notes

| Symptom | Look at |
| --- | --- |
| A store is `failed` | the reason on the Stores page (Helm message plus the pods that are not Ready); fix, then Retry. `kubectl -n store-<slug> get pods,events` |
| A store is `deleting` for a long time | the reason names what it waits for (namespace terminating, a volume); `kubectl get ns store-<slug> -o yaml` for finalizers |
| Every tool call times out | `kubectl -n platform logs deploy/gateway`; the Servers page shows each upstream's classified reason |
| An alert fires | the annotation names the page to open; the audit row's trace id finds the trace in Grafana (Tempo) |
| Alerts need to notify someone | Prometheus here has no Alertmanager. Add one with a webhook or email receiver, or create Grafana contact points; this needs a destination you own |
