/**
 * The postings a search looked at and didn't keep. Every one is stored with the
 * sentence its run wrote, and `GET /api/data` already sends them; nothing here
 * reads those words - a reason is prose, and no two are worded alike, so the
 * page shows each as written and counts only what it can count: rows, searches
 * and dates.
 */
import type { Lead, Screened } from "../api/schema";
import { isoDay } from "./format";

/**
 * The tab id for the cross-search list. An id, not a track key, like
 * "dashboard" and ALL_LEADS.
 */
export const SCREENED = "screened";

/**
 * The Screened tab showing one search. The search rides in the URL so a run
 * stamp's count can link straight to what that night set aside, and so the view
 * is one someone can come back to.
 */
export function pathForSearch(search: string): string {
  return search ? `/screened?search=${encodeURIComponent(search)}` : "/screened";
}

/** How far back the list looks. 0 is everything, and is last for that reason. */
export const SCREENED_WINDOWS: readonly { days: number; label: string }[] = [
  { days: 7, label: "the last 7 days" },
  { days: 30, label: "the last 30 days" },
  { days: 90, label: "the last 90 days" },
  { days: 0, label: "everything" },
];

/**
 * The earliest date a window includes, or "" for all of them. Compared as bare
 * dates, never as instants: `date` is the run's own local day, and giving it a
 * time would move it a day west of UTC.
 */
export function windowStart(days: number, now: number): string {
  return days ? isoDay(new Date(now - (days - 1) * 86_400_000)) : "";
}

/** The rows a window holds, newest first, and the newest of a day in the order they were written. */
export function screenedWithin(rows: readonly Screened[], days: number, now: number): Screened[] {
  const start = windowStart(days, now);
  return rows
    .filter((r) => r.date >= start)
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}

/**
 * The kinds of rejection, in the order the run decides between them
 * (SCREENED_KINDS in server/src/validate.js), and how each is said on the page.
 * The order is the answer to "what is this rule costing me": a posting that was
 * the wrong level anyway is counted there rather than against the pay floor, so
 * what is left under the floor is what the floor alone cost.
 */
export const SCREENED_KINDS: readonly { kind: string; label: string }[] = [
  { kind: "delisted", label: "Taken down after you saw it" },
  { kind: "dead", label: "Already gone when it was read" },
  { kind: "duplicate", label: "The same posting again" },
  { kind: "out-of-scope", label: "Outside what you're looking for" },
  { kind: "wrong-level", label: "Wrong level for you" },
  { kind: "wrong-role", label: "Not the kind of role" },
  { kind: "contract", label: "Contract, not permanent" },
  { kind: "pay-below-floor", label: "Below the pay you'd take" },
  { kind: "other", label: "Something else" },
  { kind: "", label: "Not sorted yet" },
];

/**
 * How many postings each kind holds, counted by url: a posting re-listed under
 * a new url is two rows and two postings, and nothing here guesses that two
 * spellings of a company and a title are one job. Kinds with none are left out.
 */
export function countsByKind(rows: readonly Screened[]): { kind: string; label: string; postings: number }[] {
  const urls = new Map<string, Set<string>>();
  for (const row of rows) {
    // A row with no url is its own posting: there is nothing to match it on.
    const key = row.url || `#${row.id}`;
    const seen = urls.get(row.kind) ?? new Set<string>();
    seen.add(key);
    urls.set(row.kind, seen);
  }
  return SCREENED_KINDS.filter(({ kind }) => urls.has(kind)).map(({ kind, label }) => ({
    kind,
    label,
    postings: urls.get(kind)!.size,
  }));
}

/** How many rows each search has, by its key. A search with none is absent, not zero. */
export function countsBySearch(rows: readonly Screened[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.search] = (counts[row.search] ?? 0) + 1;
  return counts;
}

/**
 * Leads found in the same window: what was kept, against what was set aside.
 * Counted from `found`, the day a run recorded the lead, so one moved along
 * since still counts as kept. Narrowed to one search when the list is, or the
 * two halves of the comparison would be counting different searches.
 */
export function keptWithin(leads: readonly Lead[], days: number, now: number, search = ""): number {
  const start = windowStart(days, now);
  return leads.filter((l) => l.found >= start && (!search || l.search === search)).length;
}
