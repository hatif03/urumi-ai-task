import { Component, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";

// ---- time ------------------------------------------------------------------------------------

const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function fmtTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "never";
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return relativeFormat.format(seconds, "second");
  if (abs < 3600) return relativeFormat.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return relativeFormat.format(Math.round(seconds / 3600), "hour");
  return relativeFormat.format(Math.round(seconds / 86400), "day");
}

// ---- small helpers ---------------------------------------------------------------------------

export const errorText = (error: unknown) => (error instanceof Error ? error.message : "something went wrong");

// Slug rule shared with the gateway: lowercase words joined by single underscores, 2-32 characters.
export const toSlug = (value: string, separator = "_") => {
  const joined = value.toLowerCase().replace(/[^a-z0-9]+/g, separator);
  // An empty separator (store slugs have none) has nothing to trim, and `^+` is not a valid pattern.
  const trimmed = separator ? joined.replace(new RegExp(`^(?:${separator})+|(?:${separator})+$`, "g"), "") : joined;
  return trimmed.slice(0, 32);
};

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---- polling ---------------------------------------------------------------------------------

// Loads on mount and every `ms`, skips ticks while the tab is hidden, reloads when it becomes visible,
// and aborts the request in flight on unmount. `load` is read through a ref so a new closure each
// render does not restart the timer.
export function usePoll<T>(load: (signal: AbortSignal) => Promise<T>, ms: number, enabled = true) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { loadRef.current = load; });

  const reload = useCallback(async () => {
    controller.current?.abort();
    const ctl = new AbortController();
    controller.current = ctl;
    try {
      const next = await loadRef.current(ctl.signal);
      if (ctl.signal.aborted) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (!ctl.signal.aborted) setError(err);
    } finally {
      if (!ctl.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    const timer = setInterval(() => { if (!document.hidden) void reload(); }, ms);
    const onVisible = () => { if (!document.hidden) void reload(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      controller.current?.abort();
    };
  }, [ms, enabled, reload]);

  return { data, error, loading, reload, setData };
}

// Runs an async action, tracks busy state, and reports failures as text for an aria-live region.
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (err) {
      setError(errorText(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

// ---- components ------------------------------------------------------------------------------

export function Pill({ kind, children }: { kind: string; children?: ReactNode }) {
  return <span className={`pill ${kind}`}>{children ?? kind}</span>;
}

export function Message({ error, ok }: { error?: string; ok?: string }) {
  return (
    <div role={error ? "alert" : "status"} aria-live="polite">
      {error ? <p className="error">{error}</p> : null}
      {ok ? <p className="ok">{ok}</p> : null}
    </div>
  );
}

// Native <dialog>: focus trap, Escape to close and the backdrop come from the platform.
export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="modal-title">
      {open ? (
        <div className="dialog-body">
          <h2 id="modal-title">{title}</h2>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}

export function Confirm({ open, title, message, confirmLabel = "Delete", onConfirm, onCancel }: { open: boolean; title: string; message: ReactNode; confirmLabel?: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <p>{message}</p>
      <div className="row">
        <button type="button" className="danger" onClick={onConfirm}>{confirmLabel}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </Modal>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <>
      <button
        type="button"
        onClick={async () => {
          setState((await copyText(text)) ? "done" : "failed");
          setTimeout(() => setState("idle"), 2500);
        }}
      >
        {state === "done" ? "Copied" : label}
      </button>
      <span role="status" aria-live="polite" className="error">{state === "failed" ? "Copy failed. Select the text and copy it by hand." : ""}</span>
    </>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section role="alert">
        <h1>Something broke on this page</h1>
        <p className="error">{this.state.error.message}</p>
        <button type="button" onClick={() => this.setState({ error: null })}>Try again</button>
      </section>
    );
  }
}
