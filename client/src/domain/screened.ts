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

/**
 * Whether this tab is about a row: one a person's own settings rejected, or one
 * they removed themselves. Everything else arrives because it records a posting
 * that was once theirs - a delisted lead, a posting found dead after they had
 * it - and reading those here as something a rule rejected says the wrong thing
 * about them.
 *
 * A kind this page has never heard of is shown rather than hidden: a new rule
 * someone's settings caused is exactly what they came here to see, and silence
 * would be the worse way to be wrong.
 */
function isRejection(row: Screened): boolean {
  const known = SCREENED_KINDS.find((k) => k.kind === groupOf(row));
  return known ? known.mine === true : true;
}

/** The rejections a window holds, newest first, and the newest of a day in the order they were written. */
export function screenedWithin(rows: readonly Screened[], days: number, now: number): Screened[] {
  const start = windowStart(days, now);
  return rows
    .filter((r) => isRejection(r) && r.date >= start)
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
/** The group for a posting someone removed themselves; no kind, because no rule made it. */
export const HAND = "hand";

export const SCREENED_KINDS: readonly { kind: string; label: string; mine?: true }[] = [
  // `mine` is what this tab shows: a rejection someone's own settings caused,
  // or their own hand. The rest arrive because they record a posting that was
  // once theirs - which is what keeps the Overview's found-and-removed history
  // whole - and are none of this tab's business.
  { kind: "delisted", label: "Taken down after you saw it" },
  { kind: "dead", label: "Gone before you saw it" },
  { kind: "duplicate", label: "Already seen" },
  // Where, what and how senior are three different rejections, so each names
  // its own dimension: "out of scope" left someone asking which one it meant.
  { kind: "out-of-scope", label: "Outside your locations", mine: true },
  { kind: "wrong-level", label: "Not your level", mine: true },
  { kind: "wrong-role", label: "Different kind of work", mine: true },
  { kind: "contract", label: "Contract or temporary", mine: true },
  { kind: "pay-below-floor", label: "Below your pay floor", mine: true },
  { kind: "other", label: "Other", mine: true },
  // A posting the person took off their own board. It has no kind because no
  // rule produced it, but it isn't unclassified either - it is the one thing
  // here they decided themselves, and the only record of having done so.
  { kind: HAND, label: "You removed it", mine: true },
  // Never classified, and not written by them either: rows from before a run
  // said which rule caused each rejection, and rows whose author is unknown.
  { kind: "", label: "Not grouped" },
];

/**
 * Which group a row belongs to. The tab shows what someone's settings rejected
 * **and what they rejected themselves**, which is two rules rather than one: a
 * reader who simplifies this back to the kind alone drops their own decisions
 * into the unclassified pile.
 */
export function groupOf(row: Screened): string {
  return row.added_by === "hand" ? HAND : row.kind;
}

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
    const seen = urls.get(groupOf(row)) ?? new Set<string>();
    seen.add(key);
    urls.set(groupOf(row), seen);
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
