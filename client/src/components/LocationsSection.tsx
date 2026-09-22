/**
 * The account panel's Locations section: the three place lists and the note
 * that say where this account's searches look (docs/location-settings-plan.md).
 *
 * Each place is kept as typed and the nightly search interprets it, so nothing
 * here is flagged or refused. Edits wait for the panel's Save.
 */
import { listEntries, PLACE_QUESTIONS, type PlaceKey, type Places } from "../domain/places";
import PlaceChips from "./PlaceChips";

export default function LocationsSection({
  values,
  changed,
  problem,
  saved,
  onChange,
}: {
  /** What each field shows: the edit where there is one, else what's stored. */
  values: Places;
  /** The settings whose edit differs from what's stored. */
  changed: ReadonlySet<PlaceKey>;
  /** A refused save's message, beside the setting it names. */
  problem: { field: PlaceKey; message: string } | null;
  /** The last Save changed a place setting. */
  saved: boolean;
  onChange: (key: PlaceKey, value: string) => void;
}) {
  const field = (key: PlaceKey) => ({
    id: `loc-${key}`,
    label: PLACE_QUESTIONS[key],
    value: values[key],
    changed: changed.has(key),
    problem: problem?.field === key ? problem.message : "",
    onChange: (value: string) => onChange(key, value),
  });

  return (
    <section className="account-section" aria-labelledby="locTitle">
      <div>
        <h4 id="locTitle">Locations</h4>
        <p>Where your searches look. A change takes effect on each search's next run.</p>
      </div>

      <PlaceField
        {...field("search_locations")}
        placeholder="Add a place, then press Enter"
        hint="Every area the search should cover — name all of it, not only the part you'd prefer. The places you rank below are always searched too."
        // Empty doesn't mean anywhere: the search looks only where the ranked list says.
        empty="Only the ranked places"
      />

      <PlaceField
        {...field("priority_locations")}
        placeholder="Add a place, then press Enter"
        ranked
        hint="In order — the first is the one you want most. The arrows move a place up or down. Anywhere you don't name still shows up, just lower."
      />

      <PlaceField
        {...field("excluded_locations")}
        optional
        placeholder="Add a place, then press Enter"
        hint="Optional, and only a rule-out: somewhere inside the searched area that you still couldn't take. It never narrows where the search looks on its own."
      />

      <PlaceField
        {...field("location_note")}
        optional
        multiline
        placeholder="Open to relocating for the right team."
        hint="Anything a list can't say. The search reads it as context."
      />

      {saved && (
        <div className="loc-saved" role="status">
          Saved. Your next run uses these places.
        </div>
      )}
    </section>
  );
}

function PlaceField({
  id,
  label,
  optional = false,
  multiline = false,
  ranked = false,
  empty = "",
  placeholder,
  hint,
  value,
  changed,
  problem,
  onChange,
}: {
  id: string;
  label: string;
  optional?: boolean;
  /** The note, which is prose rather than a list. */
  multiline?: boolean;
  ranked?: boolean;
  empty?: string;
  placeholder: string;
  hint: string;
  value: string;
  changed: boolean;
  problem: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="loc-field">
      {/* The tags sit outside the label: a label whose text changes as you type
          is a different label to anything reading the page. */}
      <div className="loc-label">
        <label htmlFor={id}>{label}</label>
        {optional && <span className="loc-optional">(optional)</span>}
        {changed && <span className="resume-changed">Changed</span>}
      </div>
      {multiline ? (
        <textarea
          id={id}
          rows={2}
          placeholder={placeholder}
          value={value}
          className={changed ? "changed" : undefined}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <PlaceChips
          id={id}
          entries={listEntries(value)}
          onChange={(entries) => onChange(entries.join(", "))}
          placeholder={placeholder}
          ranked={ranked}
          invalid={!!problem}
          empty={empty}
        />
      )}
      {problem && (
        <p className="loc-err" role="alert">
          {problem}
        </p>
      )}
      <p className="loc-hint">{hint}</p>
    </div>
  );
}
