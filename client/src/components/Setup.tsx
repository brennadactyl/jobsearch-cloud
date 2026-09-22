/**
 * The form a new person fills in once, shown until their searches exist.
 *
 * Sending builds them, so this is the last thing they see before their own
 * tracker: the send is write-once and there is no way back here
 * (docs/onboarding.md#why-it-is-split-this-way). What the answers can't settle - the prose the
 * daily prompt reads - the overnight run writes.
 */
import { useId, useRef, useState, type ReactNode } from "react";
import { deleteDocument, failureOf, putDocument, submitIntake } from "../api/client";
import { PRONOUNS, type IntakeAnswers, type RoleAnswer, type TrackerData } from "../api/schema";
import {
  emptyAnswers,
  emptyRole,
  isOlderWordFile,
  MAX_FILE_BYTES,
  safeDocumentName,
  setupProblems,
  type SetupProblems,
} from "../domain/onboarding";
import { listEntries, PLACE_QUESTIONS } from "../domain/places";
import { saved, useSaved } from "../ui/saved";
import PlaceChips from "./PlaceChips";

/** A file the form turned away. `name` is shown before the reason, or "" when the reason already names it. */
type Refused = { name: string; reason: string };

/**
 * One resume on the form. It uploads the moment it's picked, so it is either
 * still on its way or stored - with the words the server read, for a Word file.
 */
type Attachment =
  | { key: number; name: string; status: "uploading" }
  | { key: number; name: string; status: "stored"; path: string; words?: number };

/** Where a message sits on the form: a problem slot, or "form" beside the send button. */
type ProblemSlot = keyof SetupProblems | "form";

/**
 * The answer a server refusal names (its `field`), mapped to the part of the form
 * that shows the message. A refusal naming anything else, or nothing, shows
 * beside the send button.
 */
const PROBLEM_SLOT_FOR_FIELD: Readonly<Record<string, ProblemSlot>> = {
  roles: "role-0",
  resume: "attach",
  work_scope: "work_scope",
  locations_first: "locations_first",
  location_limits: "location_limits",
  location_note: "location_note",
};

function problemSlotFor(field: string | undefined): ProblemSlot {
  return field && Object.hasOwn(PROBLEM_SLOT_FOR_FIELD, field) ? PROBLEM_SLOT_FOR_FIELD[field] : "form";
}

/** The filename part of a stored document path: "resumes/cv.pdf" is "cv.pdf". */
function fileNameOf(path: string): string {
  return path.slice(path.indexOf("/") + 1);
}

function Field({
  label,
  optional,
  hint,
  problem,
  children,
}: {
  label?: ReactNode;
  optional?: boolean;
  hint?: string;
  problem?: string;
  children: ReactNode;
}) {
  return (
    <div className="setup-field">
      {label && (
        <div className="setup-label">
          {label}
          {optional && <span className="setup-optional"> (optional)</span>}
        </div>
      )}
      {children}
      {problem && <p className="field-err">{problem}</p>}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

/** A heading that opens one part of the form, with an optional line under it. */
function SetupHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="setup-sec">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
  );
}

/** The resumes on the form: stored or still uploading, and any turned away. */
function ResumeFiles({
  attachments,
  refused,
  onRemove,
}: {
  attachments: Attachment[];
  refused: Refused[];
  onRemove: (a: Attachment) => void;
}) {
  if (attachments.length === 0 && refused.length === 0) return null;
  return (
    <div className="setup-files">
      {attachments.map((a) => (
        <div className="setup-file" key={a.key}>
          {a.status === "uploading" ? (
            <span>
              {a.name} <span className="field-hint">· uploading…</span>
            </span>
          ) : (
            <>
              <span>
                {fileNameOf(a.path)}
                {a.words !== undefined && <span className="field-hint">{` · ${a.words} words read`}</span>}
              </span>
              <button className="setup-rm" type="button" onClick={() => onRemove(a)}>
                remove
              </button>
            </>
          )}
        </div>
      ))}
      {refused.map((r, i) => (
        <div className="setup-file" key={`refused-${i}`}>
          {r.name && <span>{r.name}</span>}
          <p className="field-err">{r.reason}</p>
        </div>
      ))}
    </div>
  );
}

