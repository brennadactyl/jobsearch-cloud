/** A lead's place among the account's preferred locations, and the key that numbers them. */
import type { Settings } from "../api/schema";
import { tierColour, tierOf } from "../domain/geo";

export function GeoBadge({ row, settings }: { row: { area: string }; settings: Settings }) {
  const g = tierOf(row, settings);
  if (!g) return null;
  return <span className={`geo ${g.cssClass}`}>{g.label}</span>;
}

/** Numbered, because past two tiers colour alone doesn't say which outranks which. */
export function GeoKey({ settings }: { settings: Settings }) {
  return (
    <>
      {settings.areas.map((area, i) => (
        <span key={`${i}-${area}`}>
          <i style={{ background: tierColour(i) }} />
          {i + 1}. {area}
        </span>
      ))}
    </>
  );
}
