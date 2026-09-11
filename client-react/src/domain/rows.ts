import type { Application, Lead, PriorityLocation } from "../api/schema";
import { safeUrl } from "./format";
import { rank } from "./geo";

/**
 * Default ("priority") sinks "Not a fit" to the bottom, then orders by location
 * rank, then newest-found. The explicit sorts are exactly what they say.
 */
export function leadComparator(
  sortKey: string,
  rules: readonly PriorityLocation[],
): (a: Lead, b: Lead) => number {
  if (sortKey === "found-desc") return (a, b) => String(b.found).localeCompare(String(a.found));
  if (sortKey === "found-asc") return (a, b) => String(a.found).localeCompare(String(b.found));
  if (sortKey === "location-asc") return (a, b) => String(a.location).localeCompare(String(b.location));
  if (sortKey === "company-asc") return (a, b) => String(a.company).localeCompare(String(b.company));
  return (a, b) => {
    const na = a.status === "Not a fit" ? 1 : 0;
    const nb = b.status === "Not a fit" ? 1 : 0;
    if (na !== nb) return na - nb;
    const d = rank(a, rules) - rank(b, rules);
    if (d) return d;
    return String(b.found).localeCompare(String(a.found));
  };
}

/**
 * Applications have no location or "found" date to sort by - just when you
 * applied and who to.
 */
export function appComparator(sortKey: string): (a: Application, b: Application) => number {
  if (sortKey === "company-asc") return (a, b) => String(a.company).localeCompare(String(b.company));
  if (sortKey === "location-asc") {
    return (a, b) => {
      // A hand-added application can have no location, and "" would sort first
      // in the sort that asks about location, so blanks sink.
      const ea = a.location ? 0 : 1;
      const eb = b.location ? 0 : 1;
      if (ea !== eb) return ea - eb;
      return String(a.location).localeCompare(String(b.location));
    };
  }
  const byDate =
    sortKey === "applied-asc"
      ? (a: Application, b: Application) => String(a.dateApplied).localeCompare(String(b.dateApplied))
      : (a: Application, b: Application) => String(b.dateApplied).localeCompare(String(a.dateApplied));
  // "To Apply" rows have no applied date and are the only rows still owing an
  // application, so both date sorts float them rather than clump them on "".
  // Company A-Z stays exactly alphabetical.
  return (a, b) => {
    const ta = a.status === "To Apply" ? 0 : 1;
    const tb = b.status === "To Apply" ? 0 : 1;
    if (ta !== tb) return ta - tb;
    return byDate(a, b);
  };
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
