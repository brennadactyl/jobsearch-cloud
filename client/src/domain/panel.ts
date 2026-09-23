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

/**
 * The fields that can't be emptied, and the search whose is, or null. The
 * server refuses each of these too: a tab needs a name, and an empty roles line
 * is how the database says a search was never written up, so clearing it would
 * put the search back in front of the overnight run as one still to build.
 */
export function blankField(
  general: Partial<General>,
  searches: Record<string, Partial<SearchFields>>,
): { field: GeneralKey | "label" | "role_search_line"; search: string | null } | null {
  if (general.display_title !== undefined && !general.display_title) {
    return { field: "display_title", search: null };
  }
  for (const [search, fields] of Object.entries(searches)) {
    for (const field of ["label", "role_search_line"] as const) {
      if (fields[field] !== undefined && !fields[field]) return { field, search };
    }
  }
  return null;
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

