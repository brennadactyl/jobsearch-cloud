/**
 * A list edited as chips: one chip per entry, an × to drop one, and a box that
 * adds one. The places use it (docs/location-settings-plan.md), and so do the
 * companies a person rules out.
 *
 * A chip is only how a list is edited; what's stored is unchanged. A ranked
 * list keeps its order, so its chips carry their rank and tier colour and move
 * with the arrows beside them.
 */
import { useState, type KeyboardEvent } from "react";
import { tierColour } from "../domain/geo";
import { listEntries } from "../domain/places";

export default function PlaceChips({
  id,
  entries,
  onChange,
  placeholder,
  ranked = false,
  splitOnComma = false,
  invalid = false,
  empty = "",
}: {
  id: string;
  entries: readonly string[];
  onChange: (entries: string[]) => void;
  placeholder: string;
  /** A ranked list is ordered, so each chip shows its place and can be moved. */
  ranked?: boolean;
  /**
   * The exception, for a list still carried as one comma-joined string: a typed
   * comma ends the entry, because one inside a name would be split back out on
   * the way to storage whatever this box did. Intake is the last of these.
   */
  splitOnComma?: boolean;
  invalid?: boolean;
  /** What an empty list means, said in place of the chips. */
  empty?: string;
}) {
  const [draft, setDraft] = useState("");

  const set = (next: readonly string[]) => onChange([...next]);
  // A comma is an ordinary character in a place's name - "Vancouver, BC" is one
  // place - so by default the box keeps what was typed and Enter is what says
  // "that's one". Where the list is still carried as one joined string, the
  // caller asks for the old splitting instead, because an entry holding a comma
  // could not survive the journey anyway.
  const add = () => {
    const added = splitOnComma ? listEntries(draft) : [draft.trim()].filter(Boolean);
    setDraft("");
    if (added.length) {
      set([...entries, ...added]);
    }
  };
  const remove = (i: number) => set(entries.filter((_, j) => j !== i));
  const move = (i: number, by: number) => {
    const next = [...entries];
    const [moved] = next.splice(i, 1);
    next.splice(i + by, 0, moved);
    set(next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter would otherwise send the form this sits in. A comma only ends an
    // entry where the list is still joined into one string; everywhere else it
    // is a character someone is typing into a name.
    if (e.key === "Enter" || (splitOnComma && e.key === ",")) {
      e.preventDefault();
      add();
    }
  };

  const chip = (place: string, i: number) => (
    <span className="place-chip" key={`${i}-${place}`}>
      {ranked && (
        <>
          <span className="place-chip-rank">{i + 1}</span>
          <i style={{ background: tierColour(i) }} />
        </>
      )}
      <span className="place-chip-text">{place}</span>
      {ranked && (
        <span className="place-chip-move">
          <button type="button" aria-label={`Move ${place} up`} disabled={i === 0} onClick={() => move(i, -1)}>
            ↑
          </button>
          <button
            type="button"
            aria-label={`Move ${place} down`}
            disabled={i === entries.length - 1}
            onClick={() => move(i, 1)}
          >
            ↓
          </button>
        </span>
      )}
      <button type="button" className="place-chip-x" aria-label={`Remove ${place}`} onClick={() => remove(i)}>
        ✕
      </button>
    </span>
  );

  return (
    <div className="place-chips">
      {entries.length > 0 && <div className={ranked ? "place-chip-row ranked" : "place-chip-row"}>{entries.map(chip)}</div>}
      {entries.length === 0 && empty && <div className="place-chips-empty">{empty}</div>}
      <input
        id={id}
        type="text"
        value={draft}
        placeholder={placeholder}
        aria-invalid={invalid ? true : undefined}
        className={invalid ? "invalid" : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        // Added on the way out too: leaving a typed place in the box and saving
        // would drop it without saying so.
        onBlur={add}
      />
    </div>
  );
}
