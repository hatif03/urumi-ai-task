import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api, type ServerRow, type SessionUser } from "./api.ts";

export function App() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  useEffect(() => {
    api.me().then((body) => setUser(body.user)).catch(() => setUser(null));
  }, []);
  if (user === undefined) return <main>Loading…</main>;
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" /> : <Login onUser={setUser} />} />
      <Route path="/*" element={user ? <Shell user={user} onLogout={() => setUser(null)} /> : <Navigate to="/login" />} />
    </Routes>
  );
}

function Login({ onUser }: { onUser: (user: SessionUser) => void }) {
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const body = await api.login(String(data.get("username")), String(data.get("password")));
      onUser(body.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    }
  }
  return (
    <main>
      <h1>Urumi</h1>
      <form onSubmit={submit}>
        <label>Username<input name="username" autoComplete="username" required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        {error ? <p className="error">{error}</p> : null}
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}

function Shell({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const navigate = useNavigate();
  return (
    <main>
      <nav>
        <strong>Urumi</strong>
        <Link to="/">Servers</Link>
        <Link to="/chat">Chat</Link>
        <Link to="/keys">API keys</Link>
        {user.role === "admin" ? <Link to="/members">Members</Link> : null}
        {user.role === "admin" ? <Link to="/audit">Audit</Link> : null}
        <span>{user.username}</span>
        <button type="button" onClick={async () => { await api.logout(); onLogout(); navigate("/login"); }}>Log out</button>
      </nav>
      <Routes>
        <Route path="/" element={<Servers admin={user.role === "admin"} />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/keys" element={<Keys />} />
        <Route path="/members" element={user.role === "admin" ? <Members /> : <Navigate to="/" />} />
        <Route path="/audit" element={user.role === "admin" ? <Audit /> : <Navigate to="/" />} />
      </Routes>
    </main>
  );
}

function Servers({ admin }: { admin: boolean }) {
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [tools, setTools] = useState<Record<string, string[]>>({});
  const [error, setError] = useState("");
  async function load() {
    const body = await api.servers();
    setServers(body.servers);
    const next: Record<string, string[]> = {};
    for (const server of body.servers) {
      const listed = await api.serverTools(server.id);
      next[server.id] = listed.tools.map((tool) => tool.name);
    }
    setTools(next);
  }
  useEffect(() => {
    load().catch((err) => setError(err.message));
    const timer = setInterval(() => load().catch(() => undefined), 5000);
    return () => clearInterval(timer);
  }, []);
  return (
    <section>
      <h1>Servers</h1>
      {error ? <p className="error">{error}</p> : null}
      {admin ? <AddServer onCreated={load} /> : null}
      {servers.map((server) => (
        <article className="card" key={server.id}>
          <div className="row">
            <strong>{server.displayName}</strong>
            <span className={`pill ${server.status}`}>{server.status}</span>
            <span>{server.toolCount} tools</span>
          </div>
          {server.url ? <div>{server.url}</div> : null}
          {server.statusDetail ? <div>{server.statusDetail}</div> : null}
          <div>{(tools[server.id] ?? []).join(", ") || "No tools cached"}</div>
          {admin ? (
            <div className="row">
              <button type="button" onClick={() => api.updateServer(server.id, { enabled: !server.enabled }).then(load)}>
                {server.enabled ? "Disable" : "Enable"}
              </button>
              <button type="button" onClick={() => api.probe(server.id).then(load)}>Probe</button>
              <button type="button" onClick={() => api.deleteServer(server.id).then(load)}>Delete</button>
            </div>
          ) : null}
        </article>
      ))}
    </section>
  );
}

function AddServer({ onCreated }: { onCreated: () => Promise<void> }) {
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const displayName = String(data.get("displayName"));
    const slug = String(data.get("slug") || displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")).slice(0, 32);
    try {
      await api.createServer({
        displayName,
        slug,
        url: String(data.get("url")),
        credentialType: String(data.get("credentialType")),
        credentialHeaderName: String(data.get("header") || "") || undefined,
        secret: String(data.get("secret") || "") || undefined,
      });
      event.currentTarget.reset();
      setError("");
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not add server");
    }
  }
  return (
    <form onSubmit={submit}>
      <h2>Add server</h2>
      <label>Display name<input name="displayName" required /></label>
      <label>Slug<input name="slug" placeholder="auto from the name" /></label>
      <label>URL<input name="url" required placeholder="http://example.svc.cluster.local:8080/mcp" /></label>
      <label>Credential
        <select name="credentialType" defaultValue="none">
          <option value="none">None</option>
          <option value="bearer">Bearer</option>
          <option value="header">Header</option>
        </select>
      </label>
      <label>Header name<input name="header" /></label>
      <label>Secret<input name="secret" type="password" autoComplete="off" /></label>
      {error ? <p className="error">{error}</p> : null}
      <button type="submit">Save</button>
    </form>
  );
}

function Members() {
  const [members, setMembers] = useState<Array<SessionUser & { liveKey: boolean }>>([]);
  const [error, setError] = useState("");
  async function load() { setMembers((await api.members()).members); }
  useEffect(() => { load().catch((err) => setError(err.message)); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await api.createMember(String(data.get("username")), String(data.get("password")));
    event.currentTarget.reset();
    await load();
  }
  return (
    <section>
      <h1>Members</h1>
      {error ? <p className="error">{error}</p> : null}
      <form onSubmit={submit}>
        <label>Username<input name="username" required /></label>
        <label>Password<input name="password" type="password" minLength={8} required /></label>
        <button type="submit">Create member</button>
      </form>
      <table>
        <thead><tr><th>User</th><th>Role</th><th>Key</th><th></th></tr></thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.id}>
              <td>{member.username}</td>
              <td>{member.role}</td>
              <td>{member.liveKey ? "live" : "none"}</td>
              <td>{member.disabledAt ? "disabled" : <button type="button" onClick={() => api.disableMember(member.id).then(load)}>Disable</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Keys() {
  const [keys, setKeys] = useState<Array<{ id: string; prefix: string; label: string; createdAt: string; revokedAt: string | null; lastUsedAt: string | null }>>([]);
  const [token, setToken] = useState("");
  async function load() { setKeys((await api.keys()).keys); }
  useEffect(() => { load().catch(() => undefined); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const created = await api.createKey(String(data.get("label") || "default"));
    setToken(created.token);
    event.currentTarget.reset();
    await load();
  }
  return (
    <section>
      <h1>API keys</h1>
      <form onSubmit={submit}>
        <label>Label<input name="label" /></label>
        <button type="submit">Create key</button>
      </form>
      {token ? (
        <div className="card">
          <p>Copy this token now. It will not be shown again.</p>
          <code>{token}</code>
          <button type="button" onClick={() => { navigator.clipboard.writeText(token); setToken(""); }}>Copy and close</button>
        </div>
      ) : null}
      <table>
        <thead><tr><th>Prefix</th><th>Label</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id}>
              <td>{key.prefix}</td>
              <td>{key.label}</td>
              <td>{key.revokedAt ? "revoked" : "live"}</td>
              <td>{key.revokedAt ? null : <button type="button" onClick={() => api.revokeKey(key.id).then(load)}>Revoke</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Audit() {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [server, setServer] = useState("");
  const [outcome, setOutcome] = useState("");
  async function load(nextServer = server, nextOutcome = outcome) {
    const params = new URLSearchParams();
    if (nextServer) params.set("server", nextServer);
    if (nextOutcome) params.set("outcome", nextOutcome);
    const query = params.size ? `?${params}` : "";
    setRows((await api.audit(query)).audit);
  }
  useEffect(() => { load().catch(() => undefined); }, []);
  return (
    <section>
      <h1>Audit</h1>
      <form onSubmit={(event) => { event.preventDefault(); load(); }}>
        <label>Server<input value={server} onChange={(event) => setServer(event.target.value)} /></label>
        <label>Outcome<input value={outcome} onChange={(event) => setOutcome(event.target.value)} /></label>
        <button type="submit">Filter</button>
      </form>
      <table>
        <thead><tr><th>When</th><th>Actor</th><th>Server</th><th>Tool</th><th>Outcome</th><th>Trace</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              <td>{String(row.at)}</td>
              <td>{String(row.actor)}</td>
              <td>{String(row.serverSlug ?? "")}</td>
              <td>{String(row.toolName ?? "")}</td>
              <td>{String(row.outcome)}</td>
              <td>{String(row.traceId)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

type ToolTrace = { name: string; input?: unknown; ok: boolean };
type ChatMessage = { role: "user" | "assistant"; text: string; tools: ToolTrace[] };

function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [llm, setLlm] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { api.servers().then((body) => setLlm(body.llmConfigured)).catch(() => undefined); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = String(data.get("message") || "");
    if (!text) return;
    const history = [...messages, { role: "user" as const, text, tools: [] }];
    setMessages(history);
    event.currentTarget.reset();
    const response = await fetch("/api/chat", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: history.map((message) => ({ role: message.role, parts: [{ type: "text", text: message.text }] })) }),
    });
    if (response.status === 503) {
      setLlm(false);
      setError("No LLM key is configured. MCP at /mcp still works.");
      return;
    }
    if (!response.ok || !response.body) {
      setError("Chat failed");
      return;
    }
    const assistant: ChatMessage = { role: "assistant", text: "", tools: [] };
    setMessages([...history, assistant]);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        const event = JSON.parse(payload) as { type?: string; delta?: string; toolName?: string; input?: unknown; output?: unknown; error?: unknown };
        if (event.type === "text-delta" && event.delta) assistant.text += event.delta;
        if (event.type === "tool-input-available") assistant.tools.push({ name: event.toolName ?? "tool", input: event.input, ok: true });
        if (event.type === "tool-output-error") {
          const last = assistant.tools.at(-1);
          if (last) last.ok = false;
        }
        if (event.type === "tool-output-available" && event.output && typeof event.output === "object" && "error" in (event.output as object)) {
          const last = assistant.tools.at(-1);
          if (last) last.ok = false;
        }
        setMessages([...history, { ...assistant, tools: [...assistant.tools] }]);
      }
    }
  }
  return (
    <section>
      <h1>Chat</h1>
      {llm ? null : <p>No LLM key is configured. External MCP clients can still call /mcp.</p>}
      {error ? <p className="error">{error}</p> : null}
      {messages.map((message, index) => (
        <article className="card" key={index}>
          <strong>{message.role}</strong>
          <p>{message.text}</p>
          {message.tools.map((tool, toolIndex) => (
            <div className="trace" key={toolIndex}>{tool.ok ? "called" : "failed"} {tool.name} {JSON.stringify(tool.input)}</div>
          ))}
        </article>
      ))}
      <form onSubmit={submit}>
        <label>Message<textarea name="message" rows={3} required /></label>
        <button type="submit">Send</button>
      </form>
    </section>
  );
}
