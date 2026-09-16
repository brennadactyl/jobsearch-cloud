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
import { locationRules, parseLocations, type LocationEntry } from "../domain/locations";
import {
  emptyAnswers,
  emptyRole,
  MAX_FILE_BYTES,
  safeDocumentName,
  setupProblems,
  type SetupProblems,
} from "../domain/onboarding";
import { saved, useSaved } from "../ui/saved";

type Refused = { name: string; reason: string };

/** Where a message sits on the form: a problem slot, or "form" beside the send button. */
type ProblemSlot = keyof SetupProblems | "form";

const TIER_COLOURS = ["var(--pri-0)", "var(--pri-1)", "var(--pri-2)", "var(--pri-3)", "var(--pri-4)"];

/**
 * The answer a server refusal names (its `field`), mapped to the part of the form
 * that shows the message. A refusal naming anything else, or nothing, shows
 * beside the send button.
 */
const PROBLEM_SLOT_FOR_FIELD: Readonly<Record<string, ProblemSlot>> = {
  roles: "role-0",
  resume: "attach",
  priority_locations: "locations",
  work_scope: "work_scope",
};

function problemSlotFor(field: string | undefined): ProblemSlot {
  return field && Object.hasOwn(PROBLEM_SLOT_FOR_FIELD, field) ? PROBLEM_SLOT_FOR_FIELD[field] : "form";
}

/** The filename part of a stored document path: "resumes/cv.pdf" is "cv.pdf". */
function fileNameOf(path: string): string {
  return path.slice(path.indexOf("/") + 1);
}

/**
 * Brings the stored resumes in line with the form before the answers are sent:
 * deletes the ones removed, uploads the ones picked, and returns every path the
 * answers should name. A failed delete is ignored - the answers stop naming the
 * file either way.
 */
