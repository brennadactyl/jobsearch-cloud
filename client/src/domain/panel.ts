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

/** What the Searches section edits about one search. */
export const SEARCH_KEYS = ["label", "role_search_line", "fit_clause", "fit_disqualifier"] as const;
export type SearchKey = (typeof SEARCH_KEYS)[number];
export type SearchFields = Record<SearchKey, string>;
/** The edits in hand, by search key: only the fields someone has touched. */
export type SearchDraft = Readonly<Record<string, Partial<SearchFields>>>;

/** The fields of each search that differ from what's stored, as the save route takes them. */
export function changedSearches(tracks: readonly Track[], draft: SearchDraft): Record<string, Partial<SearchFields>> {
  const changed: Record<string, Partial<SearchFields>> = {};
  for (const track of tracks) {
    const edits = draft[track.key];
    if (!edits) continue;
    const fields: Partial<SearchFields> = {};
    for (const key of SEARCH_KEYS) {
      const value = edits[key];
      if (value !== undefined && value.trim() !== track[key].trim()) fields[key] = value.trim();
    }
    if (Object.keys(fields).length) changed[track.key] = fields;
  }
  return changed;
}

/** Why a save would be refused before it is sent, or "": the server refuses these too. */
export function blankName(
  general: Partial<General>,
  searches: Record<string, Partial<SearchFields>>,
): GeneralKey | "label" | "" {
  if (general.display_title !== undefined && !general.display_title) return "display_title";
  return Object.values(searches).some((s) => s.label !== undefined && !s.label) ? "label" : "";
}

/** What leaving now would lose from General and Searches, or "" when nothing would. */
export function unsavedAccountSentence(
  general: Partial<General>,
  searches: Record<string, Partial<SearchFields>>,
): string {
  const named = GENERAL_KEYS.filter((k) => k in general).map((k) => CALLED[k]);
  const count = Object.keys(searches).length;
  if (count) named.push(count === 1 ? "what a search looks for" : `what ${count} searches look for`);
  if (!named.length) return "";
  return `You changed ${joinNames(named)} but didn't save, so they stay as they are.`;
}

/**
 * What a search's own words will cost it, said beside the field and never
 * blocking a save. Each is a way of writing that a night reads differently
 * from how a person meant it (docs/search-fields-plan.md).
 */
export function searchWarnings(fields: SearchFields, places: readonly string[]): Partial<Record<SearchKey, string>> {
  const warnings: Partial<Record<SearchKey, string>> = {};

  if (!fields.role_search_line.trim()) {
    warnings.role_search_line = "With this empty, the search looks for “roles matching the resume”, which is wider than it sounds.";
  }

  // A test a posting either passes or fails, written as a preference, screens
  // out almost everything and reports a quiet night.
  for (const key of ["fit_clause", "fit_disqualifier"] as const) {
    if (/\b(prefer(?:ably|red)?|ideally|nice to have|bonus|would like|strong(?:ly)? prefer)\b/i.test(fields[key])) {
      warnings[key] = "This reads as a preference. Each one has to be something a posting either is or isn't, or it screens out almost everything.";
    }
  }

  if (/^\s*(look|search)\s+for\b|^\s*find\b/i.test(fields.fit_clause)) {
    warnings.fit_clause =
      "This reads as a search. It's a test applied to a posting already found — what to look for goes in the roles above.";
  }

  // The location lists are where a place is said; a second copy drifts.
  for (const key of ["fit_clause", "fit_disqualifier"] as const) {
    const named = places.find((place) => place && new RegExp(`\\b${escapeForRegExp(place)}\\b`, "i").test(fields[key]));
    if (named && !warnings[key]) {
      warnings[key] = `“${named}” is already in your locations. Saying it here too means two copies of one rule, which drift apart.`;
    }
  }

  return warnings;
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
