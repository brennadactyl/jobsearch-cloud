/**
 * The account's place settings: the three lists and the note that say where
 * its searches look (docs/location-settings-plan.md). Each is stored as the
 * person typed it and the nightly search interprets it, so nothing here reads
 * a place; it only splits a list the one way every reader splits it.
 */
import { joinNames } from "./resumes";

/** The settings the Locations section edits, in the order it shows them. */
export const PLACE_KEYS = ["search_locations", "priority_locations", "excluded_locations", "location_note"] as const;
export type PlaceKey = (typeof PLACE_KEYS)[number];
export type Places = Record<PlaceKey, string>;

/**
 * The question each setting asks, in the words both screens ask it. Setup and
 * the account panel share these so a reword reaches both; their hints and
 * placeholders stay their own, because each screen says something the other
 * doesn't need to.
 */
export const PLACE_QUESTIONS: Readonly<Record<PlaceKey, string>> = {
  search_locations: "What locations should be searched?",
  priority_locations: "Which locations should come first?",
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
export function nowhereToSearch(searched: string, ranked: string): string {
  return listEntries(searched).length || listEntries(ranked).length
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

/** The edits that differ from what's stored, compared as the server stores them: trimmed at the ends. */
export function changedPlaces(stored: Places, draft: Partial<Places>): Partial<Places> {
  return Object.fromEntries(
    PLACE_KEYS.flatMap((k) => (draft[k] !== undefined && draft[k].trim() !== stored[k].trim() ? [[k, draft[k]]] : [])),
  );
}

/** What leaving now would lose from the Locations section, or "" when nothing would. */
export function unsavedPlacesSentence(changed: Partial<Places>): string {
  const keys = PLACE_KEYS.filter((k) => k in changed);
  if (!keys.length) return "";
  return `You changed ${joinNames(keys.map((k) => CALLED[k]))} but didn't save, so your searches keep the ones they use now.`;
}
