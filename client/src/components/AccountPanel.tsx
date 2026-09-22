/**
 * The account panel, opened from "My account" in the header: who is signed in,
 * then one section per thing a person can change about their own account.
 *
 * Choices wait for the panel's one Save and Discard, at its foot, which count
 * and commit what's unsaved in every section together. Uploading a resume and
 * changing the password happen at once instead: each is its own action.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { changePassword, failureOf, saveSettings, UnauthorizedError } from "../api/client";
import { DATA_KEY, DOCUMENTS_KEY } from "../api/mutations";
import { settingsSchema, type Settings, type TrackerData, type Track } from "../api/schema";
import { MIN_PASSWORD } from "../domain/account";
import {
  changedPlaces,
  nowhereToSearch,
  PLACE_KEYS,
  unsavedPlacesSentence,
  type PlaceKey,
  type Places,
} from "../domain/places";
import { saved } from "../ui/saved";
import LocationsSection from "./LocationsSection";
import ResumeSection from "./ResumeSection";

type Props = { open: boolean; name: string; tracks: readonly Track[]; settings: Settings; onClose: () => void };

export default function AccountPanel({ open, ...props }: Props) {
  // Mounts per opening, so nothing typed or chosen in one visit is still there in the next.
  if (!open) return null;
  return <AccountDialog {...props} />;
}

/** A refused save: the server's sentence, and the place setting it names, if any. */
type SaveError = { message: string; field: PlaceKey | null };

/**
 * One section of the panel at a time, chosen from the sidebar, so nothing
 * scrolls past what it isn't about. Searches joins these once the server can
 * write them (docs/account-settings-plan.md).
 */
const SECTIONS = [
  { key: "general", label: "General" },
  { key: "locations", label: "Locations" },
  { key: "resumes", label: "Resumes" },
] as const;
type SectionKey = (typeof SECTIONS)[number]["key"];

const isPlaceKey = (field: string | undefined): field is PlaceKey => PLACE_KEYS.some((k) => k === field);

