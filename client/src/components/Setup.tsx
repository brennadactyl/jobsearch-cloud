/**
 * What an account with no tracks sees instead of an empty tracker: the form a
 * new person fills in once, and what became of it until the overnight run has
 * built their search. The answers are stored as given; turning them into config
 * is the run's job (docs/onboarding-plan.md).
 */
import { useId, useRef, useState, type ReactNode } from "react";
import { deleteDocument, failureOf, getIntake, putDocument, submitIntake } from "../api/client";
import { PRONOUNS, type Intake, type IntakeAnswers, type RoleAnswer, type TrackerData } from "../api/schema";
import { locationRules, parseLocations, type LocationEntry } from "../domain/locations";
import {
  emptyAnswers,
  emptyRole,
  MAX_FILE_BYTES,
  safeDocumentName,
  setupOverdue,
  setupProblems,
  type SetupProblems,
} from "../domain/onboarding";
import { saved, useSaved } from "../ui/saved";

type Refused = { name: string; reason: string };

const TIER_COLOURS = ["var(--pri-0)", "var(--pri-1)", "var(--pri-2)", "var(--pri-3)", "var(--pri-4)"];

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

function Section({ title, children }: { title: string; children?: ReactNode }) {
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
              <i style={{ background: r < 5 ? TIER_COLOURS[r] : "var(--ink3)" }} />
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

function Banner({ intake, staleRunHours }: { intake: Intake | null; staleRunHours: number }) {
  if (!intake || intake.status === "done") return null;
  if (intake.status === "failed") {
    return (
      <div className="setup-status bad" role="status">
        <strong>Setup couldn't finish</strong>
        {intake.status_note || "The overnight run stopped before it built your search."} Change whatever's needed below
        and send it again — it'll be picked up on the next run.
      </div>
    );
  }
  if (setupOverdue(intake.sent_at, staleRunHours)) {
    return (
      <div className="setup-status" role="status">
        <strong>This hasn't run yet — it may be waiting for the machine that runs searches to be switched on.</strong>
        Your answers are saved, and you can keep changing them; the last version you send is the one it uses.
      </div>
    );
  }
  return (
    <div className="setup-status" role="status">
      <strong>You're all set — it's building tonight</strong>
      Your tracker will be ready in the morning. You can keep changing anything below until then; the last version you
      send is the one it uses.
    </div>
  );
}

export default function Setup({
  data,
  intake: initialIntake,
  onSignOut,
}: {
  data: TrackerData;
  intake: Intake | null;
  onSignOut: () => void;
}) {
  const save = useSaved();
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [intake, setIntake] = useState(initialIntake);
  const [answers, setAnswers] = useState<IntakeAnswers>(() =>
    initialIntake ? { ...initialIntake.answers, roles: initialIntake.answers.roles.length ? initialIntake.answers.roles : [emptyRole()] } : emptyAnswers(data.user.name),
  );
  const [stored, setStored] = useState<string[]>(() => initialIntake?.answers.resume_files ?? []);
  const [removed, setRemoved] = useState<string[]>([]);
  const [picked, setPicked] = useState<File[]>([]);
  const [refused, setRefused] = useState<Refused[]>([]);
  const [problems, setProblems] = useState<SetupProblems & { form?: string }>({});
  const [sending, setSending] = useState(false);

  const entries = parseLocations(answers.locations_first);
  const set = <K extends keyof IntakeAnswers>(key: K, value: IntakeAnswers[K]) => setAnswers((a) => ({ ...a, [key]: value }));
  const setRole = (i: number, patch: Partial<RoleAnswer>) =>
    setAnswers((a) => ({ ...a, roles: a.roles.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  const fileNames = [...stored.map((p) => p.slice(p.indexOf("/") + 1)), ...picked.map((f) => f.name)];

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
      for (const path of removed) await deleteDocument(path).catch(() => undefined);
      const uploaded: string[] = [];
      for (const file of picked) {
        const res = await putDocument(`resumes/${safeDocumentName(file.name)}`, file);
        uploaded.push(res.path);
      }
      const resumeFiles = [...new Set([...stored, ...uploaded])];
      await submitIntake({ ...answers, resume_files: resumeFiles, priority_locations: locationRules(entries) });
      const fresh = await getIntake();
      setIntake(fresh);
      setStored(resumeFiles);
      setPicked([]);
      setRemoved([]);
      setRefused([]);
      saved.note("Sent");
    } catch (err) {
      const failure = failureOf(err);
      if (failure?.status === 401) return;
      const where =
        failure?.field === "roles"
          ? "role-0"
          : failure?.field === "resume"
            ? "attach"
            : failure?.field === "priority_locations"
              ? "locations"
              : "form";
      setProblems({ [where]: failure?.message ?? (err instanceof Error ? err.message : String(err)) });
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
            Tell it what you're looking for and attach your resume. Overnight it reads your resume, works out how to
            describe the roles you want, and builds your tracker. It'll be here in the morning, and it updates itself
            every day after that.
          </p>
          <Banner intake={intake} staleRunHours={data.settings.stale_run_hours} />

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

          <Section title="Your resume">Attach your resume, paste its text, or both. Pasting always works.</Section>
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
            {(stored.length > 0 || picked.length > 0 || refused.length > 0) && (
              <div className="setup-files">
                {stored.map((path) => (
                  <div className="setup-file" key={path}>
                    <span>{path.slice(path.indexOf("/") + 1)}</span>
                    <button
                      className="setup-rm"
                      type="button"
                      onClick={() => {
                        setStored((s) => s.filter((p) => p !== path));
                        setRemoved((r) => [...r, path]);
                      }}
                    >
                      remove
                    </button>
                  </div>
                ))}
                {picked.map((file, i) => (
                  <div className="setup-file" key={`${file.name}-${i}`}>
                    <span>{file.name}</span>
                    <button className="setup-rm" type="button" onClick={() => setPicked((p) => p.filter((_, j) => j !== i))}>
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
            )}
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

          <Section title="Where you'll work">
            Two different questions: what's off the table entirely, and what you'd most like.
          </Section>
          <Field
            label={<label htmlFor={`${id}-limits`}>Anywhere you can't take a job?</label>}
            hint="Say it the way you'd say it to a person. Leave it empty if nowhere is ruled out."
          >
            <textarea
              id={`${id}-limits`}
              rows={2}
              placeholder="US only — I can't take a role that requires being in another country."
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

          <Section title="What to look for">
            One block per kind of role, and each is its own nightly search. Most people want one; add another if you're
            running two genuinely different searches, like engineering and product.
          </Section>
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

          <Section title="Anything else" />
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
              {intake ? "Send changes" : "Start my search"}
            </button>
            {problems.form && <p className="field-err">{problems.form}</p>}
          </div>
        </form>
      </div>
    </div>
  );
}
