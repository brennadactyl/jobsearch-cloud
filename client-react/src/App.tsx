/**
 * Phase 1: the whole chain, on the smallest thing that can prove it.
 *
 * Sign in against the real API, load /api/data through the schema, and say what
 * came back. No tabs, no tables, no writes - those are Phases 3 and 4. What
 * this establishes is the part that is not worth discovering later: that the
 * token flow, the typed boundary, the query layer, the build and the deploy all
 * work end to end.
 *
 * See ../../docs/react-adoption-plan.md.
 */
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getData, login, logout, session, UnauthorizedError } from "./api/client";

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
    <main className="gate">
      {/* A real form, so Enter submits without a keydown handler saying so. */}
      <form className="card" onSubmit={submit}>
        <h1>Job search access</h1>
        <p>Sign in to continue.</p>
        <label htmlFor="name">Name</label>
        <input
          id="name"
          autoComplete="username"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
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
        {/* role="alert" so the failure is announced, not just drawn. */}
        {error && <div className="err" role="alert">{error}</div>}
      </form>
    </main>
  );
}

function Summary({ onSignedOut }: { onSignedOut: () => void }) {
  const { data, error, isPending } = useQuery({
    queryKey: ["data"],
    queryFn: getData,
    // A revoked token is not a transient failure, so retrying it just delays
    // the gate. Everything else gets the default retry.
    retry: (count, err) => !(err instanceof UnauthorizedError) && count < 2,
  });

  if (isPending) return <main className="wrap"><p>Loading…</p></main>;

  if (error) {
    if (error instanceof UnauthorizedError) {
      onSignedOut();
      return null;
    }
    return (
      <main className="wrap">
        <div className="err" role="alert">{error.message}</div>
      </main>
    );
  }

  const trackCount = data.tracks.length;
  return (
    <main className="wrap">
      <header className="hdr">
        <div>
          {/* From config, not hardcoded - the same deployed client serves every account. */}
          <h1>{data.settings.display_title}</h1>
          <p className="sub">Signed in as {data.user.name}</p>
        </div>
        <button
          className="btn"
          type="button"
          onClick={async () => {
            await logout();
            onSignedOut();
          }}
        >
          Log out
        </button>
      </header>

      {/* A list, not a <dl>. These are counts rather than term/definition
          pairs, and wrapping dt/dd in the <div> the grid layout wants costs
          them their term/definition roles - so the markup would have been
          both less accurate and less reachable. */}
      <ul className="counts">
        {[
          ["Leads", data.leads.length],
          ["Applications", data.applications.length],
          ["Screened", data.screened.length],
          ["Tracked searches", trackCount],
        ].map(([label, n]) => (
          <li key={label}>
            <span className="k">{label}</span>
            <span className="v">{n}</span>
          </li>
        ))}
      </ul>

      {trackCount > 0 && (
        <ul className="tracks">
          {data.tracks.map((t) => (
            <li key={t.key}>
              <strong>{t.label}</strong>
              <span>
                {t.last_run.at
                  ? `last run ${t.last_run.on || t.last_run.at}${
                      t.last_run.status === "error" ? " — reported an error" : ""
                    }`
                  : "no run recorded yet"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="note">
        Phase 1 of <code>docs/react-adoption-plan.md</code>. The page this replaces is still
        the one to use.
      </p>
    </main>
  );
}

export default function App() {
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
  return <Summary onSignedOut={() => { queryClient.clear(); setSignedIn(false); }} />;
}