function RoleBlock({
  n,
  role,
  problem,
  onChange,
  onRemove,
}: {
  n: number;
  role: RoleAnswer;
  problem?: string;
  onChange: (patch: Partial<RoleAnswer>) => void;
  onRemove?: () => void;
}) {
  const id = useId();
  const set = (key: keyof RoleAnswer) => (e: { target: { value: string } }) => onChange({ [key]: e.target.value });
  return (
    <div className="setup-role">
      <div className="setup-role-top">
        <strong>Role {n}</strong>
        {onRemove && (
          <button className="btn ghost" type="button" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      <Field label={<label htmlFor={`${id}-name`}>Call it</label>} hint="This is the name on its tab.">
        <input id={`${id}-name`} type="text" placeholder="Engineering" value={role.name} onChange={set("name")} />
      </Field>
      <Field
        label={<label htmlFor={`${id}-titles`}>What roles?</label>}
        problem={problem}
        hint="Titles and seniority, e.g. “Senior or Staff backend engineer”. Anything you don't want goes in the box below."
      >
        <textarea
          id={`${id}-titles`}
          rows={2}
          placeholder="Senior or Staff backend engineer"
          aria-invalid={problem ? true : undefined}
          value={role.titles}
          onChange={set("titles")}
        />
      </Field>
      <Field
        label={<label htmlFor={`${id}-kinds`}>Kinds of companies you'd like</label>}
        optional
        hint="What kinds of employers suit you. It guides where the search looks for new companies. Name particular companies too if you like — they're added to the list every search works through."
      >
        <textarea
          id={`${id}-kinds`}
          rows={2}
          placeholder="Payments and developer tools, mid-size"
          value={role.company_kinds}
          onChange={set("company_kinds")}
        />
      </Field>
      <Field
        label={<label htmlFor={`${id}-rules`}>Anything that rules a job out</label>}
        optional
        hint="Only real mismatches — something you genuinely don't have or won't do. Anything vaguer here quietly hides jobs you'd have wanted."
      >
        <input
          id={`${id}-rules`}
          type="text"
          placeholder="No mobile roles — I've never shipped iOS or Android."
          value={role.rule_outs}
          onChange={set("rule_outs")}
        />
      </Field>
      <Field
        label={<label htmlFor={`${id}-pay`}>Lowest acceptable pay</label>}
        optional
        hint="A posting that states lower pay is screened out. One that doesn't say is kept."
      >
        <input id={`${id}-pay`} type="text" placeholder="$180k base" value={role.min_pay} onChange={set("min_pay")} />
      </Field>
    </div>
  );
}

export default function Setup({
  data,
  onSent,
  onSignOut,
}: {
  data: TrackerData;
  /** The send built the searches; the page reads them back and the tracker takes over. */
  onSent: () => void;
  onSignOut: () => void;
}) {
  const save = useSaved();
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [answers, setAnswers] = useState<IntakeAnswers>(() => emptyAnswers(data.user.name));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [refused, setRefused] = useState<Refused[]>([]);
  const nextKey = useRef(0);
  const [problems, setProblems] = useState<Partial<Record<ProblemSlot, string>>>({});
  const [sending, setSending] = useState(false);

  const set = <K extends keyof IntakeAnswers>(key: K, value: IntakeAnswers[K]) => setAnswers((a) => ({ ...a, [key]: value }));
  const setRole = (i: number, patch: Partial<RoleAnswer>) =>
    setAnswers((a) => ({ ...a, roles: a.roles.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  const stored = attachments.flatMap((a) => (a.status === "stored" ? [a] : []));
  const uploading = attachments.some((a) => a.status === "uploading");

  /**
   * Uploads each file as soon as it's picked, so the person sees what was read
   * from it - or why it was refused - while they're still on the form. A file
   * too big, or in the older Word format, is turned away without uploading.
   */
  function pick(files: FileList | null) {
    if (!files) return;
    setRefused([]);
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_BYTES) {
        refuse({ name: file.name, reason: `Not attached: it's ${(file.size / 1024 / 1024).toFixed(1)} MB, and files can be up to 8 MB.` });
      } else if (isOlderWordFile(file.name)) {
        refuse({ name: file.name, reason: "Not attached: it's an older Word file. Save it as .docx or PDF and attach that." });
      } else {
        void upload(file);
      }
    }
  }

  function refuse(r: Refused) {
    setRefused((list) => [...list, r]);
  }

  async function upload(file: File) {
    const key = nextKey.current++;
    setAttachments((list) => [...list, { key, name: file.name, status: "uploading" }]);
    try {
      const res = await putDocument(`resumes/${safeDocumentName(file.name)}`, file);
      setAttachments((list) =>
        list
          // Picking a file with the same stored name replaces it, so it lists once.
          .filter((a) => a.key === key || a.status !== "stored" || a.path !== res.path)
          .map((a) => (a.key === key ? { key, name: file.name, status: "stored", path: res.path, words: res.words } : a)),
      );
    } catch (err) {
      setAttachments((list) => list.filter((a) => a.key !== key));
      const failure = failureOf(err);
      if (failure?.status === 401) return;
      // The server's reason already starts with the file's name.
      refuse({ name: failure ? "" : file.name, reason: failure?.message ?? (err instanceof Error ? err.message : String(err)) });
    }
  }

  function remove(a: Attachment) {
    setAttachments((list) => list.filter((x) => x.key !== a.key));
    // Nothing names a removed file any more, so a failed delete leaves only a stray document.
    if (a.status === "stored") void deleteDocument(a.path).catch(() => undefined);
  }

  async function send() {
    const found: Partial<Record<ProblemSlot, string>> = setupProblems(answers, stored.map((a) => fileNameOf(a.path)));
    if (uploading) found.attach = "Wait for your resume to finish uploading, then send.";
    setProblems(found);
    if (Object.keys(found).length) return;

    setSending(true);
    saved.saving("Sending…");
    try {
      await submitIntake({ ...answers, resume_files: stored.map((a) => a.path) });
      setRefused([]);
      saved.ok();
      onSent();
    } catch (err) {
      const failure = failureOf(err);
      if (failure?.status === 401) return;
      setProblems({ [problemSlotFor(failure?.field)]: failure?.message ?? (err instanceof Error ? err.message : String(err)) });
      saved.message("Couldn't send — try again");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="setup">
      <div className="setup-wrap">
        <div className="setup-top">
          <div className="setup-who">Signed in as {data.user.name}</div>
          <div className="hdr-right">
            <div className="stamp">
              <span className={`dot ${save.tone}`} />
              <span role="status" aria-live="polite">
                {save.text}
              </span>
            </div>
            <button className="btn ghost" type="button" onClick={onSignOut} title="Sign out of this browser">
              Log out
            </button>
          </div>
        </div>

        <form
          className="card setup-card"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <h1>Set up your job search</h1>
          <p className="setup-lede">
            Tell it what you're looking for and attach your resume. Sending this builds your tracker straight away —
            you'll land on it. Overnight it reads your resume, works out how to describe the roles you want, and starts
            filling the tracker in; it updates itself every day after that.
          </p>
          <p className="setup-lede">You fill this in once, so take your time with it.</p>

          <Field label={<label htmlFor={`${id}-title`}>What should this page be called?</label>}>
            <input id={`${id}-title`} type="text" value={answers.page_title} onChange={(e) => set("page_title", e.target.value)} />
          </Field>
          <Field
            label="Your pronouns"
            optional
            hint="Used when the search writes about you. Skip it and the search uses they/them."
          >
            <div className="viewsw setup-pronouns" role="group" aria-label="Your pronouns">
              {PRONOUNS.map((p) => (
                <button
                  key={p}
                  className="vbtn"
                  type="button"
                  aria-pressed={answers.pronouns === p}
                  onClick={() => set("pronouns", answers.pronouns === p ? "" : p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </Field>

          <SetupHeading title="Your resume">Attach your resume, paste its text, or both. Pasting always works.</SetupHeading>
          <Field problem={problems.attach} hint="PDF, Word (.docx), .txt or .md, up to 8 MB">
            <div className="setup-attach">
              <button className="btn" type="button" onClick={() => fileInput.current?.click()}>
                Attach files
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                aria-label="Attach resume files"
                onChange={(e) => {
                  pick(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
            <ResumeFiles attachments={attachments} refused={refused} onRemove={remove} />
          </Field>
          <Field label={<label htmlFor={`${id}-resume`}>Or paste it here</label>}>
            <textarea
              id={`${id}-resume`}
              rows={5}
              placeholder="Paste the text of your resume"
              value={answers.resume_text}
              onChange={(e) => set("resume_text", e.target.value)}
            />
          </Field>

          {/*
            The same four questions the account panel asks, so a reword reaches
            both: PLACE_QUESTIONS in domain/places.ts. A setup answer keeps its
            own name until the server files it (work_scope is search_locations,
            locations_first is priority_locations, location_limits is
            excluded_locations). The hints below are this screen's own - someone
            filling this in has never seen their list tiered.
          */}
          <SetupHeading title="Where to search">
            Three different questions: every area to search, what you'd most like, and anything ruled out inside it.
            Add places one at a time.
          </SetupHeading>
          <Field
            label={<label htmlFor={`${id}-scope`}>{PLACE_QUESTIONS.search_locations}</label>}
            problem={problems.work_scope}
            // The one place the page states that preferred places are always
            // searched: a text match against this answer can't tell whether
            // Seattle is "US only", so no note names a place as outside it.
            hint="Every area the search should cover — name all of it, not only the part you'd prefer. The places you rank below are always searched too."
          >
            <PlaceChips
              id={`${id}-scope`}
              placeholder="Add a place, then press Enter"
              invalid={!!problems.work_scope}
              value={answers.work_scope}
              onChange={(value) => set("work_scope", value)}
              // Empty doesn't mean anywhere: the search looks only where the ranked list says.
              empty={listEntries(answers.locations_first).length ? "Only the ranked places" : ""}
            />
          </Field>
          <Field
            label={<label htmlFor={`${id}-first`}>{PLACE_QUESTIONS.priority_locations}</label>}
            problem={problems.locations_first}
            hint="In order — the first is the one you want most, and the arrows move a place up or down. Use a city (add the state if the name is common, like Portland OR), or Remote with a country, like Remote US. Anywhere you don't name still shows up, just lower."
          >
            <PlaceChips
              id={`${id}-first`}
              placeholder="Add a place, then press Enter"
              ranked
              invalid={!!problems.locations_first}
              value={answers.locations_first}
              onChange={(value) => set("locations_first", value)}
            />
          </Field>
          <Field
            label={<label htmlFor={`${id}-limits`}>{PLACE_QUESTIONS.excluded_locations}</label>}
            optional
            problem={problems.location_limits}
            hint="Optional, and only a rule-out: somewhere inside the searched area that you still couldn't take. It never narrows where the search looks on its own — leave it empty if nothing is ruled out."
          >
            <PlaceChips
              id={`${id}-limits`}
              placeholder="Add a place, then press Enter"
              invalid={!!problems.location_limits}
              value={answers.location_limits}
              onChange={(value) => set("location_limits", value)}
            />
          </Field>
          <Field
            label={<label htmlFor={`${id}-note`}>{PLACE_QUESTIONS.location_note}</label>}
            optional
            problem={problems.location_note}
            hint="Anything a list can't say. The search reads it as context."
          >
            <textarea
              id={`${id}-note`}
              rows={2}
              placeholder="Open to relocating for the right team."
              aria-invalid={problems.location_note ? true : undefined}
              value={answers.location_note}
              onChange={(e) => set("location_note", e.target.value)}
            />
          </Field>

          <SetupHeading title="What to look for">
            One block per kind of role, and each is its own nightly search. Most people want one; add another if you're
            running two genuinely different searches, like engineering and product.
          </SetupHeading>
          {answers.roles.map((role, i) => (
            <RoleBlock
              key={i}
              n={i + 1}
              role={role}
              problem={problems[`role-${i}`]}
              onChange={(patch) => setRole(i, patch)}
              onRemove={i > 0 ? () => set("roles", answers.roles.filter((_, j) => j !== i)) : undefined}
            />
          ))}
          <div>
            <button className="btn" type="button" onClick={() => set("roles", [...answers.roles, emptyRole()])}>
              Add another kind of role
            </button>
          </div>

          <SetupHeading title="Anything else" />
          <Field
            label={<label htmlFor={`${id}-never`}>Companies you'd never work for</label>}
            hint="These are never searched and never shown, at all."
          >
            <input
              id={`${id}-never`}
              type="text"
              placeholder="Initech, Globex"
              value={answers.never_work_for}
              onChange={(e) => set("never_work_for", e.target.value)}
            />
          </Field>
          <Field
            label={<label htmlFor={`${id}-prefs`}>Preferences the search should weigh</label>}
            hint="Things that make a job better or worse for you. They're weighed, never used to hide a job."
          >
            <textarea
              id={`${id}-prefs`}
              rows={3}
              placeholder="I'd rather avoid on-call heavy roles. I'm open to a pay cut for the right team."
              value={answers.preferences}
              onChange={(e) => set("preferences", e.target.value)}
            />
          </Field>

          <div className="setup-actions">
            <button className="btn primary" type="submit" disabled={sending}>
              Start my search
            </button>
            {problems.form && <p className="field-err">{problems.form}</p>}
          </div>
        </form>
      </div>
    </div>
  );
}
