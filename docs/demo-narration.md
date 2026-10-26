# Demo narration script

Voice-over for the demo video, in the order and at the times it plays in `docs/demo/urumi-demo.mp4` (19:43 long). Each block is what is said while the action on screen happens; the time is when the line starts. If you want to re-record the voice yourself, read each block at that time. Regenerate this file and the video with `bun scripts/demo/record.ts` then `bun scripts/demo/assemble.ts`.

The bundled voice is a synthetic text-to-speech voice (en-US-ChristopherNeural), not a recording of a person.


## System design

**[00:00]** Hi, this is my Round 1 submission: a WooCommerce hosting platform with a team MCP gateway, running on Kubernetes. Everything you will see is the real system, deployed on a k3s server on AWS, reached over real HTTPS with Let's Encrypt certificates.

**[00:18]** There are four layers. First, the store: WordPress and WooCommerce with MariaDB, on persistent volumes, in the store namespace. Second, a WooCommerce MCP server that I wrote myself. It exposes products and orders as tools over Streamable HTTP, and it talks to the store through the WooCommerce REST API with a scoped key.

**[00:41]** Third, the gateway and the dashboard. The gateway is an MCP client to every registered server, and it is itself one MCP server that exposes all their tools at a single endpoint. Postgres holds users, hashed API keys, encrypted upstream credentials, permissions and the audit log. The dashboard is a React app for admins and members.

**[01:06]** Fourth, the chat agent. It runs inside the gateway and calls tools through the same router that external clients use, acting as the logged-in user. Nothing talks to an upstream server except the gateway.

**[01:20]** Besides the core, I built the multi-store bonus: a provisioner creates a complete store in its own namespace with Helm and registers its tools automatically. And these stand-out items: tool permissions, OAuth, tool search for large catalogs, hosted MCP servers, security hardening, scaling, observability, a real VPS with TLS, and upgrade with rollback.


## Store

**[01:44]** First, the store. This is the storefront, served by WordPress and WooCommerce inside the cluster. I add a product to the cart and go to checkout.

**[01:55]** At checkout I fill in the shipping details as a customer would. This is WooCommerce's block checkout, talking to its Store API, and everything on this page is served by the WordPress pod in the store namespace.

**[02:13]** I choose cash on delivery, which is test-friendly, and place the order.

**[02:20]** The order is confirmed, number 25. Now the WooCommerce admin. Here is the same order in the list. The data lives in MariaDB on a persistent volume, so it survives pod restarts.


## Kubernetes

**[02:37]** Now Kubernetes. This is the k3s node. The system uses three namespaces of its own. Platform runs the gateway, the dashboard, Postgres, the provisioner, two more MCP servers and the observability stack. Store runs WordPress, MariaDB and the WooCommerce MCP server. And mcp-hosted is for servers deployed from an image.

**[02:59]** Persistent storage: the database, WordPress content and Postgres each have a persistent volume claim, bound on the node's disk. Secrets are Kubernetes Secrets generated at install time; none are in the repository or in a values file, and you only see their names here.

**[03:18]** Ingress. Only the dashboard host and the shop host are exposed, each with its own Let's Encrypt certificate issued by cert-manager. The gateway's MCP endpoint is a path on the dashboard host. There is no ingress and no public service for any upstream MCP server.

**[03:38]** Every workload has resource requests and limits and readiness and liveness probes. Here is the gateway deployment: the CPU and memory it asks for, the ceiling it may use, and the probes Kubernetes uses to decide when to send traffic and when to restart it.

**[03:57]** How internal-only is enforced: every namespace has a default-deny network policy, and the WooCommerce MCP server admits traffic only from the gateway. I will prove it. First a throwaway pod tries to open the MCP server's port. Then the gateway pod tries the same thing.

**[04:17]** The random pod is blocked and the gateway is let through. The same policies keep one store's MCP server away from another store's database, and the containers run as non-root with read-only filesystems.


## Chat as user A

**[04:32]** Now the dashboard, as user A, an admin. The Servers page lists every registered upstream with its status and the tools it exposes. The WooCommerce server was registered first, automatically, at install time.

