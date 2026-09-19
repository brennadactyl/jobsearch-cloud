/** A lead's place among the account's preferred locations, and the key that numbers them. */
import type { Settings } from "../api/schema";
import { tierOf } from "../domain/geo";

export function GeoBadge({ row, settings }: { row: { area: string }; settings: Settings }) {
  const g = tierOf(row, settings);
  if (!g) return null;
  return <span className={`geo ${g.cssClass}`}>{g.label}</span>;
}

const TIER_COLOURS = ["var(--pri-0)", "var(--pri-1)", "var(--pri-2)", "var(--pri-3)", "var(--pri-4)"];

/**
 * A ranked list's read-back, as the legend on the leads will show it: each
 * entry exactly as typed, with its rank and tier colour.
 */
export function RankedPlaces({ entries }: { entries: readonly string[] }) {
  if (!entries.length) return null;
  return (
    <div className="key loc-ranked">
      {entries.map((place, i) => (
        <span key={`${i}-${place}`}>
          <i style={{ background: TIER_COLOURS[i] ?? "var(--ink3)" }} />
          {i + 1}. {place}
        </span>
      ))}
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
  return (
    <>
      {settings.areas.map((area, i) => (
        <span key={area}>
          <i style={{ background: i < 5 ? `var(--pri-${i})` : "var(--ink3)" }} />
          {i + 1}. {area}
        </span>
      ))}
    </>
  );
}
