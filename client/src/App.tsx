import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { getData, getIntake, login, logout, session, UnauthorizedError } from "./api/client";
import type { Intake } from "./api/schema";
import { setupOverdue } from "./domain/onboarding";
import InviteGate from "./components/InviteGate";
import Setup from "./components/Setup";
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

/**
 * What a tracker built minutes ago says about the half its first run still owes
 * it: the searches exist and the tabs work, but nothing has been looked for yet.
 * Nothing here needs the person to act - a failed run retries on its own - so
 * it is a note on their own tracker rather than a screen in front of it.
 */
function SetupNotice({ intake, staleRunHours }: { intake: Intake | null; staleRunHours: number }) {
  if (!intake || intake.status === "done") return null;
  if (intake.status === "failed") {
    return (
      <div className="setup-status bad" role="status">
        <strong>Tonight's run couldn't finish your setup</strong>
        {intake.status_note || "The run stopped before it finished writing your searches."} It tries again tonight —
        your tracker works in the meantime, and there's nothing you need to do.
      </div>
    );
  }
  // "Tonight" is only true while a night hasn't come and gone. A pending intake
  // past the account's stale window means the run that fills it in didn't
  // happen - the machine was off, or the task didn't fire - and repeating the
  // promise would renew it every day it stays false.
  if (setupOverdue(intake.sent_at, staleRunHours)) {
    return (
      <div className="setup-status" role="status">
        <strong>Finishing your setup is taking longer than it should</strong>
        The overnight run that fills in your searches hasn't run since you sent your answers — the machine that runs it
        may be switched off. Your tracker works in the meantime; if this stays here another day, let whoever invited
        you know.
      </div>
    );
  }
  return (
    <div className="setup-status" role="status">
      <strong>Your searches are set up — tonight's run fills in the rest</strong>
      It reads your resume, writes how each search describes what you want, and starts looking. The first morning may
      well be empty: an empty day is a real result here, and nothing gets padded in.
    </div>
  );
}

function Tracker({ onSignOut }: { onSignOut: () => void }) {
  const location = useLocation();
  const queryClient = useQueryClient();
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

  // An account with no tracks hasn't sent its setup answers: sending builds the
  // tracks, in the same write as the intake row. So no tracks means the form,
  // and the answers having been sent means the tracker - including the night
  // the run has yet to finish, which the notice covers. A failed intake read
  // shows the tracker, which works empty, rather than a form served on a guess.
  const needsSetup = !!data && data.tracks.length === 0;
  const intake = useQuery({ queryKey: ["intake"], queryFn: getIntake, retry: false });

  if (isPending || (needsSetup && intake.isPending)) {
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

  if (needsSetup && !intake.isError && !intake.data) {
    return (
      <Setup
        data={data}
        onSent={() => void queryClient.invalidateQueries()}
        onSignOut={onSignOut}
      />
    );
  }

  return (
    <Shell
      data={data}
      isOverview={location.pathname === "/"}
      notice={<SetupNotice intake={intake.data ?? null} staleRunHours={data.settings.stale_run_hours} />}
      onSignOut={onSignOut}
    />
  );
}

function Root() {
  const [signedIn, setSignedIn] = useState(() => !!session.token());
  const [gate, setGate] = useState<GateState>({ notice: "", focusPassword: false });
  // Read once: the code leaves the address bar as soon as it is spent or turns
  // out unusable, so a refresh can't re-run a signup that can only fail now.
  const [invite, setInvite] = useState(() => new URLSearchParams(window.location.search).get("invite") ?? "");
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const dropInvite = useCallback(() => {
    setInvite("");
    navigate({ pathname: "/", search: "" }, { replace: true });
  }, [navigate]);
  const inviteUnusable = useCallback(
    (notice: string) => {
      dropInvite();
      // Someone already signed in here has a tracker to go to; everyone else
      // gets the sign-in card, saying why the link didn't work.
      if (!session.token()) setGate({ notice, focusPassword: false });
    },
    [dropInvite],
  );

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

  // An invite beats a remembered session: opening one is being handed an
  // account of your own, not signing in as whoever last used this browser.
  if (invite) {
    return (
      <InviteGate
        code={invite}
        onUnusable={inviteUnusable}
        onSignedUp={() => {
          dropInvite();
          queryClient.clear();
          setSignedIn(true);
        }}
      />
    );
  }

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
