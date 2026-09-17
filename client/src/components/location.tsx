/** A lead's place among the account's preferred locations, and the key that numbers them. */
import type { Settings } from "../api/schema";
import { geo } from "../domain/geo";

export function GeoBadge({ location, settings }: { location: string; settings: Settings }) {
  const g = geo(location, settings.priority_locations);
  if (!g) return null;
  return <span className={`geo ${g.p}`}>{g.label}</span>;
}

/** Numbered, because past two tiers colour alone doesn't say which outranks which. */
export function GeoKey({ settings }: { settings: Settings }) {
  return (
    <>
      {settings.priority_locations.map((r, i) => (
        <span key={r.label}>
          <i style={{ background: i < 5 ? `var(--pri-${i})` : "var(--ink3)" }} />
          {i + 1}. {r.label}
        </span>
      ))}
    </>
  );
}
