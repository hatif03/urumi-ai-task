import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, type ServerRow, type SessionUser, type ToolRow } from "../api.ts";
import { Confirm, Message, Modal, Pill, errorText, fmtTime, relativeTime, toSlug, usePoll, useAction } from "../ui.tsx";

type Loaded = { servers: ServerRow[]; tools: Record<string, ToolRow[]> };

export function Servers({ admin }: { admin: boolean; user: SessionUser }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<ServerRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<ServerRow | null>(null);
  const action = useAction();

  const { data, error, loading, reload } = usePoll<Loaded>(async (signal) => {
    const { servers } = await api.servers(signal);
    // Tool lists are fetched only for the cards that are expanded, in parallel.
    const entries = await Promise.all(servers.filter((s) => open.has(s.id)).map(async (s) => [s.id, (await api.serverTools(s.id, signal)).tools] as const));
    return { servers, tools: Object.fromEntries(entries) };
  }, 5000);

  const toggle = (id: string, isOpen: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (isOpen) next.add(id);
      else next.delete(id);
      return next;
    });

  // Re-read when an expansion changes so a newly opened card gets its tools straight away.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else void reload();
  }, [open, reload]);

  return (
    <section>
      <div className="row between">
        <h1>Servers</h1>
        {admin ? <button type="button" onClick={() => setEditing("new")}>Add server</button> : null}
      </div>
      <Message error={action.error || (error ? errorText(error) : "")} />
      {loading ? <p aria-busy="true">Loading…</p> : null}
      {data && !data.servers.length ? <p>No servers are registered yet.</p> : null}
      <div className="stack">
        {data?.servers.map((server) => (
          <ServerCard
            key={server.id}
            server={server}
            admin={admin}
            tools={data.tools[server.id]}
            onToggle={(isOpen) => toggle(server.id, isOpen)}
            onEdit={() => setEditing(server)}
            onDelete={() => setDeleting(server)}
            onToggleEnabled={() => action.run(() => api.updateServer(server.id, { enabled: !server.enabled })).then(reload)}
            onProbe={() => action.run(() => api.probe(server.id)).then(reload)}
          />
        ))}
      </div>

      <Modal open={editing !== null} title={editing === "new" ? "Add server" : "Edit server"} onClose={() => setEditing(null)}>
        {editing ? <ServerForm initial={editing === "new" ? null : editing} onDone={() => { setEditing(null); void reload(); }} onCancel={() => setEditing(null)} /> : null}
      </Modal>
      <Confirm
        open={deleting !== null}
        title="Delete server"
        message={deleting ? <>Remove <strong>{deleting.displayName}</strong>? Its tools disappear for everyone immediately. Audit rows are kept.</> : null}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const target = deleting;
          setDeleting(null);
          if (target) await action.run(() => api.deleteServer(target.id));
          void reload();
        }}
      />
    </section>
  );
}

