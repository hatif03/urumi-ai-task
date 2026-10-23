# Security test log

Every claim in [threat-model.md](threat-model.md) that can be tried on a running cluster was tried, on 2026-10-20, on the k3d cluster `urumi` (k3s 1.35, kube-router network policy enforcement, ingress-nginx). The commands are scripts in `scripts/`; the raw output is in `docs/evidence/`. A line that says PASS means the script asserted the stated behaviour and observed it; it does not mean the control is perfect.

| Script | What it tries | Output |
| --- | --- | --- |
| `scripts/security-check.ts` (`ISOLATION=1` also creates and deletes two stores) | SSRF refusals through the real API; what the gateway pod can and cannot open; what an unlabelled pod can open; the provisioner service account's permissions by impersonation; container security contexts; probes and limits on every workload; secrets at rest in Postgres and in the source tree; isolation between two stores | [security-check-2026-10-20.txt](evidence/security-check-2026-10-20.txt) |
| `scripts/e2e.ts` | members cannot write; a hidden tool is rejected and audited; a revoked key gets 401; a disabled server vanishes; no credential material in server listings; hosted server hardening | [e2e-2026-10-20.txt](evidence/e2e-2026-10-20.txt) (core, two stores, a hosted server) |
| `scripts/oauth-demo.ts` | PKCE, code replay, refresh reuse, audience, revocation against the real gateway | [oauth-demo-2026-10-20.txt](evidence/oauth-demo-2026-10-20.txt) |
| `scripts/recovery-check.ts` | the provisioner killed during a Helm install and during a delete | [recovery-check-2026-10-20.txt](evidence/recovery-check-2026-10-20.txt) |
| `scripts/tls-rehearsal.sh` | cert-manager issuing the dashboard certificate, Secure cookie, https OAuth identifiers | [tls-rehearsal-2026-10-20.txt](evidence/tls-rehearsal-2026-10-20.txt) |
| `bun test` | SSRF classes, permissions, OAuth rules, key rotation, result cap, sanitising, rate limits, Origin checks | 104 tests, 0 failures |

## What was shown, in the order of the threat model

**SSRF.** An admin adding a server with a metadata address, loopback, the Kubernetes API service name, a private range, an IPv4-mapped IPv6 metadata address, or userinfo gets HTTP 400 and nothing is stored. Independently of the code check, the gateway pod cannot open `169.254.169.254:80` or the Kubernetes API service `10.43.0.1:443` (the NetworkPolicy drops them), while it can open the WooCommerce MCP server and Postgres.

**Default deny.** An unlabelled pod in `platform` cannot reach the WooCommerce MCP server or Postgres, and an unlabelled pod in `store` cannot reach MariaDB. The probe waits six seconds before connecting because a new pod's policy rules are programmed shortly after it starts; the first versions of the probe raced that and passed or failed at random, which is why the log says "BLOCKED" only after the wait.

**Store isolation.** With two provisioned stores, a pod in one store's namespace cannot open the other's MariaDB, WordPress or MCP server, cannot open the core store's MCP server, and cannot even open its own store's MariaDB (only WordPress and the bootstrap job can). The store's own MCP server cannot open its MariaDB either: it speaks REST to WordPress only. Each store namespace has a ResourceQuota, a LimitRange and the managed and Pod Security labels.

**Provisioner privileges.** Impersonating its service account: cannot read Secrets in `kube-system` or list Secrets cluster-wide, cannot create workloads in `kube-system`, cannot delete nodes, cannot patch or relabel a namespace; can create and delete namespaces. A RoleBinding to `urumi-store-admin` in `kube-system` is refused by the `urumi-provisioner-bindings` admission policy, and a binding to `cluster-admin` is refused by RBAC's escalation check.

**Containers.** The platform's own containers run non-root with no privilege escalation and a read-only root filesystem; every long-running container in `platform`, `store` and the store namespaces has a probe and CPU and memory requests with a memory limit; namespaces enforce the baseline Pod Security profile; hosted MCP pods get no service-account token and are non-root and read-only (checked in the hosted end-to-end run).

**Secrets at rest.** API keys are 64 hexadecimal characters of SHA-256 and no row holds a token; passwords are argon2id; an upstream credential is stored as AES-GCM `{iv, tag, ciphertext}` and the plaintext canary never appears in an API response or in Postgres (hosted-server secrets too); `git grep` finds no key-shaped string in `apps`, `deploy` or `scripts`.

**Tokens.** The OAuth run confirms PKCE (a wrong verifier is refused), single-use codes (a replay is refused and revokes what the first use issued), rotating refresh tokens (reuse revokes the whole grant, including the newer token), audience binding (a request for another resource is refused), and revocation.

**Recovery.** The provisioner pod was force-deleted while Helm was installing a store: the replacement pod resumed after the old lease expired and the store completed with exactly one namespace, one release lineage and one set of credentials, registered and Connected. It was force-deleted again during a delete: the delete completed and the namespace, volumes and registration were gone.

**TLS.** With cert-manager and a private CA, certificates were issued for the dashboard and shop hosts; the Ingress served a certificate whose issuer is `urumi-local-ca`; the session cookie carried `Secure`; the OAuth resource identifier was `https://dashboard.local/mcp`. The release was then restored to plain http.

## Found while testing

- The first version of the end-to-end run showed the WooCommerce MCP pods NotReady under load, which looked like an authentication failure to a member; the cause was a probe timeout ([experiment 0003](experiments/0003-probe-timeouts-under-load.md)).
- The rate-limit test showed the in-memory shortcut did not hold the limit ([experiment 0004](experiments/0004-rate-limit-shortcut.md)).
- The end-to-end run left a store stuck in `deleting` (Helm run in a namespace the provisioner had no rights in); fixed and covered by two tests.
- The first browser run crashed the Stores page; the first versions of the network probes raced policy programming.

## Not shown, and why

- **A hostile model** persuaded by a poisoned description. The tests show the permission check does not depend on the model; they do not measure how often a model is persuaded.
- **DNS rebinding against an https upstream.** The code does not pin https connections; the NetworkPolicy is the control and was shown for the metadata and API addresses, not for a live rebinding attack.
- **A real internet-facing VPS.** Rate limiting at the edge, fail2ban, firewall rules and Let's Encrypt were not exercised from here ([vps-deploy.md](vps-deploy.md)).
- **Image vulnerabilities and signatures.** No scanner was run.
- **Sustained load.** One 60-second run at 40 concurrent callers was recorded ([evidence](evidence/loadtest-2026-10-20.txt), [experiment 0006](experiments/0006-gateway-collapse-under-load.md)); there is no soak test, and one laptop node cannot show throughput scaling across replicas.
