/**
 * `priority_locations` is an ordered list of rules and **the index is the
 * rank** - first match wins, so any number of tiers works. A stored `tier` name
 * is accepted and ignored.
 *
 * Settings are passed in rather than read from a global, so these are testable.
 */
import type { Lead, PriorityLocation, Settings } from "../api/schema";

export interface GeoMatch {
  /** CSS class for the tier stripe: pri0..pri4. */
  p: string;
  label: string;
  /** Rank. 0 is the top tier. */
  i: number;
}

export function priClass(i: number): string {
  return i < 5 ? `pri${i}` : "";
}

export function geo(location: string | null | undefined, rules: readonly PriorityLocation[]): GeoMatch | null {
  const loc = String(location ?? "").toLowerCase();
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (r.allOf && !r.allOf.every((s) => loc.includes(s))) continue;
    if (r.anyOf && !r.anyOf.some((s) => loc.includes(s))) continue;
    return { p: priClass(i), label: r.label, i };
  }
  return null;
}

/** Rank for sorting. Unmatched locations sort last, not first. */
export function rank(l: Pick<Lead, "location">, rules: readonly PriorityLocation[]): number {
  const g = geo(l.location, rules);
  return g ? g.i : 999;
}

export function geoOf(location: string | null | undefined, settings: Settings): GeoMatch | null {
  return geo(location, settings.priority_locations);
}