async function syncResumeFiles(stored: string[], removed: string[], picked: File[]): Promise<string[]> {
  for (const path of removed) await deleteDocument(path).catch(() => undefined);
  const uploaded: string[] = [];
  for (const file of picked) {
    const res = await putDocument(`resumes/${safeDocumentName(file.name)}`, file);
    uploaded.push(res.path);
  }
  return [...new Set([...stored, ...uploaded])];
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

/** Each entry as it will rank, and what it matches - or why it can't. */
function LocationReadback({ entries }: { entries: LocationEntry[] }) {
  const ranked = entries.flatMap((e) => ("rule" in e ? [e] : []));
  const flagged = entries.flatMap((e) => ("problem" in e ? [e] : []));
  return (
    <>
      {ranked.length > 0 && (
        <div className="key setup-readback">
          {ranked.map((e, r) => (
            <span key={`${r}-${e.text}`}>
              <i style={{ background: TIER_COLOURS[r] ?? "var(--ink3)" }} />
              {r + 1}. {e.text}
              {e.means && ` — ${e.means}`}
            </span>
          ))}
        </div>
      )}
      {flagged.map((e, i) => (
        <p key={`flag-${i}`} className="field-err">
          {e.problem}
        </p>
      ))}
    </>
  );
}

/** The resume files the form will send: already stored, picked this visit, and any refused for size. */
function ResumeFiles({
  stored,
  picked,
  refused,
  onRemoveStored,
  onRemovePicked,
}: {
  stored: string[];
  picked: File[];
  refused: Refused[];
  onRemoveStored: (path: string) => void;
  onRemovePicked: (index: number) => void;
}) {
  if (stored.length === 0 && picked.length === 0 && refused.length === 0) return null;
  return (
    <div className="setup-files">
      {stored.map((path) => (
        <div className="setup-file" key={path}>
          <span>{fileNameOf(path)}</span>
          <button className="setup-rm" type="button" onClick={() => onRemoveStored(path)}>
            remove
          </button>
        </div>
      ))}
      {picked.map((file, i) => (
        <div className="setup-file" key={`${file.name}-${i}`}>
          <span>{file.name}</span>
          <button className="setup-rm" type="button" onClick={() => onRemovePicked(i)}>
            remove
          </button>
        </div>
      ))}
      {refused.map((r, i) => (
        <div className="setup-file" key={`refused-${i}`}>
          <span>{r.name}</span>
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
  const [stored, setStored] = useState<string[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [picked, setPicked] = useState<File[]>([]);
  const [refused, setRefused] = useState<Refused[]>([]);
  const [problems, setProblems] = useState<Partial<Record<ProblemSlot, string>>>({});
  const [sending, setSending] = useState(false);

  const entries = parseLocations(answers.locations_first);
  const set = <K extends keyof IntakeAnswers>(key: K, value: IntakeAnswers[K]) => setAnswers((a) => ({ ...a, [key]: value }));
  const setRole = (i: number, patch: Partial<RoleAnswer>) =>
    setAnswers((a) => ({ ...a, roles: a.roles.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  const fileNames = [...stored.map(fileNameOf), ...picked.map((f) => f.name)];

  function pick(files: FileList | null) {
    if (!files) return;
    const ok: File[] = [];
    const tooBig: Refused[] = [];
    for (const f of Array.from(files)) {
      if (f.size > MAX_FILE_BYTES) {
        tooBig.push({ name: f.name, reason: `Not attached: it's ${(f.size / 1024 / 1024).toFixed(1)} MB, and files can be up to 8 MB.` });
      } else {
        ok.push(f);
      }
    }
    setPicked((p) => [...p, ...ok]);
    setRefused(tooBig);
  }

  async function send() {
    const found = setupProblems(answers, fileNames);
    setProblems(found);
    if (Object.keys(found).length) return;

    setSending(true);
    saved.saving("Sending…");
    try {
      const resumeFiles = await syncResumeFiles(stored, removed, picked);
      await submitIntake({ ...answers, resume_files: resumeFiles, priority_locations: locationRules(entries) });
      setStored(resumeFiles);
      setPicked([]);
      setRemoved([]);
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
          <Field problem={problems.attach}>
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
            <ResumeFiles
              stored={stored}
              picked={picked}
              refused={refused}
              onRemoveStored={(path) => {
                setStored((s) => s.filter((p) => p !== path));
                setRemoved((r) => [...r, path]);
              }}
              onRemovePicked={(i) => setPicked((p) => p.filter((_, j) => j !== i))}
            />
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

          <SetupHeading title="Where you'll work">
            Three different questions: everywhere you could work, anything ruled out inside that, and what you'd most
            like.
          </SetupHeading>
          <Field
            label={<label htmlFor={`${id}-scope`}>Where can you work?</label>}
            problem={problems.work_scope}
            hint="This is the answer that sets where the search looks, so name the whole area you could take a job in — not only the part you'd prefer."
          >
            <textarea
              id={`${id}-scope`}
              rows={2}
              placeholder="Anywhere in the US, remote or in the Denver area"
              aria-invalid={problems.work_scope ? true : undefined}
              value={answers.work_scope}
              onChange={(e) => set("work_scope", e.target.value)}
            />
          </Field>
          <Field
            label={<label htmlFor={`${id}-limits`}>Anywhere you can't take a job?</label>}
            hint="Optional, and only a rule-out: somewhere inside the area above that you still couldn't take. It never narrows where the search looks on its own — leave it empty if nothing is ruled out."
          >
            <textarea
              id={`${id}-limits`}
              rows={2}
              placeholder="Nothing that needs me on site in another state."
              value={answers.location_limits}
              onChange={(e) => set("location_limits", e.target.value)}
            />
          </Field>
          <Field
            label={<label htmlFor={`${id}-first`}>Which locations should come first?</label>}
            problem={problems.locations}
            hint="List places in order — the first is the one you want most. Use a city (add the state if the name is common, like Portland OR), or Remote with a country, like Remote US. Anywhere you don't name still shows up, just lower."
          >
            <input
              id={`${id}-first`}
              type="text"
              placeholder="Seattle, Bellevue, Remote US, Portland OR"
              aria-invalid={entries.some((e) => "problem" in e) ? true : undefined}
              value={answers.locations_first}
              onChange={(e) => set("locations_first", e.target.value)}
            />
            <LocationReadback entries={entries} />
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
