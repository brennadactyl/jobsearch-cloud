/**
 * `priority_locations` is an ordered list of rules and **the index is the
 * rank** - first match wins, so any number of tiers works. A stored `tier` name
 * is accepted and ignored.
 *
 * Settings are passed in rather than read from a global, so these are testable.
 */
import type { Lead, PriorityLocation } from "../api/schema";

/** How many tiers the stylesheet colours: `.pri0` to `.pri4` in tracker.css. */
export const TIER_CLASS_COUNT = 5;

/** Where a posting's location falls in the configured tiers. */
export interface LocationTier {
  /** CSS class for the tier stripe: pri0..pri4, or "" past the coloured tiers. */
  cssClass: string;
  label: string;
  /** 0 is the top tier. */
  rank: number;
}

export function tierCssClass(rank: number): string {
  return rank < TIER_CLASS_COUNT ? `pri${rank}` : "";
}

export function matchLocationTier(
  location: string | null | undefined,
  rules: readonly PriorityLocation[],
): LocationTier | null {
  const loc = String(location ?? "").toLowerCase();
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (r.allOf && !r.allOf.every((s) => loc.includes(s))) continue;
    if (r.anyOf && !r.anyOf.some((s) => loc.includes(s))) continue;
    return { cssClass: tierCssClass(i), label: r.label, rank: i };
  }
  return null;
}

/** Rank for sorting. Unmatched locations sort last, not first. */
export function tierRank(l: Pick<Lead, "location">, rules: readonly PriorityLocation[]): number {
  const tier = matchLocationTier(l.location, rules);
  return tier ? tier.rank : 999;
}
