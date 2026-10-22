# 0004. WooCommerce on official images, reached over REST

- Status: accepted
- Date: 2026-10-14
- Outcome: k3d cluster `urumi` is running MariaDB 11.4, `wordpress:7.1.3-apache`, and WooCommerce 11.2.1. Order 11 (processing, cash on delivery, total 12.00) was still there after the WordPress pod was deleted. The WooCommerce MCP Service has no Ingress. A pod without `app=gateway` could not reach it; the gateway pod got HTTP 200. WooCommerce 11 performs consumer-key basic auth only when `is_ssl()` is true, so the chart marks `/wp-json/wc/` as HTTPS and a mu-plugin clears that flag after authentication when `WP_HOME` is `http://`. Product permalinks stay `http://shop.local/...`. The CLI image's www-data is uid 82 and the Apache image's is uid 33, so the bootstrap Job runs as root and chowns `wp-content` back to 33.

## Context

The store is WordPress plus WooCommerce plus a database, with persistent disk, probes, and a checkout that works with cash on delivery. The WooCommerce MCP server is ours. It must not be reachable from outside the cluster. We have to document how it talks to the store.

## Options

1. Bitnami's WordPress Helm chart and images.
2. Official `wordpress` (Apache) and official `mariadb`, our own templates, an idempotent WP-CLI bootstrap Job.
3. The MCP server calls WooCommerce over `wc/v3` with HTTP Basic auth, or it shells into the WordPress pod with WP-CLI.

## Decision

Option 2 for the store. Option "REST" for the MCP server.

- MariaDB 11.4 as a one-replica StatefulSet. WordPress as a one-replica Deployment. Both have persistent volumes. The StorageClass is `local-path` locally and on k3s unless production values say otherwise.
- The bootstrap Job installs core, WooCommerce, pretty permalinks, guest checkout, and cash on delivery, and inserts the REST key from a pre-created Secret. It is safe to rerun.
- The MCP server holds the consumer key and calls `GET/POST /wp-json/wc/v3/products` and `GET/PUT /wp-json/wc/v3/orders`. Prices are strings. Created products are `publish` with catalog visibility `visible`.
- NetworkPolicy: only the gateway may reach the MCP server. The MCP server may reach WordPress on port 80 and DNS. It may not reach MariaDB.

## Why

Bitnami moved its public image catalog to a legacy registry and a paid secure-image program in 2025, so a chart pinned to `docker.io/bitnami/wordpress` is a demo risk. The official images are the Kubernetes tutorial path. REST is the integration WooCommerce documents; WP-CLI inside the WordPress pod would widen RBAC and tie every tool call to exec. One replica is the constraint of a ReadWriteOnce volume and a single WordPress writer.

## Consequences

- The official WordPress and MariaDB images start as root to fix volume ownership. Our own images run as uid 1000. The threat model records that exception.
- The first boot of WordPress is slow. A startup probe covers it so liveness does not kill the copy onto the volume.
- Recent WooCommerce builds can hide the storefront behind a coming-soon flag. The Job turns that off. Confirming that on the chosen plugin version is an experiment once the image tag is pinned.

## Update 2026-10-20

The store template set was copied into `deploy/helm/urumi-store` for per-store installs ([ADR 0014](0014-store-chart.md)); the core store in `store` is unchanged. Readiness of the WooCommerce MCP server now comes from a background check and the probes have explicit timeouts ([experiment 0003](../experiments/0003-probe-timeouts-under-load.md)).
