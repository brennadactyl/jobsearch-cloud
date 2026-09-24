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

/** How many rows each search has, by its key. A search with none is absent, not zero. */
export function countsBySearch(rows: readonly Screened[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.search] = (counts[row.search] ?? 0) + 1;
  return counts;
}

/**
 * Leads found in the same window: what the searches kept, against what they set
 * aside. Counted from `found`, which is the day a run recorded the lead, so a
 * lead moved along since still counts as kept.
 */
export function keptWithin(leads: readonly Lead[], days: number, now: number): number {
  const start = windowStart(days, now);
  return leads.filter((l) => l.found >= start).length;
}
