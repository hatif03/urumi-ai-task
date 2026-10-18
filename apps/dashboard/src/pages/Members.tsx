import { useState, type FormEvent } from "react";
import { api, type Member, type Role, type SessionUser } from "../api.ts";
import { Confirm, Message, Modal, Pill, errorText, fmtTime, relativeTime, usePoll, useAction } from "../ui.tsx";

export default function Members({ self }: { self: SessionUser }) {
  const [resetting, setResetting] = useState<Member | null>(null);
  const [revoking, setRevoking] = useState<{ member: Member; keyId: string; prefix: string } | null>(null);
  const action = useAction();
  const { data, error, loading, reload } = usePoll(() => api.members().then((r) => r.members), 15000);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const d = new FormData(form);
    const done = await action.run(() => api.createMember(String(d.get("username")), String(d.get("password")), d.get("role") as Role));
    if (done) {
      form.reset();
      void reload();
    }
  }

  const patch = (member: Member, body: { disabled?: boolean; role?: Role }) => action.run(() => api.patchMember(member.id, body)).then(reload);

  return (
    <section>
      <h1>Members</h1>
      <form onSubmit={create} aria-label="Invite a member">
        <h2>Invite a member</h2>
        <p className="muted small">Create the account and share the password out of band. They can generate their own API key after signing in.</p>
        <div className="row">
          <label className="grow">Username<input name="username" required pattern="[A-Za-z0-9._\-]{2,40}" title="2-40 letters, digits, dot, dash or underscore" autoComplete="off" /></label>
          <label className="grow">Password<input name="password" type="password" minLength={8} required autoComplete="new-password" /></label>
          <label>Role
            <select name="role" defaultValue="member"><option value="member">member</option><option value="admin">admin</option></select>
          </label>
        </div>
        <button type="submit" disabled={action.busy}>Create account</button>
      </form>
      <Message error={action.error || (error ? errorText(error) : "")} />
      {loading ? <p aria-busy="true">Loading…</p> : null}
      <div className="table-wrap">
        <table>
          <caption className="sr">Members</caption>
          <thead><tr><th>User</th><th>Role</th><th>Status</th><th>API keys</th><th><span className="sr">Actions</span></th></tr></thead>
          <tbody>
            {data?.map((member) => (
              <tr key={member.id}>
                <td>{member.username}{member.id === self.id ? <span className="muted"> (you)</span> : null}<div className="muted small">since {fmtTime(member.createdAt)}</div></td>
                <td>
                  <label className="inline"><span className="sr">Role of {member.username}</span>
                    <select value={member.role} onChange={(e) => patch(member, { role: e.target.value as Role })}>
                      <option value="member">member</option><option value="admin">admin</option>
                    </select>
                  </label>
                </td>
                <td><Pill kind={member.disabledAt ? "disabled" : "connected"}>{member.disabledAt ? "disabled" : "active"}</Pill></td>
                <td>
                  {member.keys.length ? (
                    <ul className="plain">
                      {member.keys.map((key) => (
                        <li key={key.id}>
                          <code>{key.prefix}…</code> {key.label}{" "}
                          {key.revokedAt ? <span className="muted">revoked</span> : (
                            <>
                              <span className="muted small">used {key.lastUsedAt ? relativeTime(key.lastUsedAt) : "never"}</span>{" "}
                              <button type="button" className="danger small" onClick={() => setRevoking({ member, keyId: key.id, prefix: key.prefix })}>Revoke</button>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : <span className="muted">none</span>}
                </td>
                <td>
                  <div className="row">
                    <button type="button" onClick={() => patch(member, { disabled: !member.disabledAt })}>{member.disabledAt ? "Enable" : "Disable"}</button>
                    <button type="button" onClick={() => setResetting(member)}>Reset password</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={resetting !== null} title={`Reset password for ${resetting?.username ?? ""}`} onClose={() => setResetting(null)}>
        {resetting ? <ResetForm member={resetting} onDone={() => setResetting(null)} /> : null}
      </Modal>
      <Confirm
        open={revoking !== null}
        title="Revoke key"
        confirmLabel="Revoke"
        message={revoking ? <>Revoke <code>{revoking.prefix}…</code> belonging to <strong>{revoking.member.username}</strong>? Their next call with it is rejected.</> : null}
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          const target = revoking;
          setRevoking(null);
          if (target) await action.run(() => api.revokeKey(target.keyId));
          void reload();
        }}
      />
    </section>
  );
}

function ResetForm({ member, onDone }: { member: Member; onDone: () => void }) {
  const { busy, error, run } = useAction();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password"));
    if (await run(() => api.resetPassword(member.id, password))) onDone();
  }
  return (
    <form onSubmit={submit}>
      <label>New password (8 characters or more)<input name="password" type="password" minLength={8} required autoComplete="new-password" autoFocus /></label>
      <Message error={error} />
      <div className="row">
        <button type="submit" disabled={busy}>Set password</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
