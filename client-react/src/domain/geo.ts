/**
 * Location ranking.
 *
 * `priority_locations` is an ordered list of matching rules and **the index is
 * the rank** - first match wins. That is what lets someone define two tiers or
 * five: the list is already ordered, so ordering it again by a `tier` name was
 * both redundant and capped at the names the CSS happened to know. `tier` is
 * still accepted in stored config and still ignored here.
 *
 * Settings are passed in rather than read off a module global, which is the one
 * structural difference from client/public/index.html's version - there `geo()`
 * closes over `state`, so it cannot be tested without standing up the page.
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

/** Convenience for the common case of having the whole settings object to hand. */
export function geoOf(location: string | null | undefined, settings: Settings): GeoMatch | null {
  return geo(location, settings.priority_locations);
}
