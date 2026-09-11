import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { getData, login, logout, session, UnauthorizedError } from "./api/client";
import Shell from "./components/Shell";
import { clearPrefs } from "./ui/prefs";
import { saved } from "./ui/saved";

interface GateState {
  /** Why you are here - an expired session, a revoke that didn't land. Empty for a plain sign-out. */
  notice: string;
  /** Straight to the password after a sign-out: the name is prefilled, so it is the one field left to type. */
  focusPassword: boolean;
}

function Gate({ notice, focusPassword, onSignedIn }: GateState & { onSignedIn: () => void }) {
  // The name outlives a sign-out; the token doesn't.
  const [name, setName] = useState(session.name);
  const [password, setPassword] = useState("");
  // Null until a sign-in is attempted, so until then the gate shows the notice
  // it was reached with - including one that arrives after it opened, which a
  // failed revoke does.
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !password) {
      setError("Enter your name and password.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await login(name.trim(), password);
      setPassword("");
      onSignedIn();
    } catch (err) {
      // A wrong name and a wrong password give the same message, as the server
      // gives the same answer - saying which was wrong tells an attacker which
      // half they have got right.
      setError(
        err instanceof UnauthorizedError || (err instanceof Error && /401|match/i.test(err.message))
          ? "That name and password don't match."
          : `Couldn't sign in: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  const message = error ?? notice;

  return (
    <div id="gate">
      <form className="card" onSubmit={submit}>
        <h1>Job search access</h1>
        <p>Sign in to continue.</p>
        {/* type="text" matters: tracker.css selects inputs by attribute. */}
        <input
          type="text"
          placeholder="Name"
          aria-label="Name"
          autoComplete="username"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="password"
          placeholder="Password"
          aria-label="Password"
          autoComplete="current-password"
          autoFocus={focusPassword}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {message && (
          <div className="err" role="alert">
            {message}
          </div>
        )}
      </form>
    </div>
  );
}

function Tracker({ onSignOut }: { onSignOut: () => void }) {
  const location = useLocation();
  const { data, error, isPending } = useQuery({
    queryKey: ["data"],
    queryFn: getData,
    // A revoked token is not a transient failure, so retrying it just delays
    // the gate.
    retry: (count, err) => !(err instanceof UnauthorizedError) && count < 2,
  });

  // request() ends the session on a 401 itself, which is what brings the gate
  // up. Ending it here as well covers a rejection that never went through
  // request(), and lands on the same gate if it did.
  useEffect(() => {
    if (error instanceof UnauthorizedError) session.end(error.message);
  }, [error]);

  if (isPending) {
    return (
      <div className="wrap">
        <p style={{ padding: "40px 0", color: "var(--ink2)" }}>Loading…</p>
      </div>
    );
  }

  if (error) {
    if (error instanceof UnauthorizedError) return null;
    return (
      <div className="wrap">
        <div className="load-err" role="alert">
          {`Couldn't load: ${error.message}`}
        </div>
      </div>
    );
  }

  return <Shell data={data} isOverview={location.pathname === "/"} onSignOut={onSignOut} />;
}

function Root() {
  const [signedIn, setSignedIn] = useState(() => !!session.token());
  const [gate, setGate] = useState<GateState>({ notice: "", focusPassword: false });
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Every way a session ends arrives here: Log out, and a 401 on any read or
  // write, so a failed write can't leave a page that looks signed in.
  useEffect(
    () =>
      session.onEnd((reason) => {
        // The next person to sign in on this browser starts clean: no cached
        // data, no view state, no tab left in the URL, and no "Saving…" from the
        // write that found the token gone.
        queryClient.clear();
        clearPrefs();
        saved.ok();
        navigate("/", { replace: true });
        setGate({ notice: reason, focusPassword: true });
        setSignedIn(false);
      }),
    [queryClient, navigate],
  );

  if (!signedIn) {
    return (
      <Gate
        {...gate}
        onSignedIn={() => {
          // The previous account's data must not survive into this one's view.
          queryClient.clear();
          setSignedIn(true);
        }}
      />
    );
  }

  return (
    <Tracker
      onSignOut={() => {
        // Ending the session signs out through the listener above. What is left
        // is whether the server heard: a revoke that didn't land leaves the
        // token live, which on a shared machine is worth saying.
        void logout().then((revoked) => {
          if (!revoked) {
            setGate((g) => ({ ...g, notice: "Signed out here, but couldn't reach the server to revoke this session." }));
          }
        });
      }}
    />
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Root />
    </BrowserRouter>
  );
}
