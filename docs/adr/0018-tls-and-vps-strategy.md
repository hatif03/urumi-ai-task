# 0018. TLS and the VPS: cert-manager behind the same chart, differences only in values

- Status: accepted
- Date: 2026-10-20
- Outcome: `helm template -f values-prod.yaml` renders TLS blocks and the cert-manager annotation on the dashboard and shop Ingresses and a Let's Encrypt `ClusterIssuer`. The same chart renders a self-signed `ClusterIssuer` for a rehearsal on k3d. A real run was done on 2026-10-26 on AWS EC2 with k3s and Let's Encrypt certificates for `sslip.io` names; the full end-to-end suite passed (65 of 65, [evidence](../evidence/e2e-vps-aws-2026-10-26.txt)). The real run found that the default-deny NetworkPolicies blocked cert-manager's HTTP-01 solver pod, so both charts now carry `allow-acme-http01-solver`; see `docs/vps-deploy.md` and `docs/log.md`.

## Context

The brief requires the same Helm chart on a production-like VPS with configuration changes only, and lists TLS with cert-manager as optional. Stores are created at runtime, each with its own host, so TLS has to work for hosts that did not exist when the chart was installed.

## Options

1. Terminate TLS outside the cluster (a cloud load balancer or Cloudflare).
2. cert-manager with HTTP-01 per host, annotations on each Ingress.
3. cert-manager with a wildcard certificate via DNS-01.

## Decision

Option 2, with option 3 documented. `ingress.tls.enabled` adds a `tls:` block to the dashboard and shop Ingresses and, when `ingress.tls.clusterIssuer` is set, the `cert-manager.io/cluster-issuer` annotation. The same two values flow into every store release through the provisioner (`STORE_VALUES`), so each new store's Ingress asks for its own certificate. `certManager.enabled` creates the `ClusterIssuer`: ACME HTTP-01 through `ingress-nginx` by default, or a private CA when `certManager.selfSigned` is true. `COOKIE_SECURE`, the OAuth issuer and the store URLs follow `https` automatically (`publicBaseUrl`, `provisioner.storesScheme`). cert-manager itself is installed separately, once per cluster.

## Why

HTTP-01 needs no DNS provider credentials, which suits a single VPS; it needs the ingress controller reachable on port 80 and one A record per host. Per-host certificates avoid a wildcard private key in the cluster. The values that differ between local and production are the same ones the brief names: hosts, ingress/TLS, storage class and size, image repositories, replicas and secrets.

## Consequences

- Stores need DNS: a wildcard A record `*.stores.example.com` pointing at the VPS, then one HTTP-01 certificate per store, subject to Let's Encrypt rate limits (50 certificates per registered domain per week). A wildcard certificate by DNS-01 is the fix for large store counts and is a values-only change plus a solver credential.
- The self-signed rehearsal proves the wiring, not browser trust.
- Secrets are created on the node by `scripts/vps-bootstrap.sh`; they are never in values files.
