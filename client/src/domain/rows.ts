import type { Application, Lead, PriorityLocation } from "../api/schema";
import { safeUrl } from "./format";
import { tierRank } from "./geo";
import { isWaiting, lastMoved } from "./stages";

type Compare<T> = (a: T, b: T) => number;

/** Text order by one field, or its reverse. A missing value compares as "". */
function byText<T>(of: (row: T) => unknown, desc = false): Compare<T> {
  return (a, b) => String(of(desc ? b : a)).localeCompare(String(of(desc ? a : b)));
}

/** Smallest number first. */
function byNumber<T>(of: (row: T) => number): Compare<T> {
  return (a, b) => of(a) - of(b);
}

/** The rows this matches go first, whatever the comparators after it say. */
function first<T>(matches: (row: T) => boolean): Compare<T> {
  return (a, b) => (matches(a) ? 0 : 1) - (matches(b) ? 0 : 1);
}

/** The rows this matches go last, the same way. */
function last<T>(matches: (row: T) => boolean): Compare<T> {
  return first((row: T) => !matches(row));
}

/** The first comparator that doesn't tie decides. */
function inOrder<T>(...steps: Compare<T>[]): Compare<T> {
  return (a, b) => {
    for (const step of steps) {
      const d = step(a, b);
      if (d) return d;
    }
    return 0;
  };
}

// A Map, not an object: a sort key arrives from the stored view preferences, and
// a lookup in an object would answer names like "constructor" with a function.
const LEAD_SORTS = new Map<string, Compare<Lead>>([
  ["found-desc", byText((l) => l.found, true)],
  ["found-asc", byText((l) => l.found)],
  ["location-asc", byText((l) => l.location)],
  ["company-asc", byText((l) => l.company)],
]);

/**
 * "priority", the default, sinks "Not a fit" to the bottom, then orders by
 * location rank, then newest-found. The other sorts are exactly what they say.
 */
export function leadComparator(sortKey: string, rules: readonly PriorityLocation[]): Compare<Lead> {
  return (
    LEAD_SORTS.get(sortKey) ??
    inOrder<Lead>(
      last((l) => l.status === "Not a fit"),
      byNumber((l) => tierRank(l, rules)),
      byText((l) => l.found, true),
    )
  );
}

/**
 * Applications have no location or "found" date to sort by - just when you
 * applied and who to.
 */
export function appComparator(sortKey: string): Compare<Application> {
  if (sortKey === "company-asc") return byText((a) => a.company);
  if (sortKey === "location-asc") {
    return inOrder<Application>(
      // A hand-added application can have no location, and "" would sort first
      // in the sort that asks about location, so blanks sink.
      last((a) => !a.location),
      byText((a) => a.location),
    );
  }
  if (sortKey === "waiting-desc") {
    // The Overview's waiting list, in full: rows still waiting on the company
    // first, the one that last moved longest ago at the top. Rows with no date
    // to measure from, and rows the company has closed, follow.
    return inOrder<Application>(
      byNumber(waitGroup),
      byNumber((a) => lastMoved(a)?.getTime() ?? 0),
    );
  }
  // "To Apply" rows have no applied date and are the only rows still owing an
  // application, so both date sorts float them rather than clump them on "".
  // Company A-Z stays exactly alphabetical.
  return inOrder<Application>(
    first((a) => a.status === "To Apply"),
    byText((a) => a.dateApplied, sortKey !== "applied-asc"),
  );
}

function waitGroup(a: Application): number {
  if (!isWaiting(a)) return 2;
  return lastMoved(a) ? 0 : 1;
}

/** "" (nothing wrong), "waiting" (tonight's run will read it), "stuck" (no run will). */
export type FillState = "" | "waiting" | "stuck";

/**
 * The only place that decides a row's fill state.
 *
 * 'waiting' must stay in step with getAutofillQueue() in server/src/db.js - a
 * link, no autofill flag, and a blank company, role or location - or a row
 * promises a fill no run will attempt.
 */
export function fillState(a: Application): FillState {
  if ((a.autofill || "") === "failed") return "stuck";
  if ((a.autofill || "") === "" && safeUrl(a.link) && (!a.company || !a.title || !a.location)) {
    return "waiting";
  }
  return "";
}
