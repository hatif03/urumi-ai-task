import { useState, type FormEvent } from "react";
import { api, isUnavailable, type StoreRow } from "../api.ts";
import { Confirm, Message, Pill, errorText, fmtTime, relativeTime, toSlug, usePoll, useAction } from "../ui.tsx";

// Mirrors the provisioner's rule so the preview matches what the server will create.
const storeSlug = (name: string) => toSlug(name, "").slice(0, 16);

export function Stores({ admin }: { admin: boolean }) {
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<StoreRow | null>(null);
  const [busyPoll, setBusyPoll] = useState(false);
  const action = useAction();

  // Fast while something is changing, slow otherwise.
  const { data, error, loading, reload } = usePoll(async (signal) => {
    const result = await api.stores(signal);
    setBusyPoll(result.stores.some((s) => s.status === "provisioning" || s.status === "deleting"));
    return result;
  }, busyPoll ? 3000 : 15000);

  const slug = storeSlug(name);
  const slugOk = /^[a-z][a-z0-9]{2,15}$/.test(slug);
  const atLimit = data ? data.limits.used >= data.limits.maxPerUser : false;

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const created = await action.run(() => api.createStore(name.trim()));
    if (created) {
      setName("");
      setBusyPoll(true);
      void reload();
    }
  }

  if (isUnavailable(error)) {
    return (
      <section>
        <h1>Stores</h1>
        <p role="status">Store provisioning is unavailable on this gateway.</p>
      </section>
    );
  }

  return (
    <section>
      <h1>Stores</h1>
      <p className="muted">Each store is a WooCommerce shop in its own namespace with its own database. When it is ready it appears as an MCP server named <code>store_&lt;slug&gt;</code> and the chat agent can use it.</p>

      <form onSubmit={create} aria-label="Create a store">
        <label>Store name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="Alpha Coffee" />
        </label>
        <p className="muted small" aria-live="polite">
          {name ? (slugOk ? <>Slug <code>{slug}</code> · MCP server <code>store_{slug}</code> · tools <code>store_{slug}__list_orders</code></> : "The name needs 3 to 16 letters or digits, starting with a letter.") : "Pick a name; the slug is derived from it."}
          {data ? <> · {data.limits.used} of {data.limits.maxPerUser} stores used</> : null}
        </p>
        <Message error={action.error} />
        <button type="submit" disabled={action.busy || !slugOk || atLimit}>{atLimit ? "Store limit reached" : "Create store"}</button>
      </form>

      <Message error={error ? errorText(error) : ""} />
      {loading ? <p aria-busy="true">Loading…</p> : null}
      {data && !data.stores.length ? <p>No stores yet.</p> : null}
      {data?.stores.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr">Stores</caption>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Phase</th>
                <th>URL</th>
                <th>MCP server</th>
                <th>Created</th>
                {admin ? <th>Owner</th> : null}
                <th><span className="sr">Actions</span></th>
              </tr>
            </thead>
            <tbody aria-live="polite">
              {data.stores.map((store) => (
                <tr key={store.id}>
                  <td>{store.name}<div className="muted small"><code>{store.slug}</code></div></td>
                  <td>
                    <Pill kind={store.status} />
                    {store.reason ? <div className="error small">{store.reason}</div> : null}
                    {store.status === "failed" && store.attempt > 1 ? <div className="muted small">attempt {store.attempt}</div> : null}
                  </td>
                  <td>{store.phase}</td>
                  <td>{store.url && store.status === "ready" ? <a href={store.url} target="_blank" rel="noreferrer">{store.url.replace(/^https?:\/\//, "")}</a> : <span className="muted">—</span>}</td>
                  <td>{store.mcpSlug ? <code>{store.mcpSlug}</code> : <span className="muted">—</span>}</td>
                  <td title={fmtTime(store.createdAt)}>{relativeTime(store.createdAt)}</td>
                  {admin ? <td>{store.ownerName ?? ""}</td> : null}
                  <td>
                    <div className="row">
                      {store.status === "failed" ? <button type="button" onClick={() => action.run(() => api.retryStore(store.id)).then(reload)}>Retry</button> : null}
                      <button type="button" className="danger" disabled={store.status === "deleting"} onClick={() => setDeleting(store)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Confirm
        open={deleting !== null}
        title="Delete store"
        message={deleting ? <>Delete <strong>{deleting.name}</strong>? The namespace, database, volumes, secrets and its MCP server are removed. This cannot be undone.</> : null}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const target = deleting;
          setDeleting(null);
          if (target) await action.run(() => api.deleteStore(target.id));
          setBusyPoll(true);
          void reload();
        }}
      />
    </section>
  );
}
