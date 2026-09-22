/** A lead's place among the account's preferred locations, and the key that numbers them. */
import type { Settings } from "../api/schema";
import { tierColour, tierOf } from "../domain/geo";

export function GeoBadge({ row, settings }: { row: { area: string }; settings: Settings }) {
  const g = tierOf(row, settings);
  if (!g) return null;
  return <span className={`geo ${g.cssClass}`}>{g.label}</span>;
}

/** Ranked places as numbered, colour-dotted entries - what both the legend and the read-back show. */
function NumberedPlaces({ entries }: { entries: readonly string[] }) {
  return (
    <>
      {entries.map((place, i) => (
        <span key={`${i}-${place}`}>
          <i style={{ background: tierColour(i) }} />
          {i + 1}. {place}
        </span>
      ))}
    </>
  );
}

/**
 * A ranked list's read-back, as the legend on the leads will show it: each
 * entry exactly as typed, with its rank and tier colour.
 */
export function RankedPlaces({ entries }: { entries: readonly string[] }) {
  if (!entries.length) return null;
  return (
    <div className="key loc-ranked">
      <NumberedPlaces entries={entries} />
    </div>
  );
}

/** An unranked list as the commas split it, so a person sees how it was read. `empty` says what an empty one means. */
export function PlaceEntries({ lead, entries, empty }: { lead: string; entries: readonly string[]; empty?: string }) {
  if (!entries.length && !empty) return null;
  return (
    <div className="loc-entries">
      <span>{lead}</span>
      {entries.length ? (
        entries.map((e, i) => (
          <span className="loc-entry" key={`${i}-${e}`}>
            {e}
          </span>
        ))
      ) : (
        <span className="loc-empty">{empty}</span>
      )}
    </div>
  );
}

/** Numbered, because past two tiers colour alone doesn't say which outranks which. */
export function GeoKey({ settings }: { settings: Settings }) {
  return <NumberedPlaces entries={settings.areas} />;
}
