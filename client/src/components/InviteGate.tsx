/**
 * The sign-in card in signup mode, reached from an invite link. It checks the
 * code before drawing the form, so a used or expired link says so on arrival
 * rather than after a name and two passwords.
 */
import { useEffect, useState, type FormEvent } from "react";
import { checkInvite, failureOf, signup } from "../api/client";
import { inviteNotice, MAX_NAME, MIN_PASSWORD } from "../domain/onboarding";

type Problems = { name?: string; password?: string; confirm?: string; form?: string };

function PasswordField({
  label,
  value,
  onChange,
  problem,
  autoComplete,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  problem?: string;
  autoComplete: string;
  hint?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="gate-field">
      <div className="pw-input">
        <input
          type={shown ? "text" : "password"}
          placeholder={label}
          aria-label={label}
          aria-invalid={problem ? true : undefined}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="pw-show"
          aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={shown}
          onClick={() => setShown(!shown)}
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
      {problem && <p className="field-err">{problem}</p>}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

export default function InviteGate({
  code,
  onSignedUp,
  onUnusable,
}: {
  code: string;
  onSignedUp: () => void;
  /** The invite can't make an account; the notice says why. */
  onUnusable: (notice: string) => void;
}) {
  const [checked, setChecked] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problems, setProblems] = useState<Problems>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    checkInvite(code)
      .then((r) => {
        if (!live) return;
        if (r.valid) setChecked(true);
        else onUnusable(inviteNotice(r.reason));
      })
      .catch((err: unknown) => {
        if (live) onUnusable(`Couldn't reach the server to check that invite: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      live = false;
    };
  }, [code, onUnusable]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found: Problems = {};
    if (!name.trim()) found.name = "Pick a name — it's what you'll sign in with.";
    else if (name.trim().length > MAX_NAME) found.name = `Use ${MAX_NAME} characters or fewer.`;
    if (password.length < MIN_PASSWORD) found.password = `Use at least ${MIN_PASSWORD} characters.`;
    else if (password !== confirm) found.confirm = "Those two passwords don't match.";
    setProblems(found);
    if (Object.keys(found).length) return;

    setBusy(true);
    try {
      await signup(code, name.trim(), password);
      setPassword("");
      setConfirm("");
      onSignedUp();
    } catch (err) {
      const failure = failureOf(err);
      if (failure?.reason) {
        onUnusable(inviteNotice(failure.reason));
      } else if (failure?.field === "name" || failure?.field === "password") {
        setProblems({ [failure.field]: failure.message });
      } else {
        setProblems({ form: `Couldn't create that account: ${err instanceof Error ? err.message : String(err)}` });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="gate">
      <form className="card" onSubmit={submit} noValidate>
        <h1>Create your account</h1>
        <p>
          {checked
            ? "Pick a name and a password. Nobody else ever sees the password — not even whoever invited you."
            : "Checking your invite link…"}
        </p>
        {checked && (
          <>
            <div className="gate-field">
              <input
                type="text"
                placeholder="Name"
                aria-label="Name"
                aria-invalid={problems.name ? true : undefined}
                autoComplete="username"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              {problems.name && <p className="field-err">{problems.name}</p>}
            </div>
            <PasswordField
              label={`Password (${MIN_PASSWORD} characters or more)`}
              value={password}
              onChange={setPassword}
              problem={problems.password}
              autoComplete="new-password"
              hint="Forgot it later? Whoever invited you can reset it."
            />
            <PasswordField
              label="Confirm password"
              value={confirm}
              onChange={setConfirm}
              problem={problems.confirm}
              autoComplete="new-password"
            />
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? "Creating your account…" : "Create account"}
            </button>
          </>
        )}
        {problems.form && (
          <div className="err" role="alert">
            {problems.form}
          </div>
        )}
      </form>
    </div>
  );
}
