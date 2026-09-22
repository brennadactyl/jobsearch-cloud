/**
 * Location tiers. The ranked areas are "Which locations should come first?" in
 * order, and **the index is the rank**, so any number of tiers works.
 *
 * Settings are passed in rather than read from a global, so these are testable.
 */
import type { Settings } from "../api/schema";

/**
 * The colour of each tier, top tier first, as the stylesheet's own variables.
 * This list is how many tiers the page colours: `--pri-0` to `--pri-4` and the
 * `.pri0` to `.pri4` rules in tracker.css hold the same number, so a tier added
 * here is added there too.
 */
export const TIER_COLOURS = ["var(--pri-0)", "var(--pri-1)", "var(--pri-2)", "var(--pri-3)", "var(--pri-4)"];

/** What a rank past the coloured tiers is drawn in. */
export const UNTIERED_COLOUR = "var(--ink3)";

/** The colour for a rank, or the untiered grey past the coloured tiers. */
export function tierColour(rank: number): string {
  return TIER_COLOURS[rank] ?? UNTIERED_COLOUR;
}

/** Where a posting's location falls in the configured tiers. */
export interface LocationTier {
  /** CSS class for the tier stripe: pri0..pri4, or "" past the coloured tiers. */
  cssClass: string;
  label: string;
  /** 0 is the top tier. */
  rank: number;
}

export function tierCssClass(rank: number): string {
  return rank < TIER_COLOURS.length ? `pri${rank}` : "";
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
