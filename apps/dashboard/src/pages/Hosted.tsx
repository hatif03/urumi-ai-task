import { useState, type FormEvent } from "react";
import { api, isUnavailable, type HostedRow } from "../api.ts";
import { Confirm, Message, Pill, errorText, fmtTime, relativeTime, toSlug, usePoll, useAction } from "../ui.tsx";

type Row = { key: string; value: string };

export default function Hosted() {
  const [deleting, setDeleting] = useState<HostedRow | null>(null);
  const action = useAction();
  const { data, error, loading, reload } = usePoll((signal) => api.hosted(signal), 5000);

  if (isUnavailable(error)) {
    return (
      <section>
        <h1>Hosted servers</h1>
        <p role="status">Hosted MCP servers are unavailable on this gateway.</p>
      </section>
    );
  }

  return (
    <section>
      <h1>Hosted servers</h1>
      <p className="muted">Deploy an MCP server from a container image into the cluster. It gets its own Secret, resource limits and NetworkPolicy, and is registered here automatically. Deleting it removes all of that.</p>
      {data ? <HostedForm registries={data.registries} sizes={data.sizes} onDone={() => void reload()} /> : null}
      <Message error={action.error || (error ? errorText(error) : "")} />
      {loading ? <p aria-busy="true">Loading…</p> : null}
      {data && !data.hosted.length ? <p>No hosted servers yet.</p> : null}
      {data?.hosted.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr">Hosted servers</caption>
            <thead><tr><th>Server</th><th>Image</th><th>Size</th><th>Status</th><th>Created</th><th><span className="sr">Actions</span></th></tr></thead>
            <tbody aria-live="polite">
              {data.hosted.map((row) => (
                <tr key={row.id}>
                  <td>{row.displayName}<div className="muted small"><code>{row.slug}</code></div></td>
                  <td><code className="break">{row.image}</code></td>
                  <td>{row.size}</td>
                  <td><Pill kind={row.status} />{row.reason ? <div className="error small">{row.reason}</div> : null}</td>
                  <td title={fmtTime(row.createdAt)}>{relativeTime(row.createdAt)}</td>
                  <td><button type="button" className="danger" onClick={() => setDeleting(row)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <Confirm
        open={deleting !== null}
        title="Delete hosted server"
        message={deleting ? <>Delete <strong>{deleting.displayName}</strong>? The workload, its Secret and its network policy are removed and its tools disappear.</> : null}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const target = deleting;
          setDeleting(null);
          if (target) await action.run(() => api.deleteHosted(target.id));
          void reload();
        }}
      />
    </section>
  );
}

function HostedForm({ registries, sizes, onDone }: { registries: string[]; sizes: string[]; onDone: () => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [image, setImage] = useState("");
  const [env, setEnv] = useState<Row[]>([]);
  const [secrets, setSecrets] = useState<Row[]>([]);
  const { busy, error, setError, run } = useAction();
  const shownSlug = slug || toSlug(name);
  const registryOk = !image || registries.some((registry) => image.startsWith(registry));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!registryOk) return setError(`The image must come from one of: ${registries.join(", ")}`);
    const toObject = (rows: Row[]) => Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));
    const done = await run(() => api.createHosted({ slug: shownSlug, displayName: name, image, size: String(data.get("size")), env: toObject(env), secretEnv: toObject(secrets) }));
    if (done) {
      setName(""); setSlug(""); setImage(""); setEnv([]); setSecrets([]);
      onDone();
    }
  }

  return (
    <form onSubmit={submit} aria-label="Host a server">
      <h2>Host a server</h2>
      <label>Display name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></label>
      <label>Slug
        <input value={slug} onChange={(e) => setSlug(toSlug(e.target.value))} placeholder={toSlug(name) || "auto from the name"} pattern="[a-z][a-z0-9]*(_[a-z0-9]+)*" />
        <span className="muted small">Tools will be named <code>{shownSlug || "slug"}__tool_name</code></span>
      </label>
      <label>Image
        <input value={image} onChange={(e) => setImage(e.target.value)} required placeholder={registries[0] ? `${registries[0]}my-server:1.0.0` : "registry/name:tag"} aria-invalid={!registryOk} />
        <span className="muted small">Allowed registries: {registries.length ? registries.map((r) => <code key={r}>{r} </code>) : "none configured"}. Use a version tag or digest, not <code>latest</code>.</span>
        {!registryOk ? <span className="error small">This registry is not on the allowed list.</span> : null}
      </label>
      <label>Size
        <select name="size" defaultValue={sizes.includes("small") ? "small" : sizes[0]}>
          {sizes.map((size) => <option key={size}>{size}</option>)}
        </select>
      </label>
      <Rows legend="Environment variables" rows={env} onChange={setEnv} secret={false} />
      <Rows legend="Secret environment variables (write-only, never shown again)" rows={secrets} onChange={setSecrets} secret />
      <Message error={error} />
      <button type="submit" disabled={busy}>{busy ? "Deploying…" : "Deploy"}</button>
    </form>
  );
}

function Rows({ legend, rows, onChange, secret }: { legend: string; rows: Row[]; onChange: (rows: Row[]) => void; secret: boolean }) {
  const set = (index: number, patch: Partial<Row>) => onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <fieldset>
      <legend>{legend}</legend>
      {rows.map((row, index) => (
        <div className="row" key={index}>
          <label className="grow">Name<input value={row.key} onChange={(e) => set(index, { key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })} /></label>
          <label className="grow">Value<input type={secret ? "password" : "text"} autoComplete="off" value={row.value} onChange={(e) => set(index, { value: e.target.value })} /></label>
          <button type="button" onClick={() => onChange(rows.filter((_, i) => i !== index))} aria-label={`Remove ${row.key || "row"}`}>Remove</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, { key: "", value: "" }])}>Add {secret ? "secret" : "variable"}</button>
    </fieldset>
  );
}
