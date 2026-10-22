# HTTP API reference

Three surfaces: the public gateway (browser and MCP clients), the gateway's internal API (provisioner only), and the provisioner's internal API (gateway only). Errors are JSON `{ "error": "<message>" }` with a 4xx status unless stated. Auth column: **none**, **session** (httpOnly cookie from `/api/login`), **admin** (session of an admin), **key** (`Authorization: Bearer umk_...` or an OAuth access token `umo_...`), **service** (shared bearer token).

State-changing `/api/*` calls from a browser must come from the page's own origin (`Origin` header checked against the request host and `ALLOWED_ORIGINS`), else 403.

## Gateway, public (ingress routes `/`, `/api`, `/mcp`, `/oauth`, `/.well-known`)

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz`, `GET /readyz` | none | liveness; readiness (checks Postgres) |
| `POST /api/login` `{username, password}` | none | sets `urumi_session`; 401 on bad credentials or a disabled user; 429 after 8 attempts per username or 20 per client address per minute |
| `POST /api/logout` | none | clears the cookie |
| `GET /api/me` | session | `{user}` |
| `POST /api/me/password` `{current, next}` | session | `next` at least 8 characters; 403 if `current` is wrong |
| `GET /api/status` | session | `{llmConfigured}` |
| `GET /api/servers` | session | server list; `url` only for admins; never any credential; includes `status`, `statusDetail`, `toolCount`, `credentialSet`, `managedBy` |
| `GET /api/servers/:id/tools` | session | `[{name, upstreamName, description, readOnly, allowed, reason}]` evaluated for the caller |
| `POST /api/servers` | admin | `{slug, displayName, url, credentialType?, credentialHeaderName?, secret?}`; 400 on a bad slug, an SSRF-blocked URL or a forbidden header name; 409 on a duplicate slug; probes before answering |
| `PATCH /api/servers/:id` | admin | any of `displayName, url, enabled, credentialType, credentialHeaderName, secret, clearCredential`; a managed server accepts only `enabled` (409 otherwise) |
| `DELETE /api/servers/:id` | admin | 409 for a managed server |
| `POST /api/servers/:id/probe` | admin | re-lists tools now and updates the status |
| `GET /api/api-keys`, `POST /api/api-keys` `{label}` | session | own keys; the token is in the create response only |
| `DELETE /api/api-keys/:id` | session | revoke own key; an admin may revoke anyone's |
| `GET /api/members`, `POST /api/members` `{username, password, role}` | admin | list with keys; create |
| `PATCH /api/members/:id` `{disabled?, role?}` | admin | 409 if it would remove the last active admin |
| `POST /api/members/:id/password` `{password}` | admin | reset |
| `GET /api/audit?user=&server=&tool=&outcome=&from=&to=&beforeId=&limit=` | admin | `{audit: [...], nextBeforeId}`; rows carry `username`, `durationMs`, `outcome`, `traceId` |
| `GET /api/grants`, `PUT /api/grants`, `DELETE /api/grants/:id` | admin | tool permission rules, `PUT` is an upsert on the natural key |
| `POST /api/chat` `{messages}` | session | AI SDK UI message stream; 429 over `CHAT_PER_MINUTE` (20); 503 with no LLM key |
| `GET /api/oauth/grants`, `DELETE /api/oauth/grants/:familyId` | session | the apps the user has authorised; revoke one |
| `GET /api/stores`, `POST /api/stores` `{name}`, `POST /api/stores/:id/retry`, `DELETE /api/stores/:id` | session | proxied to the provisioner as the user; members see and manage only their own; 501 when provisioning is off, 502 when the provisioner is down |
| `GET /api/hosted`, `POST /api/hosted`, `POST /api/hosted/:id/retry`, `DELETE /api/hosted/:id` | admin | proxied to the provisioner |

### MCP

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `POST /mcp` | key | Streamable HTTP, one JSON-RPC object per request, one JSON object back (no sessions, no batches). Methods: `initialize`, `notifications/*`, `ping`, `tools/list`, `tools/call`, `resources/list`, `prompts/list` (both empty) |
| `POST /mcp?surface=search` | key | the three-tool surface: `search_tools`, `describe_tool`, `call_tool` |
| `GET /mcp`, `DELETE /mcp` | none | 405 |

JSON-RPC error codes: `-32602` unknown tool or server (also invalid arguments), `-32003` not permitted (`error.data.code = "denied"`), `-32000` upstream failure with `error.data.code` of `upstream_timeout`, `upstream_unreachable`, `upstream_error`, `server_disabled`, `rate_limited`. A tool that ran and reported failure returns a normal result with `isError: true`. An unauthenticated call is HTTP 401 with `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"`. A browser `Origin` that is not ours is 403.

### OAuth

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /.well-known/oauth-protected-resource` (and `/mcp` suffix) | none | RFC 9728 metadata |
| `GET /.well-known/oauth-authorization-server` | none | RFC 8414 metadata |
| `POST /oauth/register` | none | RFC 7591 dynamic registration, public clients; 10 per minute per address |
| `GET /oauth/authorize` | session (else redirect to `/login?next=`) | consent page; PKCE S256 and `resource` required |
| `POST /oauth/authorize` | session | the Allow or Deny button; the form is HMAC-signed |
| `POST /oauth/token` | none | `authorization_code` (with `code_verifier`) and `refresh_token` (rotating) |
| `POST /oauth/revoke` | none | RFC 7009, revokes the whole grant, always 200 |

## Gateway, internal (not on the Ingress; reachable only from the provisioner pod)

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `PUT /internal/servers/:slug` `{displayName, url, managedBy: "store"|"hosted", secret?}` | service | upsert and probe a managed server; 409 if the slug belongs to a hand-made server |
| `DELETE /internal/servers/:slug` | service | remove a managed server; 409 for a hand-made one; 200 if already gone |

## Provisioner (port 8080, reachable only from the gateway pod)

Every `/v1` call needs `Authorization: Bearer <PROVISIONER_TOKEN>` and `X-Urumi-User-Id`, `X-Urumi-Username`, `X-Urumi-Role`.

| Method and path | Purpose |
| --- | --- |
| `GET /v1/stores` | `{stores, limits: {maxPerUser, used}}`; a store has `id, name, slug, namespace, host, url, mcpSlug, status, phase, reason, attempt, deadlineAt, createdAt, updatedAt, ownerName` |
| `POST /v1/stores` `{name}` | 201 new, 200 if the same owner already has it, 409 name taken by someone else, 429 over the cap, 400 bad name |
| `POST /v1/stores/:id/retry` | 202; only from `failed`, else 409 |
| `DELETE /v1/stores/:id` | 202; idempotent |
| `GET /v1/hosted`, `POST /v1/hosted`, `POST /v1/hosted/:id/retry`, `DELETE /v1/hosted/:id` | admin only; create body `{slug, displayName, image, size, port?, env?, secretEnv?}` |
| `GET /healthz`, `GET /readyz`, `GET /metrics` | probes and metrics (metrics also on port 9090) |
