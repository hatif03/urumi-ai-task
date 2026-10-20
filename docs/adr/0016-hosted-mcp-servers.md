# 0016. Hosted MCP servers: an image, a quota, a policy, and a registration

- Status: accepted
- Date: 2026-10-20
- Outcome: `provisioner.test.ts` covers image validation, input validation, secrets never reaching Postgres, deploy then register, and delete removing the release, the Secret and the registration. `helm lint` and `helm template` pass for `urumi-hosted-mcp`. The cluster run is recorded in `docs/log.md`.

## Context

The brief's stand-out asks that an admin can add a server by container image: the platform deploys it with its own Secret, limits and NetworkPolicy, and removes it cleanly. An admin-supplied image is arbitrary code; it must not be able to reach the database, the Kubernetes API, other namespaces or the internet.

## Options

1. Run the image in the `platform` namespace next to the gateway.
2. One shared namespace `mcp-hosted` with its own quota, default-deny policy and Pod Security `restricted` enforcement, one Helm release per server.
3. A namespace per hosted server.

## Decision

Option 2, driven by the provisioner (ADR 0013). `deploy/helm/urumi-hosted-mcp` creates a Deployment (no service-account token, no service links, non-root uid 1000, read-only root filesystem, all capabilities dropped, seccomp `RuntimeDefault`, a writable `/tmp` emptyDir with a size limit), a Service and a NetworkPolicy that admits only the gateway and allows egress only to DNS. Admission to the API is validated before any state is written:
- image: explicit tag or digest, `latest` refused, must start with an operator-configured registry prefix (`provisioner.hostedRegistries`);
- size: `small`, `medium` or `large`, mapped to fixed requests and limits;
- environment variables: valid names, reserved names (`PATH`, `LD_*`, `NODE_OPTIONS`, `*_PROXY`, `PORT`, `OTEL_*`) refused, at most 20.
Secret variables go straight into a Kubernetes Secret (`hosted-<slug>-env`, referenced with `envFrom`) and never into Postgres or the Helm values; Postgres keeps their names only. The gateway registers `http://mcp-<slug>.mcp-hosted.svc.cluster.local:<port>/mcp` with managed-by `hosted`, which makes it read-only in the server list.

## Why

A shared namespace with a namespace-level quota and one policy per server is simpler to reason about than a namespace per server and still isolates by default: default-deny at the namespace plus an allow only from the gateway. Pod Security `restricted` makes the cluster refuse a spec that is not hardened even if the chart is later edited. Not mounting the service-account token removes the Kubernetes API from the image's reach even if the egress policy were wrong.

## Consequences

- Egress is denied entirely. A hosted server that must call an external API cannot, until an operator adds a specific egress rule; that is deliberate and listed as a limitation.
- The image runs as uid 1000 whatever it was built for; an image that needs root will not start.
- Registry prefix matching is on the string the admin types, so `ghcr.io/example/` also matches `ghcr.io/example/anything`. It is an allowlist of namespaces on a registry, not a signature check; image scanning and signature verification are out of scope.
