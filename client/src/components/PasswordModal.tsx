/**
 * Not a mutation over the `["data"]` cache: it writes no row, so there is
 * nothing to patch or roll back. It leaves the header's save indicator alone
 * and states the outcome in full in the dialog.
 */
import { useEffect, useState, type FormEvent } from "react";
import { changePassword, UnauthorizedError } from "../api/client";

type Msg = { text: string; tone: "good" | "bad" | "" } | null;

export default function PasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Mounts per opening, so the fields never reopen holding a password.
  if (!open) return null;
  return <PasswordDialog onClose={onClose} />;
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: FormEvent) {
    e.preventDefault();

    // Checked here as well as on the server, so the common typos answer
    // instantly and without sending the password anywhere.
    if (!current) return setMsg({ text: "Enter your current password.", tone: "bad" });
    if (next.length < 12) {
      return setMsg({ text: "Your new password needs to be at least 12 characters.", tone: "bad" });
    }
    if (next !== confirm) return setMsg({ text: "Those two new passwords don’t match.", tone: "bad" });

    setBusy(true);
    setMsg({ text: "Changing…", tone: "" });
    try {
      const r = await changePassword(current, next, signOutOthers);
      let note = "Password changed.";
      if (signOutOthers) {
        note +=
          r.signedOut === 1
            ? " One other browser was signed out."
            : r.signedOut > 0
              ? ` ${r.signedOut} other browsers were signed out.`
              : " No other browsers were signed in.";
      }
      setMsg({ text: note, tone: "good" });
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (err) {
      // A 401 has already forgotten the session and shown the gate, so saying
      // anything here would be writing into a dialog nobody can see.
      if (err instanceof UnauthorizedError) return;
      setMsg({ text: err instanceof Error ? err.message : String(err), tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pwTitle"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form className="card modal-card wide" onSubmit={submit}>
        <h3 id="pwTitle">Change your password</h3>

        <div className="pw-field">
          <label htmlFor="pwCurrent">Current password</label>
          <input
            id="pwCurrent"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <div className="pw-field">
          <label htmlFor="pwNew">New password</label>
          <input
            id="pwNew"
            type="password"
            autoComplete="new-password"
            placeholder="12 characters or more"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </div>
        <div className="pw-field">
          <label htmlFor="pwConfirm">Confirm new password</label>
          <input
            id="pwConfirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>

        <label className="pw-check">
          <input
            type="checkbox"
            checked={signOutOthers}
            onChange={(e) => setSignOutOthers(e.target.checked)}
          />
          <span>Sign out my other browsers. This one stays signed in.</span>
        </label>

        {/* Always rendered, so the first message doesn't push the buttons down. */}
        <div className={`pw-msg ${msg?.tone ?? ""}`} role="alert">
          {msg?.text}
        </div>

        <div className="modal-actions">
          <button className="btn" type="button" onClick={onClose}>
            {done ? "Close" : "Cancel"}
          </button>
          <button className="btn primary" type="submit" disabled={busy || done}>
            Change it
          </button>
        </div>
      </form>
    </div>
  );
}