**[04:46]** Now the chat agent. I ask it to create a product with a name and a price.

**[04:55]** The agent called the WooCommerce create product tool, and the chat shows exactly which tool it called, with its arguments and result. Now the storefront: the product is there.

**[05:07]** I place an order for it by hand on the storefront, as a customer would. The Demo Mug the agent created is the first product in the shop.

**[05:19]** Same checkout as before: shipping details, then cash on delivery.

**[05:41]** And place the order.

**[05:48]** Order 28 is placed. Back in the chat I ask what orders came in today.

**[05:56]** The agent called the list orders tool and returned the order I just placed. It acted as ada: the call went through the gateway's router with her user id, and it will show in the audit log under her name.


## External client as user B

**[06:14]** As admin I can add another MCP server by URL and credential. I register a second copy of the demo utility server with a bearer secret. Note the secret field: once saved, it is never shown again.

**[06:37]** Next, team members. I invite maya with the member role.

**[06:45]** Now I am maya, user B. A member sees no Members, Permissions or Audit pages. I open API keys and generate my own key. It is shown once, and only its hash is stored.

**[07:00]** Now an external MCP client on my own machine: the MCP Inspector. All it has is the gateway URL and maya's key. Listing tools returns the tools of every enabled server, each prefixed with its server's name. Notice the two servers that both offer an echo tool: they stay distinct: utility, double underscore, echo, and demo underscore echo, double underscore, echo. That is my collision scheme.

**[07:29]** Now the orders question: I call the list orders tool and get the same order that user A's agent saw.

**[07:38]** One prompt that needs two different upstream servers. Here is Claude Code as the client, configured only with the gateway URL and maya's key. I ask for the current time in UTC and the number of orders. The time comes from the utility server and the orders from WooCommerce.

**[07:59]** What can a member not do? Bea's tool list has no write tools: update order status is hidden from her. If she calls it directly anyway, by sending the JSON-RPC request by hand, the gateway rejects it with a denied error. Admins can still do it.


## Team and control

**[08:20]** Now control. As admin I disable the second utility server. Its tools should disappear for everyone, both in the chat agent and in an external client.

**[08:31]** The external client lists tools again. demo_echo's tools are gone.

**[08:36]** And in the chat agent, as ada, the same question now has no tool to answer it.

**[08:52]** Next, kill an upstream. I scale the policy server's pods to zero. The dashboard shows it as unreachable with the reason, while the WooCommerce server stays connected.

**[09:07]** From the external client, tool listing still works and a WooCommerce call still succeeds. A call to the dead server's tool fails with a clear error instead of hanging, within its timeout.

**[09:22]** I bring the server back. Now revoke maya's key. In the members list I open her keys and press revoke.

**[09:35]** Bea's next call is rejected: the gateway answers 401 unauthorized, and points at its OAuth metadata, which is why a client like the Inspector would fall back to a browser login.

**[09:48]** Finally the audit log. Every call above is here, attributed to the right user: ada's chat calls with actor chat, maya's calls through the API key, the denied write, the rejected revoked key, with the server, tool, time, duration and outcome for each.


## MCP internals

**[10:08]** How a tool call travels. A client posts a JSON-RPC message to the gateway's single MCP endpoint. Ingress routes it to a gateway pod. The gateway authenticates the key or OAuth token, resolves the tool name to a server, takes a token from the caller's rate-limit bucket, checks permissions, and only then connects to the upstream with its stored credential and calls the tool with a deadline. The upstream, for example my WooCommerce server, calls the store's REST API and the result travels back unchanged, with an audit row written on the way.

**[10:48]** Name collisions. A public tool name is the server's slug, two underscores, and the upstream tool name. Two servers that both export list orders become store alpha list orders and store beta list orders. The router splits at the first double underscore and strips the prefix before calling the upstream.

**[11:10]** Timeouts and a dead upstream. Listing asks every server in parallel with a three second deadline, and a server that misses it contributes nothing and is marked unreachable. Every call has its own eight second deadline and its own connection, so one slow or dead server can never delay a call to another. This is the failure matrix: what the caller sees, what the dashboard shows, and what the audit log records.


