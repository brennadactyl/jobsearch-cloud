/**
 * The account panel's Locations section: the three place lists and the note
 * that say where this account's searches look (docs/location-settings-plan.md).
 *
 * Each is kept as typed and the nightly search interprets it, so nothing here
 * is flagged or refused. The read-backs only show how the commas split each
 * list, and the ranked list's order and tier colours. Edits wait for the
 * panel's Save.
 */
import type { ReactNode } from "react";
import { listEntries, PLACE_QUESTIONS, type PlaceKey, type Places } from "../domain/places";
import { PlaceEntries, RankedPlaces } from "./location";

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
  const searched = listEntries(values.search_locations);
  const ruledOut = listEntries(values.excluded_locations);
  const ranked = listEntries(values.priority_locations);

  return (
    <section className="account-section" aria-labelledby="locTitle">
      <div>
        <h4 id="locTitle">Locations</h4>
        <p>Where your searches look. A change takes effect on each search's next run.</p>
      </div>

      <PlaceField
        {...field("search_locations")}
        placeholder="US, Greater Seattle area, Australia"
        hint="Every area the search should cover — name all of it, not only the part you'd prefer. The places you rank below are always searched too."
      >
        {/* Empty doesn't mean anywhere: the search looks only where the ranked list says. */}
        <PlaceEntries lead="Searched:" entries={searched} empty={ranked.length ? "Only the ranked places" : undefined} />
      </PlaceField>

      <PlaceField
        {...field("priority_locations")}
        placeholder="Seattle area, Portland OR, Remote US"
        hint="In order — the first is the one you want most. Anywhere you don't name still shows up, just lower."
      >
        <RankedPlaces entries={ranked} />
      </PlaceField>

      <PlaceField
        {...field("excluded_locations")}
        optional
        placeholder="Portland OR, Texas"
        hint="Optional, and only a rule-out: somewhere inside the searched area that you still couldn't take. It never narrows where the search looks on its own."
      >
        <PlaceEntries lead="Ruled out:" entries={ruledOut} />
      </PlaceField>

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
  placeholder,
  hint,
  value,
  changed,
  problem,
  onChange,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  multiline?: boolean;
  placeholder: string;
  hint: string;
  value: string;
  changed: boolean;
  problem: string;
  onChange: (value: string) => void;
  children?: ReactNode;
}) {
  const props = {
    id,
    placeholder,
    value,
    className: changed ? "changed" : undefined,
    "aria-invalid": problem ? true : undefined,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  };
  return (
    <div className="loc-field">
      <label htmlFor={id}>
        {label}
        {optional && <span className="loc-optional"> (optional)</span>}
        {changed && <span className="resume-changed"> Changed</span>}
      </label>
      {multiline ? <textarea rows={2} {...props} /> : <input type="text" {...props} />}
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
