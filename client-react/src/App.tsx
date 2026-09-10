/**
 * Gate, then the tracker.
 *
 * See ../../docs/react-adoption-plan.md. Phase 3: the read-only UI. Every
 * control that would save is rendered and inert - the layout is the real
 * layout, and Phase 4 turns the controls into writes.
 */
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BrowserRouter, useLocation } from "react-router-dom";
import { getData, login, logout, session, UnauthorizedError } from "./api/client";
import Shell from "./components/Shell";
import { clearPrefs } from "./ui/prefs";

function Gate({ onSignedIn }: { onSignedIn: () => void }) {
  // Prefilled from the last sign-in on this browser - the name is remembered
  // across sign-outs, the token is not.
  const [name, setName] = useState(session.name);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
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

  return (
    <div id="gate">
      {/* A real form, so Enter submits without a keydown handler saying so. */}
      <form className="card" onSubmit={submit}>
        <h1>Job search access</h1>
        <p>Sign in to continue.</p>
        <label htmlFor="name">Name</label>
        <input id="name" autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error && (
          <div className="err" role="alert">
            {error}
          </div>
        )}
      </form>
    </div>
  );
}

function Tracker({ onSignedOut }: { onSignedOut: () => void }) {
  const location = useLocation();
  const { data, error, isPending } = useQuery({
    queryKey: ["data"],
    queryFn: getData,
    // A revoked token is not a transient failure, so retrying it just delays
    // the gate.
    retry: (count, err) => !(err instanceof UnauthorizedError) && count < 2,
  });

  if (isPending) {
    return (
      <div className="wrap">
        <p style={{ padding: "40px 0", color: "var(--ink2)" }}>Loading…</p>
      </div>
    );
  }

  if (error) {
    if (error instanceof UnauthorizedError) {
      onSignedOut();
      return null;
    }
    return (
      <div className="wrap">
        <div className="err" role="alert" style={{ padding: "40px 0" }}>
          {error.message}
        </div>
      </div>
    );
  }

  // Only the Overview pins its header and tiles and scrolls the rest; the other
  // tabs scroll as documents, with their own list panes capped inside the
  // master/detail card.
  return <Shell data={data} isOverview={location.pathname === "/"} onSignOut={onSignedOut} />;
}

function Root() {
  const [signedIn, setSignedIn] = useState(() => !!session.token());
  const queryClient = useQueryClient();

  if (!signedIn) {
    return (
      <Gate
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
      onSignedOut={() => {
        void logout();
        queryClient.clear();
        // Clears the per-browser view state with the session, so the next person
        // to sign in on this browser does not land on someone else's tab.
        clearPrefs();
        setSignedIn(false);
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