## Security posture

**[11:42]** Security. API keys are shown once and stored only as a SHA-256 hash with a short prefix for lookup; passwords are hashed with a memory-hard function. Here is the database. There is no way to recover a key from it.

**[12:00]** Upstream credentials are encrypted at rest with AES-GCM under a key that lives only in a Kubernetes Secret. The second utility server I added has a bearer secret; this is what is stored. The API never returns it, the browser never sees it, and an MCP client only ever gets tools.

**[12:22]** Client tokens are never passed through to upstream servers. The gateway uses its own stored credential for each upstream, and the caller's Authorization and cookie headers are never forwarded. That is the confused-deputy rule from the MCP authorization specification.

**[12:39]** Now the malicious or compromised server. First, a server URL aimed at the cloud metadata address or the cluster's internal network. The gateway resolves the name once, checks every address against a block list, pins the connection to the checked address, and refuses redirects. Let me add one.

**[13:00]** It is blocked by the SSRF policy, with that reason shown. Second, a server that is reachable but hostile: its tool descriptions are untrusted text that ends up in a model's context. The gateway strips control and bidirectional characters, caps their length, labels each tool with its server, and tells the chat model to treat tool text as data. Most importantly, the permission check is outside the model: if a model is talked into calling a write tool, a member's call is still denied.

**[13:41]** What one member can do to another: nothing. Keys, chat history and sessions are per user, a member sees no other user's keys or the audit log, and a member cannot reach upstream credentials. Admins can manage servers, members and permissions; members can use only the tools their role allows.

**[14:12]** This is the permissions page: per-role and per-user allow or deny rules for any server or tool. Restricted tools are hidden from the tool list and rejected if called directly. By default members get read-only tools.


## Chat agent

**[14:29]** The chat agent. The dashboard posts the conversation to the gateway. The gateway builds the model's tool list from what the logged-in user is allowed to call, and runs a loop: the model proposes tool calls, the gateway executes them, the results go back to the model, for up to eight steps. The model can be any provider; I am using an open-weight model hosted on Groq, through an OpenAI-compatible endpoint, and its key is in a Kubernetes Secret.

**[15:03]** The important line is here: each tool call goes through the same router function as an external client's call, with the session user as the caller. So the permissions, rate limits and audit are identical, and the audit row says actor chat with that user's name. The agent never holds a credential of its own and never talks to an upstream directly.


## Local to VPS

**[15:31]** The local to production story. It is the same Helm chart in both places. Local uses values-local.yaml: k3d, hosts-file names, no TLS, images imported into the cluster. The VPS uses values-prod.yaml plus a short list of overrides: domain names, https, a certificate issuer, image registry and tag, larger limits and volumes. This is the diff of the two files.

**[15:57]** The bootstrap script installs k3s, ingress-nginx and cert-manager, generates every secret into a root-only file, creates the Kubernetes Secrets from it, and then installs the chart with exactly these overrides. Domains and ingress hosts, TLS through a Let's Encrypt cluster issuer, storage on the local-path class, and secrets generated on the server and never in the repository.

**[16:21]** Upgrades and rollback. Here is the release history. First I upgrade the gateway to an image tag that does not exist, atomically. While Helm waits, a loop checks that the dashboard keeps answering. The new pods cannot pull that image, so they never become ready. Because the deployment rolls out with zero unavailable pods, Kubernetes keeps sending traffic to the old, healthy gateway pods, and you can see the dashboard answering two hundred the whole time. When the timeout passes, Helm marks the revision as failed and rolls back by itself.

**[17:33]** The history shows the failed revision and the automatic rollback. Now a normal upgrade and a manual rollback: I change one gateway setting, then roll back to the previous revision. Everything is back as it was, and the store, its data and the other servers were never touched.

**[19:15]** That is the system: a real WooCommerce store, my own MCP server, a gateway that aggregates, secures and audits every tool, a chat agent that acts as the user, per-store provisioning, and one set of Helm charts from a laptop to a VPS. The repository has the README, the design and threat-model notes, and the evidence from these runs. Thank you for watching.

