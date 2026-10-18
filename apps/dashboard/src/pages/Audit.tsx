import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, type AuditEntry } from "../api.ts";
import { CopyButton, Message, Pill, errorText, fmtTime, relativeTime } from "../ui.tsx";

const OUTCOMES = ["success", "error", "timeout", "unreachable", "denied", "unauthorized"];
const PAGE = 100;
const pillFor = (outcome: string) => (outcome === "success" ? "connected" : outcome === "denied" || outcome === "unauthorized" ? "disabled" : "unreachable");

type Filters = { user: string; server: string; tool: string; outcome: string; from: string; to: string };
const empty: Filters = { user: "", server: "", tool: "", outcome: "", from: "", to: "" };

function queryFor(filters: Filters, beforeId?: number): URLSearchParams {
  const q = new URLSearchParams({ limit: String(PAGE) });
  for (const key of ["user", "server", "tool", "outcome"] as const) if (filters[key]) q.set(key, filters[key]);
  // datetime-local has no zone; the browser's zone is what the admin means.
  if (filters.from) q.set("from", new Date(filters.from).toISOString());
  if (filters.to) q.set("to", new Date(filters.to).toISOString());
  if (beforeId) q.set("beforeId", String(beforeId));
  return q;
}

export default function Audit() {
  const [draft, setDraft] = useState<Filters>(empty);
  const [applied, setApplied] = useState<Filters>(empty);
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [servers, setServers] = useState<string[]>([]);
  const ctl = useRef<AbortController | null>(null);

  const loadFirst = useCallback(async () => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    try {
      const result = await api.audit(queryFor(applied), c.signal);
      if (c.signal.aborted) return;
      setRows(result.audit);
      setNext(result.nextBeforeId);
      setError("");
    } catch (err) {
      if (!c.signal.aborted) setError(errorText(err));
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, [applied]);

  useEffect(() => {
    void loadFirst();
    // Auto refresh re-reads the newest page; paging back resets, which is the honest behaviour for a live log.
    if (!auto) return () => ctl.current?.abort();
    const timer = setInterval(() => { if (!document.hidden) void loadFirst(); }, 5000);
    return () => { clearInterval(timer); ctl.current?.abort(); };
  }, [loadFirst, auto]);

  useEffect(() => { api.servers().then((r) => setServers(r.servers.map((s) => s.slug))).catch(() => undefined); }, []);

  async function more() {
    if (!next) return;
    try {
      const result = await api.audit(queryFor(applied, next));
      setRows((prev) => [...prev, ...result.audit]);
      setNext(result.nextBeforeId);
    } catch (err) {
      setError(errorText(err));
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setApplied(draft);
  }

  const set = (key: keyof Filters) => (e: { target: { value: string } }) => setDraft((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <section>
      <h1>Audit log</h1>
      <form onSubmit={submit} aria-label="Filter the audit log">
        <div className="row">
          <label className="grow">User<input value={draft.user} onChange={set("user")} placeholder="username" /></label>
          <label className="grow">Server<input value={draft.server} onChange={set("server")} list="audit-servers" placeholder="slug" /></label>
          <datalist id="audit-servers">{servers.map((s) => <option key={s} value={s} />)}</datalist>
          <label className="grow">Tool<input value={draft.tool} onChange={set("tool")} placeholder="list_orders" /></label>
          <label>Outcome
            <select value={draft.outcome} onChange={set("outcome")}>
              <option value="">any</option>
              {OUTCOMES.map((o) => <option key={o}>{o}</option>)}
            </select>
          </label>
        </div>
        <div className="row">
          <label>From<input type="datetime-local" value={draft.from} onChange={set("from")} /></label>
          <label>To<input type="datetime-local" value={draft.to} onChange={set("to")} /></label>
        </div>
        <div className="row">
          <button type="submit">Apply filters</button>
          <button type="button" onClick={() => { setDraft(empty); setApplied(empty); }}>Clear</button>
          <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Refresh every 5 seconds</label>
        </div>
      </form>

      <Message error={error} />
      {loading ? <p aria-busy="true">Loading…</p> : null}
      {!loading && !rows.length ? <p>No calls match.</p> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr">Tool calls, newest first</caption>
            <thead><tr><th>When</th><th>User</th><th>Via</th><th>Server</th><th>Tool</th><th>Outcome</th><th className="num">Duration</th><th>Trace</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td title={fmtTime(row.at)}>{new Date(row.at).toLocaleTimeString()}<div className="muted small">{relativeTime(row.at)}</div></td>
                  <td>{row.username ?? <span className="muted">unknown</span>}</td>
                  <td>{row.actor}</td>
                  <td>{row.serverSlug ? <code>{row.serverSlug}</code> : <span className="muted">—</span>}</td>
                  <td>{row.toolName ? <code>{row.toolName}</code> : <span className="muted">—</span>}</td>
                  <td><Pill kind={pillFor(row.outcome)}>{row.outcome}</Pill>{row.errorCode && row.errorCode !== row.outcome ? <div className="muted small">{row.errorCode}</div> : null}</td>
                  <td className="num">{row.durationMs === null ? "—" : `${Math.round(row.durationMs)} ms`}</td>
                  <td><span className="trace-id" title={row.traceId}>{row.traceId.slice(0, 8)}…</span> <CopyButton text={row.traceId} label="Copy" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {next ? <button type="button" onClick={more}>Load more</button> : null}
    </section>
  );
}
