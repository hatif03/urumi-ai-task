# Study resources: MCP Gateway on Kubernetes (interview prep)

All URLs below were seen in search results or fetched during research (2026-10-20). YouTube channel names come from YouTube's oEmbed data. I did not watch the videos, so titles and channels are verified but quality is not. Marker legend: **[CORE]** read or watch first, **[SKIP IF SHORT]** lower value.

## Read this first: the MCP spec has moved

- Search results and the fetched spec show a **2026-07-28** MCP revision. Its Streamable HTTP transport removes protocol-level sessions and the GET stream. Every request is a self-contained POST, and `Mcp-Method` and `Mcp-Name` headers are mandatory. I saw this on the official spec page and on secondary sources (InfoQ, a community blog). Confirm details on the official page before you quote them.
- The 2025-03-26 revision still describes optional `Mcp-Session-Id` sessions.
- This helps your "stateless JSON responses" design. You can say it matches where the spec went, and that a stateless gateway scales horizontally without sticky routing.
- **Dynamic Client Registration (RFC 7591) is now marked deprecated** in the 2026-07-28 authorization spec. It is kept for backward compatibility. The spec prefers OAuth Client ID Metadata Documents, then pre-registration, then DCR. I fetched this page and confirmed it. Be ready to explain why DCR is in your plan and what you would swap in.
- The fetched spec also confirms these items for your planned OAuth work:
  - MCP servers MUST implement RFC 9728.
  - Clients MUST send the RFC 8707 `resource` parameter in both the authorization and token requests.
  - Servers MUST validate that a token's audience is themselves.
  - Servers MUST NOT accept or pass through other tokens.

## Suggested study order (7 days)

| Day | Focus | Topics (section numbers below) |
|---|---|---|
| 1 | MCP core: protocol, transport, stateless vs sessions, gateway pattern | 1, 2, 5 |
| 2 | MCP auth and MCP security. Walk through the 401, PRM, AS metadata, PKCE, `resource`, audience check flow out loud. | 3, 4 |
| 3 | Kubernetes core and Helm. Be able to explain every object in your chart and why. | 6, 7 |
| 4 | Cluster edge and Kubernetes security: k3d, k3s, ingress, TLS, NetworkPolicy, RBAC, PSS | 8, 9 |
| 5 | Multi-tenancy, reconcile loops, SSRF and DNS rebinding | 10, 11 |
| 6 | Crypto and rate limiting, observability, WooCommerce, AI SDK, Bun and Hono | 16, 17, 15, 12, 13, 14 |
| 7 | Mock interview. Redraw `docs/system-design.md` from memory and defend each trade-off. Skim every "Interview Q" line below. | all |

If you only have two days, do topics 1-5 and 9-11 and skip every **[SKIP IF SHORT]** item.

---

## 1) MCP fundamentals (architecture, tools/resources/prompts, JSON-RPC)

- **MCP Specification: Architecture** (spec) **[CORE]**
  https://modelcontextprotocol.io/specification/latest/architecture
  Defines the host / client / server model and the isolation goals (servers must not see the whole conversation or each other). *Interview Q:* "Where does your gateway sit in the MCP architecture, and is it a client, a server, or both?"
- **Understanding MCP servers** (docs) **[CORE]**
  https://modelcontextprotocol.io/docs/2026-07-28/learn/server-concepts
  Explains tools (model-controlled), resources (application-controlled) and prompts (user-controlled). *Interview Q:* "Why did your WooCommerce server expose tools rather than resources?"
- **Architecture overview (2026-07-28)** (docs)
  https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture
  Splits MCP into a JSON-RPC data layer and a transport layer, and notes sampling is deprecated in this revision. *Interview Q:* "Walk through `tools/list` and `tools/call` on the wire."
- **Model Context Protocol (MCP) Explained in 20 Minutes**, channel Shaw Talebi (video)
  https://www.youtube.com/watch?v=N3vHJcHBS-w
  A quick conceptual refresher to loosen up before the spec. *Interview Q:* "Explain MCP to a non-expert in 60 seconds."