function AccountDialog({ name, tracks, settings, onClose }: Omit<Props, "open">) {
  const qc = useQueryClient();
  const stored = Object.fromEntries(PLACE_KEYS.map((k) => [k, settings[k]])) as Places;

  const [open, setOpen] = useState<SectionKey>("general");
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Partial<Places>>({});
  const [resumeSentence, setResumeSentence] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [placesSaved, setPlacesSaved] = useState(false);
  const [asking, setAsking] = useState(false);

  const places = changedPlaces(stored, draft);
  const resumeCount = Object.keys(picks).length;
  const count = resumeCount + Object.keys(places).length;
  // Which sections hold something unsaved, so the sidebar can say so: an edit
  // in a section you aren't looking at must not be invisible.
  const unsaved = new Set<SectionKey>([
    ...(resumeCount ? (["resumes"] as const) : []),
    ...(Object.keys(places).length ? (["locations"] as const) : []),
  ]);
  // The resume section's sentence is its own only while its choices stand; it
  // isn't mounted to withdraw the sentence when they're discarded.
  const sentence = [resumeCount ? resumeSentence : "", unsavedPlacesSentence(places)].filter(Boolean).join(" ");

  // Every way out comes through here, so unsaved choices are never lost without asking.
  const leave = () => {
    if (count) setAsking(true);
    else onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (asking) setAsking(false);
      else if (count) setAsking(true);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [asking, count, onClose]);

  // Asks before the browser leaves the page too, not only the panel.
  useEffect(() => {
    if (!count) return;
    const hold = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, [count]);

  function discard() {
    setPicks({});
    setDraft({});
    setSaveError(null);
  }

  async function save() {
    const nowhere = Object.keys(places).length
      ? nowhereToSearch(draft.search_locations ?? stored.search_locations, draft.priority_locations ?? stored.priority_locations)
      : "";
    if (nowhere) return setSaveError({ message: nowhere, field: "search_locations" });
    setSaving(true);
    setSaveError(null);
    saved.saving();
    try {
      const reply = await saveSettings({ ...(Object.keys(picks).length ? { resumes: picks } : {}), ...places });
      // The page's copy of the settings takes what the server stored, so the
      // fields and the ranked key show it without waiting for a refetch.
      qc.setQueryData<TrackerData>(DATA_KEY, (d) =>
        d ? { ...d, settings: settingsSchema.parse({ ...d.settings, ...reply.locations }) } : d,
      );
      await qc.invalidateQueries({ queryKey: DOCUMENTS_KEY });
      setPlacesSaved(Object.keys(places).length > 0);
      setPicks({});
      setDraft({});
      saved.ok();
    } catch (err) {
      // A 401 has already forgotten the session and shown the gate.
      if (err instanceof UnauthorizedError) return;
      const failure = failureOf(err);
      setSaveError({
        message: failure?.message ?? (err instanceof Error ? err.message : String(err)),
        field: isPlaceKey(failure?.field) ? failure.field : null,
      });
      saved.failed();
    } finally {
      setSaving(false);
    }
  }

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
        <div className="account-main">
          <SectionNav sections={SECTIONS} open={open} unsaved={unsaved} onOpen={setOpen} />
          <div className="account-body" data-wheel-target>
          {open === "general" && <PasswordSection />}
          {open === "resumes" && (
            <ResumeSection
              tracks={tracks}
              picks={picks}
              setPicks={(next) => {
                setSaveError(null);
                setPicks(next);
              }}
              onUnsaved={setResumeSentence}
            />
          )}
          {open === "locations" && (
            <LocationsSection
              values={{ ...stored, ...draft }}
              changed={new Set(Object.keys(places) as PlaceKey[])}
              problem={saveError?.field ? { field: saveError.field, message: saveError.message } : null}
              saved={placesSaved}
              onChange={(key, value) => {
                setDraft((d) => ({ ...d, [key]: value }));
                setPlacesSaved(false);
                if (saveError?.field === key) setSaveError(null);
              }}
            />
          )}
          </div>
        </div>
        {count > 0 && (
          <div className="account-foot">
            <span>
              {count === 1 ? "1 unsaved change" : `${count} unsaved changes`}
              {unsaved.size > 1 && ` across ${unsaved.size} sections`}
              {saveError && !saveError.field && (
                <span className="resume-bad" role="alert">
                  {saveError.message}
                </span>
              )}
            </span>
            <div className="modal-actions">
              <button className="btn" type="button" disabled={saving} onClick={discard}>
                Discard
              </button>
              <button className="btn primary" type="button" disabled={saving} onClick={() => void save()}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
      </div>
      {asking && count > 0 && (
        <div className="modal-overlay">
          <div className="card modal-card wide" role="alertdialog" aria-modal="true" aria-labelledby="leaveTitle">
            <h3 id="leaveTitle">Leave without saving?</h3>
            <p>{sentence}</p>
            <div className="modal-actions">
              <button className="btn" type="button" onClick={onClose}>
                {count === 1 ? "Discard change" : "Discard changes"}
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

/**
 * The sidebar of sections - a strip above the pane at phone width, where there
 * is no room beside it. A section holding unsaved changes is marked, so the
 * footer's count is never about something out of sight.
 */
function SectionNav({
  sections,
  open,
  unsaved,
  onOpen,
}: {
  sections: readonly { key: SectionKey; label: string }[];
  open: SectionKey;
  unsaved: ReadonlySet<SectionKey>;
  onOpen: (key: SectionKey) => void;
}) {
  return (
    <nav className="account-nav" aria-label="Account sections">
      {sections.map((s) => (
        <button
          key={s.key}
          type="button"
          className={s.key === open ? "open" : undefined}
          aria-current={s.key === open ? "page" : undefined}
          onClick={() => onOpen(s.key)}
        >
          {s.label}
          {unsaved.has(s.key) && <span className="account-nav-dot" aria-label="Unsaved changes" role="img" />}
        </button>
      ))}
    </nav>
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
