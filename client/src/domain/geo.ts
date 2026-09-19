/**
 * Location tiers. The ranked areas are "Which locations should come first?" in
 * order, and **the index is the rank**, so any number of tiers works.
 *
 * Settings are passed in rather than read from a global, so these are testable.
 */
import type { Settings } from "../api/schema";

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

/** What tiering a row needs from settings. */
export type TierSettings = Pick<Settings, "areas">;

/**
 * A lead's or application's tier: its area's position in the ranked list. The
 * nightly search places each row in an area, so the page matches no towns: a
 * row with no area, or one whose area is no longer ranked, has no tier.
 */
export function tierOf(row: { area: string }, settings: TierSettings): LocationTier | null {
  const rank = row.area ? settings.areas.indexOf(row.area) : -1;
  return rank < 0 ? null : { cssClass: tierCssClass(rank), label: settings.areas[rank], rank };
}

/** Rank for sorting. A row with no tier sorts last, not first. */
export function tierRank(row: { area: string }, settings: TierSettings): number {
  return tierOf(row, settings)?.rank ?? 999;
}
