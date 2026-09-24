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

/**
 * How each General question is asked. Setup asks all three of a person who has
 * no tracker yet, and asks them in these words: one question, one wording,
 * wherever it is asked.
 */
export const GENERAL_QUESTIONS: Readonly<Record<GeneralKey, string>> = {
  display_title: "What should this page be called?",
  pronouns: "How should a run write about you?",
  excluded_companies: "Companies you'd never work for",
};

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
export const SEARCH_KEYS = [
  "label",
  "role_search_line",
  "fit_clause",
  "fit_disqualifier",
  "pay_floor",
  "pay_floor_unit",
] as const;
export type SearchKey = (typeof SEARCH_KEYS)[number];

/** The three asked as prose, in the order the section asks them. */
export const PROSE_KEYS = ["role_search_line", "fit_clause", "fit_disqualifier"] as const;

/** What a pay floor's unit can be, and how each reads beside the amount. */
export const PAY_UNITS = [
  { value: "year", label: "a year" },
  { value: "hour", label: "an hour" },
] as const;

/**
 * What the unit shows on a search with no floor yet. A year is what almost
 * every stated salary is, so the question is answered before it's asked and
 * typing an amount is enough.
 */
export const DEFAULT_PAY_UNIT = "year";

/**
 * How each question about a search is asked. Setup asks three of these too, of
 * a search it is building, and asks them in these words: a question worded one
 * way at setup and another in the panel reads as two different questions about
 * the same answer. The hints differ, because the situations do.
 */
export const SEARCH_QUESTIONS: Readonly<Record<SearchKey, string>> = {
  label: "What this search is called",
  role_search_line: "What roles should this search look for?",
  fit_clause: "What makes a posting worth keeping?",
  fit_disqualifier: "What rules a posting out?",
  pay_floor: "Lowest acceptable pay",
  // The select beside the amount, which has no visible label of its own.
  pay_floor_unit: "Is that a year or an hour?",
};
export type SearchFields = Record<SearchKey, string>;
/**
 * What one search's save carries: its prose fields, and whether it runs at all.
 * `paused` is the wish, never a time - the server stamps the instant, and a
 * search already paused keeps the instant it carries.
 */
export type SearchEdit = Partial<SearchFields> & { paused?: boolean };
/** The edits in hand, by search key: only what someone has touched. */
export type SearchDraft = Readonly<Record<string, SearchEdit>>;

/** What differs from what's stored, per search, as the save route takes it. */
export function changedSearches(tracks: readonly Track[], draft: SearchDraft): Record<string, SearchEdit> {
  const changed: Record<string, SearchEdit> = {};
  for (const track of tracks) {
    const edits = draft[track.key];
    if (!edits) continue;
    const fields: SearchEdit = { ...payEdit(track, edits) };
    for (const key of SEARCH_KEYS) {
      if (key === "pay_floor" || key === "pay_floor_unit") continue;
      const value = edits[key];
      if (value !== undefined && value.trim() !== track[key].trim()) fields[key] = value.trim();
    }
    if (edits.paused !== undefined && edits.paused !== Boolean(track.paused)) fields.paused = edits.paused;
    if (Object.keys(fields).length) changed[track.key] = fields;
  }
  return changed;
}

/**
 * The pay floor a save should carry, which is the pair or neither. A unit alone
 * says nothing, so it is stored only against an amount and goes when the amount
 * goes; an amount typed against the unit shown stores that unit, which is why a
 * search with no floor shows a year rather than an empty choice.
 */
function payEdit(track: Track, edits: SearchEdit): Partial<SearchFields> {
  if (edits.pay_floor === undefined && edits.pay_floor_unit === undefined) return {};
  const amount = (edits.pay_floor ?? track.pay_floor).trim();
  const unit = amount ? edits.pay_floor_unit ?? (track.pay_floor_unit || DEFAULT_PAY_UNIT) : "";
  const pay: Partial<SearchFields> = {};
  if (amount !== track.pay_floor.trim()) pay.pay_floor = amount;
  if (unit !== track.pay_floor_unit) pay.pay_floor_unit = unit;
  return pay;
}

/**
 * The fields that can't be emptied, and the search whose is, or null. The
 * server refuses each of these too: a tab needs a name, and an empty roles line
 * is how the database says a search was never written up, so clearing it would
 * put the search back in front of the overnight run as one still to build.
 */
export function blankField(
  general: Partial<General>,
  searches: Record<string, SearchEdit>,
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
export function unsavedAccountSentence(general: Partial<General>, searches: Record<string, SearchEdit>): string {
  const named = GENERAL_KEYS.filter((k) => k in general).map((k) => CALLED[k]);
  const entries = Object.values(searches);
  // A pause and a pay floor are named apart: "what a search looks for" would
  // not tell someone they are about to lose a search they meant to stop, or the
  // number they just set.
  const isPay = (k: string) => k === "pay_floor" || k === "pay_floor_unit";
  const fields = entries.filter((e) => SEARCH_KEYS.some((k) => k in e && !isPay(k))).length;
  const pays = entries.filter((e) => Object.keys(e).some(isPay)).length;
  const pauses = entries.filter((e) => e.paused !== undefined).length;
  if (fields) named.push(fields === 1 ? "what a search looks for" : `what ${fields} searches look for`);
  if (pays) named.push(pays === 1 ? "the lowest pay a search takes" : `the lowest pay ${pays} searches take`);
  if (pauses) named.push(pauses === 1 ? "whether a search runs" : `whether ${pauses} searches run`);
  if (!named.length) return "";
  return `You changed ${joinNames(named)} but didn't save, so they stay as they are.`;
}

