/**
 * The account panel's General section: what this page is called, how a run
 * writes about the person, and the companies they'd never work for. All three
 * are true the moment the panel's Save lands - no run is involved.
 */
import { PRONOUNS } from "../api/schema";
import { GENERAL_QUESTIONS, type General, type GeneralKey } from "../domain/panel";
import PlaceChips from "./PlaceChips";

export default function GeneralSection({
  values,
  changed,
  problem,
  onChange,
  children,
}: {
  /** What each field shows: the edit where there is one, else what's stored. */
  values: General;
  changed: ReadonlySet<GeneralKey>;
  /** A refused save's message, beside the setting it names. */
  problem: { field: GeneralKey; message: string } | null;
  onChange: <K extends GeneralKey>(key: K, value: General[K]) => void;
  /** The password, which is its own action rather than part of the Save. */
  children?: React.ReactNode;
}) {
  const problemFor = (key: GeneralKey) => (problem?.field === key ? problem.message : "");

  return (
    <section className="account-section" aria-labelledby="genTitle">
      <div>
        <h4 id="genTitle">General</h4>
        <p>What this page is called, how a run writes about you, and who you'd never work for.</p>
      </div>

      <Field
        id="gen-title"
        label={GENERAL_QUESTIONS.display_title}
        changed={changed.has("display_title")}
        problem={problemFor("display_title")}
        hint="The heading at the top of your tracker."
      >
        <input
          id="gen-title"
          type="text"
          value={values.display_title}
          className={changed.has("display_title") ? "changed" : undefined}
          aria-invalid={problemFor("display_title") ? true : undefined}
          onChange={(e) => onChange("display_title", e.target.value)}
        />
      </Field>

      <Field
        id="gen-pronouns"
        label={GENERAL_QUESTIONS.pronouns}
        changed={changed.has("pronouns")}
        problem={problemFor("pronouns")}
        hint="Used in the wording a run writes about you. It never reaches an employer."
        // A group of choices, so the label names the group rather than one control.
        asGroup
      >
        <div className="gen-choices">
          {([...PRONOUNS, ""] as General["pronouns"][]).map((choice) => (
            <button
              key={choice || "unsaid"}
              type="button"
              aria-pressed={values.pronouns === choice}
              className={values.pronouns === choice ? "chosen" : undefined}
              onClick={() => onChange("pronouns", choice)}
            >
              {choice || "Don't say"}
            </button>
          ))}
        </div>
      </Field>

      <Field
        id="gen-companies"
        label={GENERAL_QUESTIONS.excluded_companies}
        optional
        changed={changed.has("excluded_companies")}
        problem={problemFor("excluded_companies")}
        hint="Leads from these never reach your tracker. A name is matched as written, so use the spelling a posting uses."
      >
        <PlaceChips
          id="gen-companies"
          entries={values.excluded_companies}
          onChange={(entries) => onChange("excluded_companies", entries)}
          placeholder="Add a company, then press Enter"
          invalid={!!problemFor("excluded_companies")}
        />
      </Field>

      {children}
    </section>
  );
}

function Field({
  id,
  label,
  optional = false,
  asGroup = false,
  changed,
  problem,
  hint,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  asGroup?: boolean;
  changed: boolean;
  problem: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="loc-field" role={asGroup ? "group" : undefined} aria-label={asGroup ? label : undefined}>
      {/* The tags sit outside the label: a label whose text changes as you type
          is a different label to anything reading the page. */}
      <div className="loc-label">
        {asGroup ? <span className="gen-label">{label}</span> : <label htmlFor={id}>{label}</label>}
        {optional && <span className="loc-optional">(optional)</span>}
        {changed && <span className="resume-changed">Changed</span>}
      </div>
      {children}
      {problem && (
        <p className="loc-err" role="alert">
          {problem}
        </p>
      )}
      <p className="loc-hint">{hint}</p>
    </div>
  );
}
