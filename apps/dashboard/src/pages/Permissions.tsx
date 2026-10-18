import { useEffect, useState, type FormEvent } from "react";
import { api, type Grant, type Member, type ServerRow, type ToolRow } from "../api.ts";
import { Message, Pill, errorText, usePoll, useAction } from "../ui.tsx";

export default function Permissions() {
  const action = useAction();
  const { data, error, loading, reload } = usePoll(async () => {
    const [grants, members, servers] = await Promise.all([api.grants(), api.members(), api.servers()]);
    return { grants: grants.grants, members: members.members, servers: servers.servers };
  }, 20000);

  const userName = (id: string) => data?.members.find((m) => m.id === id)?.username ?? id.slice(0, 8);

  return (
    <section>
      <h1>Permissions</h1>
      <div className="card">
        <strong>Default rule</strong>
        <p>Members may call tools the server marks <em>read-only</em>. Admins may call everything. A tool that is not marked read-only counts as a write. A tool a caller may not use is hidden from their tool list, and calling it directly is rejected and recorded in the audit log.</p>
        <p className="muted small">Rules below override the default. The most specific rule wins: a user rule beats a role rule, a tool rule beats a server rule beats an all-servers rule. At equal specificity, deny beats allow.</p>
      </div>

      <Message error={action.error || (error ? errorText(error) : "")} />
      {loading ? <p aria-busy="true">Loading…</p> : null}
      {data && !data.grants.length ? <p>No custom rules. The default rule applies.</p> : null}
      {data?.grants.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr">Permission rules</caption>
            <thead><tr><th>Who</th><th>Server</th><th>Tool</th><th>Effect</th><th><span className="sr">Actions</span></th></tr></thead>
            <tbody>
              {data.grants.map((grant) => (
                <tr key={grant.id}>
                  <td>{grant.subjectType === "role" ? <>role <strong>{grant.subject}</strong></> : <>user <strong>{userName(grant.subject)}</strong></>}</td>
                  <td>{grant.serverSlug === "*" ? "all servers" : <code>{grant.serverSlug}</code>}</td>
                  <td>{grant.toolName === "*" ? "all tools" : <code>{grant.toolName}</code>}</td>
                  <td><Pill kind={grant.effect === "allow" ? "connected" : "unreachable"}>{grant.effect}</Pill></td>
                  <td><button type="button" className="danger" onClick={() => action.run(() => api.deleteGrant(grant.id)).then(reload)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {data ? <RuleForm members={data.members} servers={data.servers} onSaved={() => void reload()} /> : null}
    </section>
  );
}

function RuleForm({ members, servers, onSaved }: { members: Member[]; servers: ServerRow[]; onSaved: () => void }) {
  const [subjectType, setSubjectType] = useState<Grant["subjectType"]>("role");
  const [serverSlug, setServerSlug] = useState("*");
  const [tools, setTools] = useState<ToolRow[]>([]);
  const { busy, error, run } = useAction();

  // A tool rule needs a server; the tool list follows the chosen server.
  useEffect(() => {
    setTools([]);
    const server = servers.find((s) => s.slug === serverSlug);
    if (!server) return;
    const ctl = new AbortController();
    api.serverTools(server.id, ctl.signal).then((r) => setTools(r.tools)).catch(() => undefined);
    return () => ctl.abort();
  }, [serverSlug, servers]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const d = new FormData(event.currentTarget);
    const done = await run(() => api.putGrant({
      subjectType,
      subject: String(d.get("subject")),
      serverSlug,
      toolName: serverSlug === "*" ? "*" : String(d.get("tool") || "*"),
      effect: d.get("effect") as Grant["effect"],
    }));
    if (done) onSaved();
  }

  return (
    <form onSubmit={submit} aria-label="Add a rule">
      <h2>Add a rule</h2>
      <div className="row">
        <label>Applies to
          <select value={subjectType} onChange={(e) => setSubjectType(e.target.value as Grant["subjectType"])}>
            <option value="role">a role</option>
            <option value="user">one user</option>
          </select>
        </label>
        <label>{subjectType === "role" ? "Role" : "User"}
          <select name="subject" key={subjectType} required>
            {subjectType === "role"
              ? <><option value="member">member</option><option value="admin">admin</option></>
              : members.map((m) => <option key={m.id} value={m.id}>{m.username} ({m.role})</option>)}
          </select>
        </label>
        <label>Server
          <select value={serverSlug} onChange={(e) => setServerSlug(e.target.value)}>
            <option value="*">all servers</option>
            {servers.map((s) => <option key={s.id} value={s.slug}>{s.displayName} ({s.slug})</option>)}
          </select>
        </label>
        <label>Tool
          <select name="tool" disabled={serverSlug === "*"} key={serverSlug}>
            <option value="*">all tools</option>
            {tools.map((t) => <option key={t.upstreamName} value={t.upstreamName}>{t.upstreamName}{t.readOnly ? " (read-only)" : ""}</option>)}
          </select>
        </label>
      </div>
      <fieldset className="row">
        <legend>Effect</legend>
        <label className="check"><input type="radio" name="effect" value="allow" defaultChecked /> Allow</label>
        <label className="check"><input type="radio" name="effect" value="deny" /> Deny</label>
      </fieldset>
      <Message error={error} />
      <button type="submit" disabled={busy}>Save rule</button>
    </form>
  );
}
