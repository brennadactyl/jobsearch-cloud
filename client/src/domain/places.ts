/**
 * The account's place settings: the three lists and the note that say where
 * its searches look (docs/location-settings-plan.md). Each is stored as the
 * person typed it and the nightly search interprets it, so nothing here reads
 * a place; it only splits a list the one way every reader splits it.
 */
import { joinNames } from "./resumes";

/**
 * The three lists, which are entries rather than text: a place is one entry
 * however many commas are in its name, so "Vancouver, BC" is one of these and
 * not two. The note is left out because it is a sentence.
 */
export const PLACE_LIST_KEYS = ["search_locations", "priority_locations", "excluded_locations"] as const;
export type PlaceListKey = (typeof PLACE_LIST_KEYS)[number];

/** The settings the Locations section edits, in the order it shows them. */
export const PLACE_KEYS = [...PLACE_LIST_KEYS, "location_note"] as const;
export type PlaceKey = (typeof PLACE_KEYS)[number];

export interface Places {
  search_locations: string[];
  priority_locations: string[];
  excluded_locations: string[];
  /** Prose, not a list: one sentence about where they'd work. */
  location_note: string;
}

export function isPlaceList(key: PlaceKey): key is PlaceListKey {
  return key !== "location_note";
}

/**
 * The question each setting asks, in the words both screens ask it. Setup and
 * the account panel share these so a reword reaches both; their hints and
 * placeholders stay their own, because each screen says something the other
 * doesn't need to.
 */
export const PLACE_QUESTIONS: Readonly<Record<PlaceKey, string>> = {
  search_locations: "What locations should be searched?",
  priority_locations: "What locations should the search prioritize?",
  excluded_locations: "Anywhere you can't take a job?",
  location_note: "Anything else about where you'd work?",
};

/**
 * A list's entries, in order: its text split on commas, each trimmed, empties
 * dropped. The server and tracker.ps1 split the same way, so a lead's area
 * names one of the ranked list's entries exactly as it's spelled here.
 */
export function listEntries(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Why the places can't be sent, or "": a search needs somewhere to look, and
 * the ranked places alone are enough, since they're always searched. The
 * server refuses both lists empty; this says so before sending.
 */
export function nowhereToSearch(searched: readonly string[], ranked: readonly string[]): string {
  return searched.length || ranked.length
    ? ""
    : "Say what locations should be searched, or rank some places first — the search needs somewhere to look.";
}

/** What each setting is called in the sentence about leaving without saving. */
const CALLED: Readonly<Record<PlaceKey, string>> = {
  search_locations: "the places searched",
  excluded_locations: "the places ruled out",
  priority_locations: "the places ranked first",
  location_note: "your note about where you'd work",
};

/** Whether two lists hold the same entries in the same order. A ranked list's order is its meaning. */
function sameEntries(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry === b[i]);
}

/** The edits that differ from what's stored: a list entry by entry, the note trimmed at the ends. */
export function changedPlaces(stored: Places, draft: Partial<Places>): Partial<Places> {
  const out: Partial<Places> = {};
  for (const k of PLACE_KEYS) {
    if (isPlaceList(k)) {
      const edit = draft[k];
      if (edit !== undefined && !sameEntries(edit, stored[k])) {
        out[k] = edit;
      }
    }
    else {
      const edit = draft[k];
      if (edit !== undefined && edit.trim() !== stored[k].trim()) {
        out[k] = edit;
      }
    }
  }
  return out;
}

/** What leaving now would lose from the Locations section, or "" when nothing would. */
export function unsavedPlacesSentence(changed: Partial<Places>): string {
  const keys = PLACE_KEYS.filter((k) => k in changed);
  if (!keys.length) {
    return "";
  }
  return `You changed ${joinNames(keys.map((k) => CALLED[k]))} but didn't save, so your searches keep the ones they use now.`;
}
