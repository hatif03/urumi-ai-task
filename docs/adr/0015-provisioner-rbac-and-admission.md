# 0015. Provisioner RBAC: per-namespace grants, bind-limited, with an admission policy

- Status: accepted
- Date: 2026-10-20
- Outcome: the chart renders both ClusterRoles, the ClusterRoleBinding, the static `mcp-hosted` RoleBinding, the `ValidatingAdmissionPolicy` and its binding (`helm template`, server dry-run). The on-cluster checks (what the provisioner can and cannot do with its token) are in `docs/security-test-log.md`.

## Context

The provisioner creates and deletes namespaces and installs charts that contain Secrets, PVCs, NetworkPolicies and Deployments. The brief asks for least-privilege RBAC for any component that talks to the Kubernetes API. The obvious grants are too broad: `cluster-admin`, or cluster-wide `secrets` and `deployments` rights, would let a bug or a stolen token read every Secret in the cluster.

## Options

1. `cluster-admin`.
2. A ClusterRole with everything the Helm chart needs, bound cluster-wide.
3. A narrow ClusterRole that can create namespaces and RoleBindings; the namespaced permissions arrive through a RoleBinding the provisioner creates inside each new namespace; an admission policy limits where it may create that RoleBinding.

## Decision

Option 3.
- `urumi-provisioner` (ClusterRoleBinding): `get/create/delete` namespaces, `get/list` PersistentVolumes (to confirm volumes are gone), `create` RoleBindings, and `bind` on exactly the ClusterRole `urumi-store-admin` (`resourceNames`).
- `urumi-store-admin` (ClusterRole used only through RoleBindings): the namespaced kinds a store or hosted chart uses, nothing else. It is granted inside `store-<slug>` by a RoleBinding the provisioner creates right after the namespace, and inside `mcp-hosted` by a static RoleBinding in the chart.
- `ValidatingAdmissionPolicy urumi-provisioner-bindings`: a RoleBinding created by `system:serviceaccount:platform:provisioner` is denied unless the namespace has `urumi.io/managed=true`, the role is `urumi-store-admin`, and the only subject is the provisioner itself.

## Why

`create rolebindings` plus `bind` on one role is the narrowest way to hand out a namespaced role without holding it everywhere; without the `bind` verb the API server would require the provisioner to already hold every permission in the role. That combination alone would still let it bind the role into `kube-system`, because `create rolebindings` is cluster-wide. The admission policy closes that: the provisioner cannot patch or label an existing namespace, so it cannot make `kube-system` look managed. A namespace it creates with the label is the only place the binding is accepted.

## Consequences

- The provisioner can still create any namespace name and delete any namespace it can `get` (RBAC cannot restrict `delete namespaces` by label). The code deletes only namespaces whose `urumi.io/store` label matches the row, and never adopts an unlabelled one; a bug there is the residual risk. The threat model lists it.
- The policy needs Kubernetes 1.30 or newer (it is stable there). k3s 1.35 on the test cluster is fine.
- Helm release state lives in Secrets inside each store namespace, so the namespaced `secrets` verbs are required.