function ServerCard({ server, admin, tools, onToggle, onEdit, onDelete, onToggleEnabled, onProbe }: {
  server: ServerRow;
  admin: boolean;
  tools: ToolRow[] | undefined;
  onToggle: (open: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onProbe: () => void;
}) {
  const managed = server.managedBy;
  return (
    <article className="card">
      <div className="row">
        <strong>{server.displayName}</strong>
        <code>{server.slug}</code>
        <Pill kind={server.status} />
        {managed ? <span className="tag">managed by {managed === "store" ? <Link to="/stores">store</Link> : <Link to="/hosted">hosted server</Link>}</span> : null}
        <span className="muted">{server.toolCount} tools</span>
      </div>
      {server.statusDetail ? <p className={server.status === "unreachable" ? "error" : "muted"}>{server.statusDetail}</p> : null}
      <p className="muted small">
        Checked {relativeTime(server.lastCheckedAt)} ({fmtTime(server.lastCheckedAt)})
        {server.credentialSet ? " · credential set" : server.credentialType !== "none" ? " · credential missing" : ""}
        {server.url ? <> · <code>{server.url}</code></> : null}
      </p>
      <details onToggle={(event) => onToggle(event.currentTarget.open)}>
        <summary>Tools</summary>
        {!tools ? <p aria-busy="true">Loading tools…</p> : null}
        {tools && !tools.length ? <p className="muted">No tools cached. {server.enabled ? "Probe the server to refresh." : "The server is disabled."}</p> : null}
        <ul className="tools">
          {tools?.map((tool) => (
            <li key={tool.name}>
              <code>{tool.name}</code>
              {tool.readOnly ? <span className="tag">read-only</span> : null}
              {!tool.allowed ? <span className="tag deny">not permitted: {tool.reason}</span> : null}
              <div className="muted small">{tool.description}</div>
            </li>
          ))}
        </ul>
      </details>
      {admin ? (
        <div className="row">
          {!managed ? <button type="button" onClick={onEdit}>Edit</button> : null}
          {!managed ? <button type="button" onClick={onToggleEnabled}>{server.enabled ? "Disable" : "Enable"}</button> : null}
          <button type="button" onClick={onProbe} disabled={!server.enabled}>Probe</button>
          {!managed ? <button type="button" className="danger" onClick={onDelete}>Delete</button> : null}
        </div>
      ) : null}
    </article>
  );
}

function ServerForm({ initial, onDone, onCancel }: { initial: ServerRow | null; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.displayName ?? "");
  const [slug, setSlug] = useState("");
  const [credentialType, setCredentialType] = useState<string>(initial?.credentialType ?? "none");
  const { busy, error, run } = useAction();
  const shownSlug = initial ? initial.slug : slug || toSlug(name);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const secret = String(data.get("secret") || "");
    const header = String(data.get("header") || "");
    const common = { displayName: name, url: String(data.get("url")), credentialType };
    const done = await run(() => initial
      ? api.updateServer(initial.id, {
          ...common,
          ...(credentialType === "header" ? { credentialHeaderName: header } : {}),
          // A blank secret keeps the stored one; the checkbox is the only way to remove it.
          ...(secret ? { secret } : {}),
          ...(data.get("clear") ? { clearCredential: true } : {}),
        })
      : api.createServer({ ...common, slug: shownSlug, credentialHeaderName: credentialType === "header" ? header : undefined, secret: secret || undefined }));
    if (done) onDone();
  }

  return (
    <form onSubmit={submit}>
      <label>Display name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></label>
      {initial ? (
        <p className="muted small">Slug <code>{initial.slug}</code> cannot change: public tool names and audit rows use it.</p>
      ) : (
        <label>Slug (the prefix of every tool name)
          <input value={slug} placeholder={toSlug(name) || "auto from the name"} onChange={(e) => setSlug(toSlug(e.target.value))} pattern="[a-z][a-z0-9]*(_[a-z0-9]+)*" />
          <span className="muted small">Tools will be named <code>{shownSlug || "slug"}__tool_name</code></span>
        </label>
      )}
      <label>URL<input name="url" type="url" defaultValue={initial?.url ?? ""} required placeholder="http://example.svc.cluster.local:8080/mcp" /></label>
      <label>Credential
        <select value={credentialType} onChange={(e) => setCredentialType(e.target.value)}>
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
          <option value="header">Custom header</option>
        </select>
      </label>
      {credentialType === "header" ? <label>Header name<input name="header" defaultValue={initial?.credentialHeaderName ?? ""} required pattern="[A-Za-z0-9-]+" /></label> : null}
      {credentialType !== "none" ? (
        <label>{initial?.credentialSet ? "New secret (leave blank to keep the current one)" : "Secret"}
          <input name="secret" type="password" autoComplete="off" required={!initial?.credentialSet} />
        </label>
      ) : null}
      {initial?.credentialSet ? <label className="check"><input name="clear" type="checkbox" /> Remove the stored credential</label> : null}
      <p className="muted small">The secret is stored encrypted on the server and is never sent back to any browser or client.</p>
      <Message error={error} />
      <div className="row">
        <button type="submit" disabled={busy}>{initial ? "Save" : "Add server"}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
