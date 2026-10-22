# 0005. One Helm chart, k3d locally, k3s on a VPS

- Status: accepted
- Date: 2026-10-14
- Outcome: `helm upgrade --install urumi` with `values-local.yaml` is release revision 5 on k3d. `helm template` of `values-prod.yaml` renders `shop.example.com`, `dashboard.example.com`, `ghcr.io/example/*`, and `maxReplicas: 4`. That file was not installed onto a second cluster.

## Context

The assignment requires Helm (not Kustomize), a local cluster, and the same charts on a production-like VPS. Local and production may differ only by values. The storefront and the dashboard need stable hostnames. Secrets must not be committed.

## Options

1. kind locally, k3s on the VPS, Traefik as shipped by k3s.
2. k3d locally, k3s on the VPS, Traefik disabled on both, ingress-nginx on both.
3. Separate charts per environment.

## Decision

Option 2. One chart at `deploy/helm/urumi`. `values-local.yaml` and `values-prod.yaml` carry hosts, image repositories, pull policy, disk size, resource sizes, replica counts, and secret names.

- Namespaces `store` and `platform`.
- Local hostnames `shop.local` and `dashboard.local` via the hosts file and k3d's published port 80. Production uses real DNS. TLS stays off until cert-manager is attempted.
- The chart references Secrets; it does not template passwords. A local script generates them into `deploy/secrets/`, which is gitignored.
- Default-deny NetworkPolicy, then explicit allows. Probes, requests, and limits on every workload.

## Why

k3d and k3s both provide the `local-path` StorageClass. kind does not, so a kind cluster needs an extra provisioner before any volume binds. Using ingress-nginx in both places keeps `ingressClassName` identical. Hosts-file names work when the laptop is offline; public wildcard DNS such as `sslip.io` does not.

## Consequences

- k3d and k3s Traefik must be disabled or it will occupy port 80.
- Anything that cannot be expressed as a value is a chart bug, not a production-only template.
- Observability components (ADR 0007) are templates in this same chart, so a local install and a VPS install both scrape metrics.

## Update 2026-10-20

`ingress.tls` now takes effect: the dashboard and shop Ingresses get `tls:` blocks and the cert-manager annotation, `certManager.enabled` creates the issuer, and the same values flow into every store ([ADR 0018](0018-tls-and-vps-strategy.md)). `scripts/vps-bootstrap.sh` and `docs/vps-deploy.md` list every value that differs.