- **Model Context Protocol: A Deep Dive into the future of AI systems**, channel Gaurav Sen (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=uBL0siiliGo
  A system-design-style walkthrough, useful for how you narrate the architecture. The search snippet showed only a title and a comment, so treat it as optional.
- **MCP Architecture | Model Context Protocol Architecture | CampusX**, channel CampusX (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=nQa31xdXbGk
  First-principles architecture explainer, a second angle if the spec pages feel dense.

## 2) MCP Streamable HTTP transport, sessions vs stateless

- **Transports (2026-07-28)** (spec) **[CORE]**
  https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
  The latest transport spec: a single POST endpoint, no protocol sessions, mandatory `Mcp-Method` / `Mcp-Name` headers, and Origin validation against DNS rebinding. *Interview Q:* "Why is your MCP server stateless, and what do you lose by that?"
- **Streamable HTTP (draft)** (spec)
  https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http
  The draft transport page, for comparing against the dated revision. *Interview Q:* "How would a server push a notification to a client without sessions?"
- **Transports (2025-03-26)** (spec) **[CORE]**
  https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
  The session-based version: optional `Mcp-Session-Id`, JSON or SSE responses, and the fallback to legacy HTTP+SSE. Read it so you can contrast stateful and stateless. *Interview Q:* "What breaks in a multi-replica deployment if the server keeps sessions in memory?"
- **Exploring the Future of MCP Transports / transport roadmap** (blog)
  https://blog.modelcontextprotocol.io/posts/2025-12-19-mcp-transport-future/
  Official rationale for moving toward stateless transports and standardizing what "stateless" means across SDKs. *Interview Q:* "Why is sticky routing a scaling problem?"
- **The 2026-07-28 Specification** (blog)
  https://blog.modelcontextprotocol.io/posts/2026-07-28/
  Release notes for the revision that dropped sessions. Skim it for the changelog.
- **Stateless mode (C# SDK concepts)** (docs) **[SKIP IF SHORT]**
  https://csharp.sdk.modelcontextprotocol.io/concepts/stateless/stateless.html
  A clear statement of when sessions are needed (server-to-client requests, unsolicited notifications, per-client state) and when stateless is enough. Language differs from yours, but the reasoning carries over.
- **Model Context Protocol - Stateless MCP Servers with Streamable HTTP - Why this is BIG!**, channel Coding Crash Courses (video)
  https://www.youtube.com/watch?v=PYMEspZPcmc
  Directly on stateless Streamable HTTP servers. It predates the 2026 revision, so check it against the newer spec.
- **What Actually Changed in MCP's Transport Layer - Animesh Pathak, Harness Inc**, channel Agentic AI Foundation (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=hOmhM0oZPa8
  A talk on the SSE to Streamable HTTP shift, which gives the history behind your design choice.

## 3) MCP authorization: OAuth 2.1, PKCE, RFC 9728, RFC 8707, DCR

- **MCP Authorization (2026-07-28)** (spec) **[CORE]**
  https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
  I fetched this page. It has the full flow diagram, the 401 with `WWW-Authenticate: resource_metadata=...`, scope step-up, audience validation and the "no token passthrough" rule. *Interview Q:* "Draw the whole flow from the first unauthenticated request to a valid tool call."
- **RFC 9728: OAuth 2.0 Protected Resource Metadata** (spec) **[CORE]**
  https://www.rfc-editor.org/rfc/rfc9728.html
  Defines `/.well-known/oauth-protected-resource` and the `resource_metadata` challenge parameter. *Interview Q:* "How does a client discover which authorization server to use?"
- **RFC 8707: Resource Indicators for OAuth 2.0** (spec) **[CORE]**
  https://www.rfc-editor.org/rfc/rfc8707.html
  The `resource` parameter and audience-restricted tokens. *Interview Q:* "What stops a token for server A being replayed at server B?"
- **RFC 7636: PKCE** (spec)
  https://www.rfc-editor.org/rfc/rfc7636.txt
  `code_verifier` and `code_challenge` (S256) against authorization-code interception. *Interview Q:* "Why do public clients need PKCE?"
- **RFC 7591: OAuth 2.0 Dynamic Client Registration** (spec) **[SKIP IF SHORT]**
  https://datatracker.ietf.org/doc/html/rfc7591
  Read it for the registration endpoint and metadata, but note MCP now deprecates it in favor of Client ID Metadata Documents. *Interview Q:* "Why is DCR a security headache for an open registration endpoint?"
- **MCP Gets OAuth: Understanding the New Authorization Specification**, channel Microsoft Developer (video) **[CORE]**
  https://www.youtube.com/watch?v=EXxIeOfJsqA
  Explains the move to OAuth 2.1 conventions. It covers an older revision, so use it for intuition and the spec for details.
- **Tutorial: Auth for Remote MCP Servers (Step by Step) | OAuth 2.1 with ScaleKit**, channel Alejandro AO (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=gl6U8s3zStI
  Hands-on implementation of a protected remote MCP server, which is useful when you build the planned auth.
- **#PKCE explained - Proof Key for Code Exchange for #OAuth2 Authz Code Grant | Niko Köbler (@dasniko)**, channel Niko Köbler - Expert for Keycloak IAM & SSO (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=nzayiUAXMqc
  A short PKCE explainer if the RFC is hard going.
- **OAuth changes, MCP Authorization, & PKCE Downgrades (Ep. 169)**, channel Critical Thinking - Bug Bounty Podcast (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=mo9LoNHmDhI
  An attacker's view of OAuth 2.1 and MCP auth, which helps you answer "what could go wrong".

## 4) MCP security: tool poisoning, prompt injection, confused deputy, token passthrough

- **MCP Security Best Practices** (spec) **[CORE]**
  https://modelcontextprotocol.io/specification/latest/basic/security_best_practices
  Covers the confused deputy problem (per-client consent for proxy servers), token passthrough (forbidden) and session hijacking. *Interview Q:* "Your gateway holds upstream credentials. How do you avoid being a confused deputy or passing tokens through?"
- **MCP Security Notification: Tool Poisoning Attacks** (blog, Invariant Labs) **[CORE]**
  https://invariantlabs.ai/blog/mcp-security-notification
  The original tool-poisoning disclosure: hidden instructions in tool descriptions that the model reads and the user doesn't see. Search results showed this page's title and summary, not the full text. *Interview Q:* "Your gateway aggregates tools from many servers. How do you stop a poisoned description reaching the model?"
- **Model Context Protocol has prompt injection security problems** (blog, Simon Willison)
  https://simonw.substack.com/p/model-context-protocol-has-prompt?r=18hsl
  Frames tool poisoning as indirect prompt injection and explains why it is hard to fully fix. *Interview Q:* "Is prompt injection solvable at the gateway layer?"
- **Trust Issues: How MCP Servers Hijack Your AI Agent and How to Stop Them**, channel SANS Cyber Defense (video) **[CORE]**
  https://www.youtube.com/watch?v=_kOc7MOpONc
  A practitioner-level talk on server-side hijack techniques and mitigations.
- **MCP Security is Still Broken**, channel Prompt Engineering (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=86e49wcXst4
  A broad survey of MCP vulnerabilities, useful for building a threat list.
- **The Lethal Trifecta: Prompt Injection & MCP Tool Poisoning**, channel AI WITH Rithesh (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=ydDj35hIX2g
  Ties the "lethal trifecta" idea (private data, untrusted content, external communication) to MCP. I did not find Simon Willison's original trifecta post in the results, so search for it by name.

## 5) MCP gateways/aggregators and handling many tools (tool search)

- **Kuadrant/mcp-gateway** (repo) **[CORE]**
  https://github.com/Kuadrant/mcp-gateway
  An Envoy-based gateway with a broker that aggregates tools, a router, and a Kubernetes controller that discovers servers through Gateway API routes and CRDs. *Interview Q:* "How does your gateway differ from Kuadrant's, and why is yours a plain Hono service?"
- **Red Hat Connectivity Link: MCP gateway** (docs)
  https://docs.redhat.com/en/documentation/red_hat_connectivity_link/1.3/html-single/mcp_gateway/
  Productized docs for the Kuadrant design (Technology Preview). It explains the broker and the aggregated tool list. *Interview Q:* "How do you resolve tool-name collisions across upstreams?" (Compare your `{slug}__{tool}` prefix.)
- **Envoy AI Gateway: MCP Gateway** (docs)
  https://aigateway.envoyproxy.io/docs/capabilities/mcp/
  Another aggregator that also prefixes tool names by server (for example `github__list_issues`). Good evidence that your naming scheme is an accepted pattern.
- **microsoft/mcp-gateway** (repo)
  https://github.com/microsoft/mcp-gateway
  A Kubernetes reverse proxy with a control plane (adapter and tool lifecycle) and a data plane that routes requests to server instances. It maps onto your "hosted MCP servers by container image" idea. *Interview Q:* "How would you add hosted servers, and how would routing and lifecycle work?"
- **MCP Server Portals (Cloudflare changelog, 2025-08-26)** (changelog/docs)
  https://developers.cloudflare.com/changelog/post/2025-08-26-mcp-server-portals/
  Several MCP servers behind one endpoint, with per-portal tool allowlists. Shows the same "per-tenant tool permissions" idea as your RBAC plan.
- **Docker MCP Gateway: Open Source, Secure Infrastructure for Agentic AI** (blog)
  https://www.docker.com/blog/docker-mcp-gateway-secure-infrastructure-for-agentic-ai/
  Each server runs in its own container behind a proxy. It is the closest comparison to hosting MCP servers by image.
- **Advanced tool use** (blog, Anthropic Engineering) **[CORE]**
  https://anthropic.com/engineering/advanced-tool-use
  The Tool Search Tool, `defer_loading`, and why loading every schema up front wastes context. *Interview Q:* "What happens when the catalog has 500 tools, and how does tool search fix it?"
- **MCP tool design: Practical approaches and tradeoffs** (blog, AWS)
  https://aws.amazon.com/blogs/machine-learning/mcp-tool-design-practical-approaches-and-tradeoffs/
  Tool-design trade-offs, including how tool count hurts selection. Use it for the "how many tools is too many" discussion.
- **The MCP gateway: Paving a safe road for enterprise AI adoption - Preetam Dedu | PlatformCon 2026**, channel Platform Engineering (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=Xi8flFxn3qg
  A conference talk on why enterprises put a gateway in front of MCP.
- **Lasso's Open Source Security Gateway for MCP**, channel Lasso Security (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=G8qNEOXqfX0
  A vendor demo of a security-focused gateway (the search result called it open source). Skim it for scanning and guardrail ideas.

Coverage note: the Kuadrant search returned no video. I found no good YouTube explainer for Kuadrant, Microsoft or Cloudflare. The repo READMEs and docs above are the best material.

## 6) Kubernetes core (Pods, Deployments, StatefulSets, Services, Ingress, PV/PVC/StorageClass, probes, requests/limits, HPA, PDB)

- **Kubernetes Tutorial for Beginners [FULL COURSE in 4 Hours]**, channel TechWorld with Nana (video) **[CORE]**
  https://www.youtube.com/watch?v=X48VuDVv0do
  The most complete beginner course on the object list above, including Services and Ingress. The search snippet put it at about six years old, so the concepts hold but check tool versions. *Interview Q:* "Why is MariaDB a StatefulSet and WordPress a Deployment?"
- **Kubernetes Full Course for Beginners (3 Hours) | Pods to Ingress with Hands-On Demos**, channel Pravanjan Rath (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=uqAZKGeIJ4A
  A newer course covering Pods through Ingress. Pick this or the Nana course, not both.
- **StatefulSets** (docs) **[CORE]**
  https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/
  `volumeClaimTemplates`, stable identity, and the PVC retention policy. *Interview Q:* "What happens to the database's data when you `helm uninstall`?"
- **Persistent Volumes** (docs)
  https://kubernetes.io/docs/concepts/storage/persistent-volumes/
  PV, PVC and the binding lifecycle. *Interview Q:* "What do k3d and k3s give you for storage by default?"
- **Storage Classes** (docs)
  https://kubernetes.io/docs/concepts/storage/storage-classes/
  Provisioner, reclaim policy and `WaitForFirstConsumer`.
- **Service** (docs) and **Ingress** (docs)
  https://kubernetes.io/docs/concepts/services-networking/service/
  https://kubernetes.io/docs/concepts/services-networking/ingress/
  Service types (ClusterIP, NodePort, LoadBalancer) and Ingress routing. The Ingress page says Gateway is now recommended and Ingress is frozen, so be ready to answer "why Ingress and not Gateway API?"
- **Liveness, Readiness, and Startup Probes** (docs) **[CORE]**
  https://kubernetes.io/docs/concepts/workloads/pods/probes/
  What each probe does and the startup-probe ordering. This matters for WordPress, which starts slowly. *Interview Q:* "Which probe do you use on WordPress and why?"
- **Resource Management for Pods and Containers** (docs) **[CORE]**
  https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/
  Requests drive scheduling and limits are enforced by the kubelet. The QoS classes (Guaranteed, Burstable, BestEffort) are on the related QoS page. *Interview Q:* "What does a CPU limit do to a PHP pod versus a memory limit?"
- **Horizontal Pod Autoscaling** (docs)
  https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/
  The scaling formula and its dependence on requests. *Interview Q:* "Why does HPA on CPU need resource requests set?"
- **Disruptions** (docs, covers PodDisruptionBudgets)
  https://kubernetes.io/docs/concepts/workloads/pods/disruptions/
  Voluntary versus involuntary disruptions, and a PDB with `minAvailable`. *Interview Q:* "What would a PDB of 100% do to a node drain?"

## 7) Helm (charts, values, templates, hooks, upgrade/rollback, helm test)

- **Chart Hooks** (docs) **[CORE]**
  https://helm.sh/docs/topics/charts_hooks/
  Lifecycle hooks (pre/post install, upgrade, rollback, test) with weights and delete policies. *Interview Q:* "How do you run WordPress install and WooCommerce setup exactly once, idempotently?"
- **Chart Tests** (docs) **[CORE]**
  https://helm.sh/docs/topics/chart_tests/
  How `helm test` works and the `helm.sh/hook: test` annotation. *Interview Q:* "How do you prove a store deploy is healthy beyond pods being Ready?"
- **helm rollback** (docs)
  https://helm.sh/docs/helm/helm_rollback/
  The rollback semantics, including that revision 0 or omitted means the previous release. *Interview Q:* "What does rollback do to PVC data and to hook-created resources?"
- **Debugging Templates** (docs)
  https://helm.sh/docs/chart_template_guide/debugging/
  `helm lint`, `helm template --debug` and `helm install --dry-run --debug`. *Interview Q:* "How do you catch template bugs before they reach a cluster?"
- **Helm Templates and Values: Make Re-usable Helm Charts**, channel mkdev (video) **[CORE]**
  https://www.youtube.com/watch?v=BGM3X59biFI
  Making a chart configurable with templates and values, which fits your "one chart for local and VPS" design.
- **How to Upgrade And Roll-Back Using Helm Charts | Helm Commands | Install, Upgrade and Roll-Back**, channel DevOps Pro Junction (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=PM2Ze_85bzQ
  Covers install, upgrade and rollback commands.

Coverage note: the video search returned no hooks-specific video, so rely on the docs for hooks.

## 8) k3d / k3s / ingress-nginx / cert-manager / local domains

- **Exposing Services (k3d)** (docs) **[CORE]**
  https://k3d.io/v5.3.0/usage/exposing_services/
  The `-p "8081:80@loadbalancer"` port mapping and the Ingress route versus NodePort. This is a v5.3.0 page, so check current flags. *Interview Q:* "How does a request on your laptop reach a pod in k3d?"
- **Managing Packaged Components (k3s)** (docs)
  https://docs.k3s.io/installation/packaged-components
  How to disable the bundled Traefik (`--disable=traefik`) so ingress-nginx is the only controller. *Interview Q:* "Why replace Traefik with ingress-nginx on k3s?"
- **Quick-Start Guide (k3s)** (docs)
  https://docs.k3s.io/quick-start
  The install script and kubeconfig location, for your VPS story.
- **Securing NGINX-ingress (cert-manager tutorial)** (docs) **[CORE]**
  https://cert-manager.io/docs/tutorials/acme/nginx-ingress/
  A ClusterIssuer and an annotated Ingress for Let's Encrypt. *Interview Q:* "Walk through how a TLS certificate gets issued for a new store hostname."
- **HTTP01 (cert-manager)** (docs)
  https://cert-manager.io/docs/configuration/acme/http01/
  `ingressClassName` and per-Ingress override annotations, and HTTP-01 limits (no wildcards, needs port 80 reachable). *Interview Q:* "Why can't you get a wildcard cert with HTTP-01?"
- **Wildcard DNS (Epinio docs)** (docs)
  https://docs.epinio.io/how-to/operator/dns/wildcard-dns
  Explains nip.io and sslip.io wildcard DNS and its failure modes (routers filtering private-IP answers). *Interview Q:* "How do you give each store a hostname locally without editing `/etc/hosts`?"
- **K3D: quickly spin a k3s kubernetes cluster, start an nginx and expose via Ingress**, channel Benjamin Henrion (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=DB-vOuHZOhM
  A short k3d plus Ingress demo. It is older, so check the commands.
- **K3S + Nginx + Cert-Manager + LetsEncrypt | HTTPS for your Kubernetes (K8s) Cluster | Tutorial**, channel CloudVersity (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=deLW2h1RGz0
  The VPS story end to end: k3s, ingress-nginx, cert-manager, Let's Encrypt.
- **Securing Kubernetes Ingress With Let's Encrypt**, channel DigitalOcean (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=MpovOI5eK58
  The same stack on a production-style cluster.

Coverage note: I found no official ingress-nginx page in the searches, so read its repo docs yourself. Also check its current maintenance status before you defend choosing it.

## 9) Kubernetes security: NetworkPolicy, RBAC, ServiceAccounts, PSS, ValidatingAdmissionPolicy, Secrets

- **Network Policies** (docs) **[CORE]**
  https://kubernetes.io/docs/concepts/services-networking/network-policies/
  Default-deny manifests, the DNS-egress gotcha, and the need for a CNI that enforces policies. *Interview Q:* "Show a default-deny policy for a store namespace and the exceptions you must add."
- **Role Based Access Control Good Practices** (docs) **[CORE]**
  https://kubernetes.io/docs/concepts/security/rbac-good-practices/
  Least privilege, namespaced Roles over ClusterRoles, and the dangerous `escalate`, `bind` and `impersonate` verbs. *Interview Q:* "What can your provisioner do, and what is the blast radius if it is compromised?"
- **Service Accounts** (docs)
  https://kubernetes.io/docs/concepts/security/service-accounts/
  Default accounts and token mounting (set `automountServiceAccountToken: false` where not needed).
- **Pod Security Standards** (docs) **[CORE]**
  https://kubernetes.io/docs/concepts/security/pod-security-standards/
  Privileged, Baseline and Restricted, applied per namespace by labels. *Interview Q:* "Can WordPress run under Restricted? What do you need to change?"
- **Validating Admission Policy** (docs)
  https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/
  CEL-based in-process admission rules. *Interview Q:* "How would you forbid a tenant from creating privileged pods or LoadBalancer services?"
- **Encrypting Confidential Data at Rest** (docs)
  https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/
  `EncryptionConfiguration`, why KMS v2 is preferred, and that the default is plaintext in etcd. *Interview Q:* "Are Kubernetes Secrets encrypted? What does your app-level AES-GCM add?"
- **Good practices for Kubernetes Secrets** (docs)
  https://kubernetes.io/docs/concepts/security/secrets-good-practices/
  Complements the encryption page with RBAC and access guidance for Secrets.
- **Kubernetes Network Policies Explained (Stop Exposing Your Pods)**, channel Cloud Guru (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=9IFvdmZjvuY
  Goes from open pod traffic to a locked-down state. It is a recent video, per the search snippet.
- **RBAC in Kubernetes: Role-Based Access Control Explained | Kubernetes Security Tutorial**, channel CodeLucky (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=bDkIX0MA8TU
  A basic RBAC walkthrough.

## 10) Operators, reconcile loops, idempotency, namespace-per-tenant, ResourceQuota/LimitRange

- **Good Practices (Kubebuilder Book)** (docs) **[CORE]**
  https://book.kubebuilder.io/reference/good-practices
  The reconcile loop must be idempotent and should drive toward desired state, not react to events. *Interview Q:* "What happens if your provisioner crashes halfway through creating a store? How do you resume safely?"
- **Multi-tenancy** (docs) **[CORE]**
  https://kubernetes.io/docs/concepts/security/multi-tenancy/
  Namespace-per-tenant versus virtual control planes, and the limits of namespace isolation. *Interview Q:* "Is namespace-per-store enough isolation? When is it not?"
- **Resource Quotas** (docs) and **Limit Ranges** (docs)
  https://kubernetes.io/docs/concepts/policy/resource-quotas/
  https://kubernetes.io/docs/concepts/policy/limit-range/
  ResourceQuota caps the namespace total, and LimitRange sets per-container defaults and bounds. Quota requires pods to declare requests or limits, which is why you need both. *Interview Q:* "Why do you create a LimitRange alongside the ResourceQuota?"
- **Writing a Controller for Pod Labels** (blog, kubernetes.io)
  https://kubernetes.io/blog/2021/06/21/writing-a-controller-for-pod-labels/
  A short, concrete example of the controller loop.
- **How the controller-runtime Cache Actually Works** (blog, kubernetes.io) **[SKIP IF SHORT]**
  https://kubernetes.io/blog/2026/07/29/controller-runtime-cache-explained/
  Event, queue, reconcile. It explains why controllers don't poll the API server.
- **Level Triggering and Reconciliation in Kubernetes - James Bowes**, channel Manifold co (video) **[CORE]**
  https://www.youtube.com/watch?v=tCht7FvIDdY
  The cleanest explanation of why reconcile loops are level-triggered, not edge-triggered.
- **It's all about reconciliation - anatomy of a kubernetes controller, Federico Paolinelli**, channel SPACE (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=Ohsp0woCiiM
  A conference talk on how a controller is built.
- **Kubernetes Quotas, Limits, and Multi-Tenancy: Resource Quotas and LimitRanges**, channel Yet Another Tech Course (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=CE3JF7YMO7c
  The most on-topic video result for quotas in a multi-tenant setting.

Coverage note: I did not find the official "Operator pattern" concept page in the results. Search kubernetes.io for it by name.

## 11) SSRF and DNS rebinding

- **Server-Side Request Forgery Prevention Cheat Sheet** (OWASP) **[CORE]**
  https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
  Allowlist when targets are known, validation layers when any external host must be reachable, and non-HTTP schemes. This is the authoritative base for your gateway's URL checks. *Interview Q:* "Your gateway fetches user-registered upstream URLs. What can go wrong and how do you stop it?"
- **ADR-026: DNS-rebinding defence via CURLOPT_RESOLVE** (design doc) **[CORE]**
  https://docs.typo3.org/p/netresearch/nr-vault/0.9/en-us/Developer/Adr/ADR-026-DnsRebindingDefence.html
  Resolve once, validate every returned address, pin the connection to the validated IP, and re-validate on redirects. It is a PHP project, but the technique is the answer to "how do you defend against rebinding". *Interview Q:* "Why isn't resolving the hostname and checking the IP before fetching enough?"
- **SSRF defense in depth** (blog)
  https://unveilscan.unveiltech.com/blog/ssrf-defense.html
  Argues for a network-level egress backstop (blocking private, link-local and metadata ranges) behind the app checks. This maps onto your NetworkPolicy default-deny.
- **$5,000 Gitlab SSRF by DNS rebinding explained - Hackerone**, channel Bug Bounty Reports Explained (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=R5WB8h7hkrU
  A real-world rebinding bypass, useful for a concrete story.
- **What is SSRF? Server-Side Request Forgery Explained (With Real Attack Example)**, channel Aikido Security (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=-KSOFjNOOMw
  A general SSRF primer.

Also note that the MCP transport spec says servers MUST validate the `Origin` header against DNS rebinding. That is a different attack (browser to local server), and being able to tell the two apart is a good interview point.

## 12) WooCommerce REST API, WP-CLI, WordPress on Kubernetes

- **WooCommerce REST API: Authentication** (docs) **[CORE]**
  https://developer.woocommerce.com/docs/apis/rest-api/authentication/
  `wc/v3` uses HTTP Basic with the consumer key and secret over HTTPS, with a query-string fallback. *Interview Q:* "How does your MCP server authenticate to WooCommerce and where are those keys stored?"
- **WooCommerce REST API** (docs)
  https://developer.woocommerce.com/docs/apis/rest-api/
  The API overview and requirements (pretty permalinks, WooCommerce 3.5 or later).
- **WP-CLI Quick Start** (docs) **[CORE]**
  https://make.wordpress.org/cli/handbook/guides/quick-start/
  The `wp core download`, `wp config create` and `wp core install` sequence. *Interview Q:* "How does a new store get its admin user, WooCommerce plugin and API keys without a human?"
- **How to install WordPress (WP-CLI)** (docs)
  https://make.wordpress.org/cli/handbook/how-to/how-to-install/
  The install walkthrough in detail.
- **Install WordPress in K8s with Bitnami Helm** (guide) **[SKIP IF SHORT]**
  https://cyso.cloud/docs/cloud/extra/install-wordpress-in-k8s-with-bitnami-helm/
  Shows the resulting namespaces, services, pods and PVCs for WordPress plus MariaDB. It is not WooCommerce-specific.
- **Introduction To The WooCommerce Rest API**, channel Neil Matthews (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=x7_uk0CWS_o
  A Postman-based intro. Search snippets said the WooCommerce videos run from about 1.5 to 9.5 years old, so prefer the docs.

Weak coverage: no good source on running WooCommerce specifically on Kubernetes. The guides above cover WordPress plus MariaDB with persistence. The WooCommerce-specific parts (persistent `wp-content`, DB backups) are in your own design, so be ready to explain them from first principles.

## 13) Bun runtime and Hono

- **Bun HTTP server docs** (docs) **[CORE]**
  https://bun.com/docs/runtime/http/server
  `Bun.serve`, routes, `fetch` fallback and timeouts. *Interview Q:* "Why Bun, and what's the exported shape Hono uses on Bun?"
- **Bun test runner** (docs)
  https://bun.com/docs/test
  A Jest-compatible runner, which is how you test the gateway.
- **Hono on Bun** (docs) **[CORE]**
  https://hono.dev/docs/getting-started/bun
  Setup and the `export default { port, fetch: app.fetch }` pattern.
- **Hono Middleware** (docs)
  https://hono.dev/docs/guides/middleware
  Middleware ordering and `c.set` / `c.get`, which maps onto your auth, audit and rate-limit stack. *Interview Q:* "Show how auth middleware attaches the caller identity for tool-permission checks."
- **How to build a Rest APIs CRUD App with Bun.js and Hono.js Web Framework and SQLite**, channel TechWebDocs (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=a_WFb8xU8tc
  The most direct Bun plus Hono build-along I found.
- **Authentication with Hono - JWT, Bun, TypeScript, REST API**, channel Nick Olson Codes (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=8D7jpcs3UOc
  Auth middleware in Hono on Bun.

Weak coverage: the video results were mostly beginner CRUD tutorials. The official docs are the better use of time.

## 14) Vercel AI SDK tool calling and agent loops

- **Loop Control** (docs) **[CORE]**
  https://ai-sdk.dev/docs/agents/loop-control
  `stopWhen`, step-count limits (default 20 for `ToolLoopAgent`) and `prepareStep`. *Interview Q:* "How do you stop a runaway tool loop and cap cost?"
- **AI SDK Core: Tool Calling** (docs) **[CORE]**
  https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling?from=graph&surface=html
  Tool definitions, execution and results flowing back to the model. *Interview Q:* "How do your MCP tools become AI SDK tools?"
- **Agents: Building Agents** (docs)
  https://ai-sdk.dev/docs/agents/building-agents
  The agent abstraction versus a manual `generateText` / `streamText` loop.
- **Multi-Step (Agentic) Generation with the AI SDK**, channel Vercel (video)
  https://www.youtube.com/watch?v=ZmPGr1WHS_s
  Official explainer of multi-step generation. It uses the older `maxSteps` API, so map it to `stopWhen` in the current docs.
- **A Complete Guide To Vercel's AI SDK // The ESSENTIAL Tool For Shipping AI Apps**, channel Matt Pocock (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=mojZpktAiYQ
  A broad tour with a tool-calling section. It is older (about 636 days old in the search snippet).

Note that the docs use `isStepCount` / `stopWhen` in the current pages and `stepCountIs` in the AI SDK 5 announcement. Check which version your repo pins.

## 15) Observability: Prometheus, Grafana, OpenTelemetry, RED

- **Histograms and summaries** (Prometheus docs) **[CORE]**
  https://prometheus.io/docs/practices/histograms/
  Why histograms (aggregatable) beat summaries, and the bucket and cardinality costs. *Interview Q:* "How do you measure p95 latency of tool calls across several gateway replicas?"
- **Instrumentation best practices** (Prometheus docs)
  https://prometheus.io/docs/practices/instrumentation/
  What to measure and how to label without exploding cardinality. *Interview Q:* "Which labels do you put on a per-tool call metric, and which would you never use?"
- **Traces** (OpenTelemetry docs) **[CORE]**
  https://opentelemetry.io/docs/concepts/signals/traces/
  Spans, span context and trace IDs. *Interview Q:* "How do you follow one chat message through agent, gateway and upstream server?"
- **Propagation (OpenTelemetry JS)** (docs)
  https://opentelemetry.io/docs/languages/js/propagation/
  `inject` and `extract` of W3C trace context. This is how the gateway forwards `traceparent` to upstreams.
- **Tom Wilkie, GrafanaCon EU 2018 slides (RED method)** (slides) **[SKIP IF SHORT]**
  https://grafana.com/files/grafanacon_eu_2018/Tom_Wilkie_GrafanaCon_EU_2018.pdf
  The RED method (Rate, Errors, Duration) from its author. Sources describe it as best for request-driven services, with USE for infrastructure.
- **Perform Distributed Tracing for your MCP system with OpenTelemetry**, channel SigNoz - Open Source Observability Platform (video)
  https://www.youtube.com/watch?v=Y0sTVeIra2E
  The only video I found tracing an MCP system specifically, which is a direct fit for your gateway.
- **Prometheus, Grafana & Kubernetes: Installation + Monitoring**, channel Rayan Slim (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=r45DkTMMouc
  Installing the kube-prometheus-stack with Helm.
- **Practical introduction to OpenTelemetry tracing**, channel Quarkus Club (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=mCg4xdDUsw8
  A general intro to tracing.

## 16) Password / API key storage (argon2id, hashing high-entropy tokens, AES-GCM)

- **Password Storage Cheat Sheet** (OWASP) **[CORE]**
  https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
  Argon2id first, with fallbacks (scrypt, bcrypt, PBKDF2) and minimum parameters. *Interview Q:* "Why argon2id for passwords?"
- **How to implement API key authentication** (Zuplo) **[CORE]**
  https://zuplo.com/learning-center/how-to-implement-api-key-authentication
  Covers storing only a hash of the key and prefix-based lookup. A vendor blog, not a standard. *Interview Q:* "Why is plain SHA-256 fine for your API keys but not for passwords?"
- **Argon2 vs SHA256: HMAC-SHA256 Compared** (MojoAuth) **[SKIP IF SHORT]**
  https://mojoauth.com/security-guides/hmac-sha256-vs-argon2
  Argues a fast hash is enough for high-entropy random tokens (roughly 128 bits or more from a CSPRNG), and that a slow hash only adds latency. Also vendor content, so cross-check the entropy argument against OWASP.
- **NIST SP 800-38D revision (pre-draft page)** (standard)
  https://csrc.nist.gov/pubs/sp/800/38/d/r1/iprd
  The standards body page on the GCM revision, which notes the 2^32 invocation limit with random nonces. *Interview Q:* "What goes wrong if an AES-GCM nonce is reused, and how do you avoid it?"
- **Mattsson, GCM with random 96-bit nonces (IACR ePrint 2024/1111)** (paper) **[SKIP IF SHORT]**
  https://eprint.iacr.org/2024/1111.pdf
  A deeper look at the collision risk with random 96-bit IVs. Optional, but it helps if the interviewer pushes on random versus counter nonces.
- **Encrypting Confidential Data at Rest** (Kubernetes docs, same as section 9)
  https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/
  Shows how Kubernetes treats at-rest encryption and where key custody sits. *Interview Q:* "Where does your AES-GCM master key live, and how would you rotate it?"

Coverage note: I found no good video for this topic, so none is listed. I also found no source on envelope encryption in the search results (it is a standard way to cap how many messages each key encrypts), so read about it separately.

## 17) Rate limiting (token bucket) and stateless horizontal scaling

- **[System Design] Token Bucket Algorithm for Rate Limiting: From Single Server to Distributed Systems** (blog) **[CORE]**
  https://reliabilitywhisperer.substack.com/p/system-design-token-bucket-algorithm
  Lazy refill math (`tokens = min(capacity, tokens + rate * elapsed)`) and the move from one server to many. *Interview Q:* "Implement a token bucket. What state does each key need, and what races appear with several replicas?"
- **Designing Scalable Rate Limiting Systems: Algorithms, Architecture, and Distributed Solutions** (paper) **[SKIP IF SHORT]**
  https://arxiv.org/pdf/2602.11741
  A broader survey of algorithms and distributed designs.
- **VI. Processes (The Twelve-Factor App)** (docs) **[CORE]**
  https://12factor.net/processes
  Stateless, share-nothing processes with durable state in backing services. *Interview Q:* "Why does a stateless gateway scale horizontally, and where does rate-limit state live then?"
- **Rate Limiting system design | TOKEN BUCKET, Leaky Bucket, Sliding Logs**, channel Tech Dummies - Narendra Lakshmana Gowda (video)
  https://www.youtube.com/watch?v=mhUQe4BKZXs
  Compares token bucket, leaky bucket and sliding-window approaches.
- **Rate limiting strategies with Valkey/Redis**, channel Percona (video) **[SKIP IF SHORT]**
  https://www.youtube.com/watch?v=h9aqUIt71Ao
  Fixed window, token bucket and leaky bucket on a shared store. Search results did not say whether it covers atomic (Lua) updates, so check that yourself.

Note that if you keep the bucket in each replica's memory, the effective limit is `N * limit`. Be ready to explain that trade-off versus a shared store such as Redis.

---

## Coverage summary

- **Strong:** 1, 2, 3, 4, 6, 7, 9, 10, 11, 14, 15.
- **Adequate:** 5 (no good video for Kuadrant, Microsoft or Cloudflare), 8 (k3d page is v5.3.0, no official ingress-nginx page found), 17.
- **Weak:** 12 (nothing on WooCommerce on Kubernetes), 13 (only beginner CRUD videos), 16 (no video, no envelope-encryption source).
