import { useState, type FormEvent } from "react";
import { api, type KeyRow, type OAuthGrant } from "../api.ts";
import { Confirm, CopyButton, Message, Modal, Pill, errorText, fmtTime, relativeTime, usePoll, useAction } from "../ui.tsx";

export function Keys() {
  const [token, setToken] = useState("");
  const [revoking, setRevoking] = useState<KeyRow | null>(null);
  const action = useAction();
  const keys = usePoll(() => api.keys().then((r) => r.keys), 30000);
  const grants = usePoll(() => api.oauthGrants().then((r) => r.grants), 30000);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const label = String(new FormData(form).get("label") || "default");
    const created = await action.run(() => api.createKey(label));
    if (created) {
      form.reset();
      setToken(created.token);
      void keys.reload();
    }
  }

  const origin = window.location.origin;
  const config = JSON.stringify({ mcpServers: { urumi: { url: `${origin}/mcp`, headers: { Authorization: "Bearer umk_…your key…" } } } }, null, 2);

  return (
    <section>
      <h1>API keys</h1>
      <p className="muted">A key lets an MCP client such as Claude Code or Cursor use every enabled server through the gateway as you. You never see or need the upstream credentials.</p>
      <form onSubmit={create} aria-label="Create an API key">
        <label>Label<input name="label" placeholder="laptop, cursor, ci…" maxLength={80} /></label>
        <Message error={action.error} />
        <button type="submit" disabled={action.busy}>Create key</button>
      </form>

      <Modal open={token !== ""} title="Your new API key" onClose={() => setToken("")}>
        <p>Copy it now. It is shown once and only a hash is stored.</p>
        <p><code className="break token">{token}</code></p>
        <div className="row">
          <CopyButton text={token} label="Copy key" />
          <button type="button" onClick={() => setToken("")}>I have saved it</button>
        </div>
      </Modal>

      <Message error={keys.error ? errorText(keys.error) : ""} />
      <div className="table-wrap">
        <table>
          <caption className="sr">Your API keys</caption>
          <thead><tr><th>Prefix</th><th>Label</th><th>Status</th><th>Created</th><th>Last used</th><th><span className="sr">Actions</span></th></tr></thead>
          <tbody>
            {keys.data?.map((key) => (
              <tr key={key.id}>
                <td><code>{key.prefix}…</code></td>
                <td>{key.label}</td>
                <td><Pill kind={key.revokedAt ? "disabled" : "connected"}>{key.revokedAt ? "revoked" : "live"}</Pill></td>
                <td title={fmtTime(key.createdAt)}>{relativeTime(key.createdAt)}</td>
                <td>{key.lastUsedAt ? relativeTime(key.lastUsedAt) : "never"}</td>
                <td>{key.revokedAt ? null : <button type="button" className="danger" onClick={() => setRevoking(key)}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {keys.data && !keys.data.length ? <p>You have no keys yet.</p> : null}
      <Confirm
        open={revoking !== null}
        title="Revoke key"
        confirmLabel="Revoke"
        message={revoking ? <>Revoke <code>{revoking.prefix}…</code> ({revoking.label})? Any client using it is rejected on its next call.</> : null}
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          const target = revoking;
          setRevoking(null);
          if (target) await action.run(() => api.revokeKey(target.id));
          void keys.reload();
        }}
      />

      <ConnectedApps grants={grants.data} reload={grants.reload} />

      <h2>Connect a client</h2>
      <div className="card">
        <p>Gateway URL: <code>{origin}/mcp</code> <CopyButton text={`${origin}/mcp`} /></p>
        <p>Cursor or Claude Code, with an API key:</p>
        <pre>{config}</pre>
        <CopyButton text={config} label="Copy JSON" />
        <p className="muted small">Clients that support OAuth can skip the key: add only the URL and approve the browser sign-in; the app then shows up under “Connected apps” above.</p>
        <p className="muted small">With many servers connected, a model does better with three search tools than hundreds of definitions. Use <code>{origin}/mcp?surface=search</code> to get <code>search_tools</code>, <code>describe_tool</code> and <code>call_tool</code>. Permissions and the audit log are the same.</p>
      </div>
    </section>
  );
}

function ConnectedApps({ grants, reload }: { grants: OAuthGrant[] | undefined; reload: () => Promise<void> }) {
  const [target, setTarget] = useState<OAuthGrant | null>(null);
  const action = useAction();
  return (
    <>
      <h2>Connected apps</h2>
      <p className="muted small">Apps you approved through the browser sign-in.</p>
      <Message error={action.error} />
      {grants && !grants.length ? <p>No apps are connected.</p> : null}
      {grants?.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr">Connected apps</caption>
            <thead><tr><th>App</th><th>Authorised</th><th>Last used</th><th><span className="sr">Actions</span></th></tr></thead>
            <tbody>
              {grants.map((grant) => (
                <tr key={grant.familyId}>
                  <td>{grant.clientName}</td>
                  <td title={fmtTime(grant.createdAt)}>{relativeTime(grant.createdAt)}</td>
                  <td>{grant.lastUsedAt ? relativeTime(grant.lastUsedAt) : "never"}</td>
                  <td><button type="button" className="danger" onClick={() => setTarget(grant)}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <Confirm
        open={target !== null}
        title="Revoke app"
        confirmLabel="Revoke"
        message={target ? <>Revoke access for <strong>{target.clientName}</strong>? It must be approved again to reconnect.</> : null}
        onCancel={() => setTarget(null)}
        onConfirm={async () => {
          const grant = target;
          setTarget(null);
          if (grant) await action.run(() => api.revokeOauthGrant(grant.familyId));
          await reload();
        }}
      />
    </>
  );
}
