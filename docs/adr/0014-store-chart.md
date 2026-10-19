# 0014. One store is one Helm release of `urumi-store`

- Status: accepted
- Date: 2026-10-20
- Outcome: Installed as `store-chartcheck` in a namespace created with the provisioner's labels. The bootstrap Job completed after two restarts while MariaDB started, and mariadb, wordpress and woocommerce-mcp became Available. The storefront answered 200 through ingress-nginx for `chartcheck.shop.localhost` with the title "Chart Check Shop". `list_products` called inside the MCP pod returned "Chart Check Sample Mug" with a `chartcheck.shop.localhost` permalink, which also proves MCP to WordPress to MariaDB works under the policies. The ResourceQuota reported pods 3/10, requests 125m CPU and 368Mi, limits 1400m CPU and 1088Mi, PVCs 2/3, storage 4Gi/6Gi. A throwaway pod in another namespace could not open `wordpress`:80, `mariadb`:3306 or `woocommerce-mcp`:8080 of that store, while the same probe reached kube-dns, so the denial is the policy and not the probe. `helm uninstall` plus deleting the namespace left no PV for the store. The gateway-to-MCP allow was not exercised here because it needs the gateway's egress rule for `store-*` namespaces in the platform chart.

## Context

The multi-store bonus needs many copies of the store, each in its own namespace with its own database, Secrets, volumes, Ingress host, quota, and network isolation. The provisioner (ADR 0015) installs and removes them. The platform chart already contains a single store in the `store` namespace, written as part of one release.

## Options

1. Reuse the platform chart's store templates with a loop over stores.
2. Render manifests in the provisioner and apply them through the Kubernetes API.
3. A separate chart, `deploy/helm/urumi-store`, installed once per store as its own release.

## Decision

Option 3. The chart does not create its Namespace and does not create Secrets. The provisioner creates the namespace (with `urumi.io/managed=true`, `urumi.io/store=<slug>` and Pod Security `baseline`) and the Secrets `store-db`, `store-admin` and `store-wc-api` first, so generated passwords never pass through Helm values and release history. Object names are fixed (`wordpress`, `mariadb`, `woocommerce-mcp`, `store-bootstrap`, PVCs `wordpress` and `mariadb`) because the namespace already separates stores; the MCP URL is therefore `http://woocommerce-mcp.store-<slug>.svc.cluster.local:8080/mcp`.

Differences from the platform chart's store:

- MariaDB is a Deployment with `Recreate` and a PVC instead of a StatefulSet, so every workload has the same shape and the quota can assume one pod of each. All three Deployments use `Recreate`: no surge pod can exceed the quota, and the volumes are ReadWriteOnce.
- One MCP replica.
- `ResourceQuota store-quota` (10 pods, 1 CPU and 1Gi requests, 2 CPU and 2Gi limits, 3 PVCs, 6Gi storage) and `LimitRange store-limits` (default request 50m and 128Mi, default limit 500m and 512Mi) from values. The sum of container limits is 1.8 CPU and 1472Mi (mariadb 400m and 384Mi, wordpress 800m and 512Mi, bootstrap 400m and 384Mi, mcp 200m and 192Mi), which fits while the bootstrap Job still runs. Requests sum to 175m and 496Mi, so three stores fit on a laptop.
- NetworkPolicies are default deny for ingress and egress plus one allow per edge: DNS to kube-system; WordPress from ingress-nginx and from its own MCP pod, to MariaDB only; MariaDB from WordPress and the bootstrap pod only; the bootstrap pod to MariaDB and to TCP 443 outside private ranges; the MCP pod from `app=gateway` in `platform` (and Prometheus on 9090), to WordPress and the OTLP collector only. No rule names another `store-*` namespace.
- The seeded product and the site title carry the store name (`STORE_NAME`), so two stores can be told apart in an answer.
- TLS: when `ingress.tls.enabled` is set the Ingress gets a `tls` block (secret `<slug>-tls` unless named) and, with `ingress.tls.clusterIssuer`, the cert-manager annotation.

Every fix recorded for the first store is carried over: the mu-plugin and the `/wp-json/wc/` HTTPS flag for consumer-key auth, `WP_HOME` from `store.url`, the root bootstrap Job that chowns `wp-content` to uid 33, the startup probe for first boot, and the non-root, read-only, no-capability security context for the Bun image.

## Why

A chart is the reviewed definition of "a store". `helm upgrade --install` is the retry mechanism and `helm uninstall` is the teardown, so the provisioner holds no template logic. Keeping the platform chart's store untouched leaves the working core alone. The cost is that the two sets of store templates can drift; folding the platform's own store into this chart is the follow-up once the provisioner has run in production.

## Consequences

- Unlike the platform chart's `store` namespace, a store namespace has no PodDisruption or HPA: one replica per workload is the unit.
- The platform chart lets the gateway reach `store-*` namespaces (egress rule on the `urumi.io/managed` label) and lets Prometheus scrape them; the end-to-end run proved the gateway-to-MCP path through both policies.
- The bootstrap Job pod counts against the quota. Its retries (backoff limit 6) create new pods sequentially, never concurrently.
- Plugin download needs TCP 443 to the internet; a cluster without egress cannot bootstrap a store.
