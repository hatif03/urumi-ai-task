import { useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { Message, useAction } from "../ui.tsx";

export function Account() {
  const { busy, error, setError, run } = useAction();
  const [ok, setOk] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setOk("");
    if (data.get("next") !== data.get("confirm")) return setError("the new passwords do not match");
    const done = await run(() => api.changePassword(String(data.get("current")), String(data.get("next"))));
    if (done) {
      form.reset();
      setOk("Password changed.");
    }
  }

  return (
    <section className="narrow">
      <h1>Account</h1>
      <form onSubmit={submit} aria-label="Change password">
        <h2>Change password</h2>
        <label>Current password<input name="current" type="password" autoComplete="current-password" required /></label>
        <label>New password (8 characters or more)<input name="next" type="password" autoComplete="new-password" minLength={8} required /></label>
        <label>Repeat new password<input name="confirm" type="password" autoComplete="new-password" minLength={8} required /></label>
        <Message error={error} ok={ok} />
        <button type="submit" disabled={busy}>Change password</button>
      </form>
    </section>
  );
}
