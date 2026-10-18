import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type SessionUser } from "../api.ts";
import { Message, errorText } from "../ui.tsx";

// Only a same-origin path is accepted. "//host" and "/\host" are protocol-relative and would send
// the user (and the fresh session) to another site; anything with a scheme fails the "/" test.
export function safeNext(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || /[\u0000-\u001f]/.test(value)) return null;
  return value;
}

export function Login({ onUser }: { onUser: (user: SessionUser) => void }) {
  const [params] = useSearchParams();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const body = await api.login(String(data.get("username")), String(data.get("password")));
      const next = safeNext(params.get("next"));
      // /oauth/authorize is served by the gateway, not by this SPA, so it needs a real page load.
      if (next) window.location.assign(next);
      else onUser(body.user);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <main className="narrow">
      <h1>Urumi</h1>
      <form onSubmit={submit} aria-label="Sign in">
        <label>Username<input name="username" autoComplete="username" required autoFocus /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        <Message error={error} />
        <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </main>
  );
}
