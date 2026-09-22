/**
 * What the account panel edits besides places and resumes: what the page is
 * called, how a run writes about the person, the companies ruled out, and each
 * search's name (docs/account-settings-plan.md).
 *
 * All of it is stored as sent and true the moment it saves, so these rules only
 * say what differs from what's stored and what leaving would lose.
 */
import type { Settings, Track } from "../api/schema";
import { joinNames } from "./resumes";

/** The part of the settings the General section edits. */
export type General = Pick<Settings, "display_title" | "pronouns" | "excluded_companies">;

export const GENERAL_KEYS = ["display_title", "pronouns", "excluded_companies"] as const;
export type GeneralKey = (typeof GENERAL_KEYS)[number];

/** What each setting is called in the sentence about leaving without saving. */
const CALLED: Readonly<Record<GeneralKey, string>> = {
  display_title: "what this page is called",
  pronouns: "how a run writes about you",
  excluded_companies: "the companies you'd never work for",
};

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The edits that differ from what's stored, compared as the server stores them: trimmed, blanks dropped. */
export function changedGeneral(stored: General, draft: Partial<General>): Partial<General> {
  const changed: Partial<General> = {};
  if (draft.display_title !== undefined && draft.display_title.trim() !== stored.display_title.trim()) {
    changed.display_title = draft.display_title.trim();
  }
  if (draft.pronouns !== undefined && draft.pronouns !== stored.pronouns) changed.pronouns = draft.pronouns;
  if (draft.excluded_companies) {
    const kept = draft.excluded_companies.map((c) => c.trim()).filter(Boolean);
    if (!sameList(kept, stored.excluded_companies)) changed.excluded_companies = kept;
  }
  return changed;
}

/** The searches whose name differs from the stored one, as the save route takes them. */
export function changedLabels(
  tracks: readonly Track[],
  draft: Readonly<Record<string, string>>,
): Record<string, { label: string }> {
  const changed: Record<string, { label: string }> = {};
  for (const track of tracks) {
    const name = draft[track.key];
    if (name !== undefined && name.trim() !== track.label.trim()) changed[track.key] = { label: name.trim() };
  }
  return changed;
}

/** Why a save would be refused before it is sent, or "": the server refuses these too. */
export function blankName(general: Partial<General>, labels: Record<string, { label: string }>): GeneralKey | "label" | "" {
  if (general.display_title !== undefined && !general.display_title) return "display_title";
  return Object.values(labels).some((s) => !s.label) ? "label" : "";
}

/** What leaving now would lose from General and Searches, or "" when nothing would. */
export function unsavedAccountSentence(
  general: Partial<General>,
  labels: Record<string, { label: string }>,
): string {
  const named = GENERAL_KEYS.filter((k) => k in general).map((k) => CALLED[k]);
  const renamed = Object.keys(labels).length;
  if (renamed) named.push(renamed === 1 ? "a search's name" : `${renamed} searches' names`);
  if (!named.length) return "";
  return `You changed ${joinNames(named)} but didn't save, so they stay as they are.`;
}
