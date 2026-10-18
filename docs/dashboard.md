# Dashboard design note

The dashboard is a React 19 single-page app (Vite 7, react-router-dom 7, TypeScript, plain CSS). nginx serves the built files on port 8080; Ingress sends `/api`, `/mcp`, `/oauth` and `/.well-known` to the gateway. The browser only ever talks to the gateway, with the httpOnly session cookie. No upstream credential, API key hash or OAuth token hash reaches it.

Source: `apps/dashboard/src`. Build: `bun run build` (`vite build`). Types: `tsc --noEmit -p apps/dashboard`.

## Pages and routes

| Route | Who | What it does | Gateway calls |
| --- | --- | --- | --- |
| `/login` | anyone | Sign in. Honors `?next=` for a same-origin path and loads it with a full page load (it may be the gateway's `/oauth/authorize`). Shows the 429 "too many attempts" text. | `POST /api/login`, `GET /api/me` |
| `/` Servers | all (admin edits) | Card per upstream: status pill, failure reason, last checked, tool count, expandable tool list with `read-only` and `not permitted: <reason>` tags. Admin: add, edit, rotate or clear a credential, enable/disable, probe, delete (confirm dialog). Managed servers show a badge and only allow probing. | `GET /api/servers`, `GET /api/servers/:id/tools`, `POST/PATCH/DELETE /api/servers[/:id]`, `POST /api/servers/:id/probe` |
| `/stores` | all (members see their own) | Create, list, retry, delete stores; slug preview and `used / max` limit. | `GET/POST /api/stores`, `POST /api/stores/:id/retry`, `DELETE /api/stores/:id` |
| `/chat` | all | Tool-loop chat. Each assistant message lists the tool calls with server, tool, arguments, result, ok/failed. | `POST /api/chat`, `GET /api/status` |
| `/keys` | all | Own API keys (token shown once), connected OAuth apps, copy-paste client config. | `/api/api-keys`, `/api/oauth/grants` |
| `/account` | all | Change own password. | `POST /api/me/password` |
| `/hosted` | admin | Deploy an MCP server from an image; list; delete. | `GET/POST /api/hosted`, `DELETE /api/hosted/:id` |
| `/members` | admin | Create account, change role, enable/disable, reset password, revoke any key. | `/api/members`, `PATCH /api/members/:id`, `POST /api/members/:id/password`, `DELETE /api/api-keys/:id` |
| `/permissions` | admin | The default rule in words, existing rules, add or remove a rule. | `/api/grants`, `/api/members`, `/api/servers` |
| `/audit` | admin | Filterable, pageable log with user, via, server, tool, outcome, duration, trace id. | `GET /api/audit` |

Non-admins who open an admin route are redirected to `/`; the gateway enforces the same rule with 403, so the redirect is a convenience, not the control.

`/stores` and `/hosted` treat a 404 or 501 from the gateway as "not available on this gateway" and show a message instead of an error.

## Code layout

- `api.ts`: types, `ApiError` (carries `status`), one `request()` helper, one function per endpoint. A 401 on any call except `/api/login` and the initial `/api/me` sends the browser to `/login`.
- `ui.tsx`: `usePoll`, `useAction`, `Modal`/`Confirm`, `Pill`, `CopyButton`, `Message`, `ErrorBoundary`, time helpers.
- `pages/*.tsx`: one file per page.
- `App.tsx`: auth gate, header navigation, routes. `Hosted`, `Members`, `Permissions` and `Audit` are `React.lazy` chunks so a member never downloads admin code.

## State handling

- No global store. Server state is read where it is shown and re-read after every mutation. Auth state lives in `App`.
- `usePoll(load, ms)` loads on mount and on an interval, skips ticks while the tab is hidden, reloads when the tab becomes visible again, and aborts the request in flight on unmount or when a newer one starts. `load` is read through a ref so a new closure per render does not reset the timer.
- Polling intervals: servers 5 s, stores 3 s while any store is `provisioning` or `deleting` and 15 s otherwise, hosted 5 s, members and permissions 15-20 s, keys 30 s. Audit refreshes every 5 s only when the "refresh" box is ticked.
- Servers fetch tool lists only for cards that are expanded, in parallel.
- Chat history is kept in `sessionStorage` under a versioned key (`urumi.chat.v1`), trimmed to 60 messages, written once per finished reply, and every storage call is wrapped in try/catch. It is per tab and disappears when the tab closes, on purpose: conversations can contain order data.
- Failed actions are shown as text in an `aria-live` region next to the control that caused them. The API's own error text is shown (for example "cannot remove the last active admin").

## Security decisions in the UI

- Stored secrets are never shown. Server cards say "credential set". Editing a credential sends a secret only when the field is filled; clearing is an explicit checkbox.
- The API-key token is held in React state only while its dialog is open and is not written to storage.
- Model and tool output is rendered as text (`white-space: pre-wrap`, JSON in `<pre>`), never as HTML. There is no `dangerouslySetInnerHTML` anywhere.
- `?next=` accepts only a path that starts with a single `/` (not `//`, not `/\`, no control characters).
- The hosted-server form checks the image against the registry allowlist for fast feedback; the provisioner enforces it.

## Accessibility decisions

- Every input has a visible label; icon-only controls do not exist.
- Dialogs are the native `<dialog>` with `showModal()`, which provides the focus trap, Escape to close and the backdrop.
- Status changes (store phase, errors, copy results) are in `aria-live` regions. Tables have visually hidden captions. Status is shown as text in the pill, not by color alone.
- Visible `:focus-visible` outline, a skip link, `aria-current` on the active nav link, `aria-busy` while loading.
- `prefers-color-scheme: dark` through CSS variables; `prefers-reduced-motion` honored.
- Layout works down to 360 px: the header wraps, wide tables scroll inside their own container, and the page itself never scrolls sideways.
- The chat log is a keyboard-focusable `role="log"`; Enter sends and Shift+Enter inserts a newline, and IME composition is respected.

## Why no UI library

The app has ten small pages, about a dozen controls (button, input, select, dialog, table, pill) and no data grid or date picker that the platform does not already provide (`<dialog>`, `<details>`, `<input type="datetime-local">`, `Intl.RelativeTimeFormat`). A component library would be the largest part of the bundle and would hide the accessibility behavior this note describes. The first-load JavaScript is about 93 kB gzip, nearly all React and the router.
