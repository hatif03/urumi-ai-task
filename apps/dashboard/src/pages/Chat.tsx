import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api } from "../api.ts";
import { Message, errorText } from "../ui.tsx";

type ToolTrace = { id: string; name: string; input?: unknown; output?: unknown; state: "running" | "ok" | "failed"; note?: string };
type Msg = { id: string; role: "user" | "assistant"; text: string; tools: ToolTrace[] };

// Versioned key: a future shape change bumps the number instead of crashing on old data.
const STORE_KEY = "urumi.chat.v1";

function readHistory(): Msg[] {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeHistory(messages: Msg[]) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-60)));
  } catch {
    // storage full or blocked: the chat still works, it just will not survive a reload
  }
}

// The gateway's tool names are server__tool. Through the search surface the real tool is inside call_tool.
function describeTool(trace: ToolTrace): { server: string; tool: string } {
  const full = trace.name === "call_tool" && trace.input && typeof (trace.input as { name?: unknown }).name === "string" ? String((trace.input as { name: string }).name) : trace.name;
  const at = full.indexOf("__");
  return at > 0 ? { server: full.slice(0, at), tool: full.slice(at + 2) } : { server: "gateway", tool: full };
}

const failed = (output: unknown) => Boolean(output && typeof output === "object" && "error" in (output as object));

export function Chat() {
  const [messages, setMessages] = useState<Msg[]>(readHistory);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [llm, setLlm] = useState(true);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => { api.status().then((s) => setLlm(s.llmConfigured)).catch(() => undefined); }, []);
  useEffect(() => () => abort.current?.abort(), []);
  // Write once a reply finishes, not on every streamed token.
  useEffect(() => { if (!streaming) writeHistory(messages); }, [messages, streaming]);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function onScroll() {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  async function send(text: string) {
    const user: Msg = { id: crypto.randomUUID(), role: "user", text, tools: [] };
    let current: Msg = { id: crypto.randomUUID(), role: "assistant", text: "", tools: [] };
    const history = [...messages, user];
    setMessages([...history, current]);
    setError("");
    stick.current = true;
    const ctl = new AbortController();
    abort.current = ctl;
    setStreaming(true);
    const push = (next: Msg) => {
      current = next;
      setMessages((prev) => prev.map((m) => (m.id === next.id ? next : m)));
    };
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        credentials: "include",
        signal: ctl.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history.map((m) => ({ id: m.id, role: m.role, parts: [{ type: "text", text: m.text }] })) }),
      });
      if (response.status === 401) return window.location.assign("/login");
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (response.status === 503) setLlm(false);
        setError(response.status === 429 ? body.error ?? "Too many messages, wait a minute." : response.status === 503 ? "No LLM key is configured. MCP at /mcp still works." : body.error ?? `Chat failed (${response.status})`);
        setMessages(history);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let event: { type?: string; delta?: string; toolCallId?: string; toolName?: string; input?: unknown; output?: unknown; errorText?: string };
          try { event = JSON.parse(payload); } catch { continue; }
          if (event.type === "text-delta" && event.delta) push({ ...current, text: current.text + event.delta });
          else if (event.type === "tool-input-available" && event.toolCallId) push({ ...current, tools: [...current.tools, { id: event.toolCallId, name: event.toolName ?? "tool", input: event.input, state: "running" }] });
          else if (event.type === "tool-output-available" || event.type === "tool-output-error") {
            const bad = event.type === "tool-output-error" || failed(event.output);
            push({ ...current, tools: current.tools.map((t) => (t.id === event.toolCallId ? { ...t, output: event.output, state: bad ? "failed" : "ok", note: event.errorText } : t)) });
          } else if (event.type === "error") setError(event.errorText ?? "The model reported an error.");
        }
      }
    } catch (err) {
      if (ctl.signal.aborted) push({ ...current, tools: current.tools.map((t) => (t.state === "running" ? { ...t, state: "failed", note: "stopped" } : t)) });
      else setError(errorText(err));
    } finally {
      setStreaming(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const text = String(new FormData(form).get("message") ?? "").trim();
    if (!text || streaming) return;
    form.reset();
    void send(text);
  }

  function keydown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <section>
      <div className="row between">
        <h1>Chat</h1>
        <button type="button" disabled={streaming || !messages.length} onClick={() => { setMessages([]); setError(""); }}>New chat</button>
      </div>
      <p className="muted small">The agent calls tools through the gateway as you. Every call shows below and appears in the audit log under your name.</p>
      {llm ? null : <p className="error" role="status">No LLM key is configured. External MCP clients can still use /mcp.</p>}
      <div className="chat-log" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-label="Conversation" tabIndex={0}>
        {!messages.length ? <p className="muted">Try: “What orders came in today?” or “Create a product called Mug for 12.50.”</p> : null}
        {messages.map((message) => (
          <article key={message.id} className={`bubble ${message.role}`}>
            <strong>{message.role === "user" ? "You" : "Agent"}</strong>
            {message.text ? <p className="chat-text">{message.text}</p> : null}
            {message.tools.map((trace) => {
              const { server, tool } = describeTool(trace);
              return (
                <details key={trace.id} className={`trace ${trace.state}`}>
                  <summary>
                    <span className="tag">{server}</span> <code>{tool}</code>{" "}
                    <span className={`pill ${trace.state === "ok" ? "connected" : trace.state === "failed" ? "unreachable" : "disabled"}`}>{trace.state === "ok" ? "ok" : trace.state === "failed" ? "failed" : "running"}</span>
                  </summary>
                  <div className="small muted">Arguments</div>
                  <pre>{JSON.stringify(trace.input ?? {}, null, 2)}</pre>
                  {trace.output !== undefined ? <><div className="small muted">Result</div><pre>{typeof trace.output === "string" ? trace.output : JSON.stringify(trace.output, null, 2)}</pre></> : null}
                  {trace.note ? <p className="error small">{trace.note}</p> : null}
                </details>
              );
            })}
            {message.role === "assistant" && streaming && message === messages[messages.length - 1] && !message.text && !message.tools.length ? <p className="muted" aria-busy="true">Thinking…</p> : null}
          </article>
        ))}
      </div>
      <Message error={error} />
      <form onSubmit={submit} aria-label="Send a message">
        <label>Message
          <textarea name="message" rows={3} required onKeyDown={keydown} placeholder="Enter to send, Shift+Enter for a new line" disabled={!llm} />
        </label>
        <div className="row">
          <button type="submit" disabled={streaming || !llm}>Send</button>
          {streaming ? <button type="button" onClick={() => abort.current?.abort()}>Stop</button> : null}
        </div>
      </form>
    </section>
  );
}
