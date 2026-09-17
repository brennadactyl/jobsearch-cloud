/**
 * The account panel, opened from "My account" in the header: who is signed in,
 * then one section per thing a person can change about their own account.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { changePassword, UnauthorizedError } from "../api/client";
import type { Track } from "../api/schema";
import { MIN_PASSWORD } from "../domain/account";
import ResumeSection, { type Unsaved } from "./ResumeSection";

type Props = { open: boolean; name: string; tracks: readonly Track[]; onClose: () => void };

export default function AccountPanel({ open, ...props }: Props) {
  // Mounts per opening, so nothing typed or chosen in one visit is still there in the next.
  if (!open) return null;
  return <AccountDialog {...props} />;
}

function AccountDialog({ name, tracks, onClose }: Omit<Props, "open">) {
  const [unsaved, setUnsaved] = useState<Unsaved | null>(null);
  const [asking, setAsking] = useState(false);
  const onUnsaved = useCallback((u: Unsaved | null) => setUnsaved(u), []);

  // Every way out comes through here, so unsaved choices are never lost without asking.
  const leave = useCallback(() => {
    if (unsaved) setAsking(true);
    else onClose();
  }, [unsaved, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (asking) setAsking(false);
      else leave();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [asking, leave]);

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) leave();
      }}
    >
      <div className="card account-panel" role="dialog" aria-modal="true" aria-labelledby="accountTitle">
        <div className="account-head">
          <div>
            <h3 id="accountTitle">My account</h3>
            <div className="account-who">Signed in as {name}</div>
          </div>
          <button className="btn ghost account-close" type="button" aria-label="Close" onClick={leave}>
            ✕
          </button>
        </div>
        <div className="account-body" data-wheel-target>
          <PasswordSection />
          <ResumeSection tracks={tracks} onUnsaved={onUnsaved} />
        </div>
      </div>
      {asking && unsaved && (
        <div className="modal-overlay">
          <div className="card modal-card wide" role="alertdialog" aria-modal="true" aria-labelledby="leaveTitle">
            <h3 id="leaveTitle">Leave without saving?</h3>
            <p>{unsaved.sentence}</p>
            <div className="modal-actions">
              <button className="btn" type="button" onClick={onClose}>
                {unsaved.count === 1 ? "Discard change" : "Discard changes"}
              </button>
              <button className="btn primary" type="button" autoFocus onClick={() => setAsking(false)}>
                Keep editing
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PasswordSection() {
  const [changing, setChanging] = useState(false);
  return (
    <section className="account-section" aria-labelledby="pwTitle">
      <div className="account-section-row">
        <div>
          <h4 id="pwTitle">Password</h4>
          <p>The one you sign in with</p>
        </div>
        {!changing && (
          <button className="btn" type="button" onClick={() => setChanging(true)}>
            Change password
          </button>
        )}
      </div>
      {/* Mounts per change, so the fields never reopen holding a password. */}
      {changing && <PasswordForm onDone={() => setChanging(false)} />}
    </section>
  );
}

type Msg = { text: string; tone: "good" | "bad" | "" } | null;

/**
 * Not a mutation over the `["data"]` cache: it writes no row, so there is
 * nothing to patch or roll back. It leaves the header's save indicator alone
 * and states the outcome in full beside the form.
 */
function PasswordForm({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();

    // Checked here as well as on the server, so the common typos answer
    // instantly and without sending the password anywhere.
    if (!current) return setMsg({ text: "Enter your current password.", tone: "bad" });
    if (next.length < MIN_PASSWORD) {
      return setMsg({ text: `Your new password needs to be at least ${MIN_PASSWORD} characters.`, tone: "bad" });
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
      // anything here would be writing into a panel nobody can see.
      if (err instanceof UnauthorizedError) return;
      setMsg({ text: err instanceof Error ? err.message : String(err), tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="account-form" onSubmit={submit}>
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
          placeholder={`${MIN_PASSWORD} characters or more`}
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
        <input type="checkbox" checked={signOutOthers} onChange={(e) => setSignOutOthers(e.target.checked)} />
        <span>Sign out my other browsers. This one stays signed in.</span>
      </label>

      {/* Always rendered, so the first message doesn't push the buttons down. */}
      <div className={`pw-msg ${msg?.tone ?? ""}`} role="alert">
        {msg?.text}
      </div>

      <div className="modal-actions">
        <button className="btn" type="button" onClick={onDone}>
          {done ? "Close" : "Cancel"}
        </button>
        <button className="btn primary" type="submit" disabled={busy || done}>
          Change it
        </button>
      </div>
    </form>
  );
}
