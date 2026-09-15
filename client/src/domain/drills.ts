/**
 * Drill-downs. **A number and the rows it opens come from one predicate:**
 * every Overview figure that is not simply a tab's worth of rows names an entry
 * here, the tab filters by the same `test`, and the count is the length of the
 * list the rule produces (see `drillRows`), never a second copy of the rule.
 *
 * The scope union keeps a leads drill from being handed an application.
 */
import type { Application, Lead, Settings } from "../api/schema";
import { ACTIVE, ALL_LEADS, STAGE_DATE_FIELDS } from "./constants";
import { daysSince } from "./format";
import { geo } from "./geo";

export type DrillScope = "leads" | "apps";

export type Drill =
  | { scope: "leads"; label: (s: Settings) => string; test: (row: Lead, s: Settings) => boolean }
  | { scope: "apps"; label: (s: Settings) => string; test: (row: Application, s: Settings) => boolean };

const base: Record<string, Drill> = {
  /**
   * The Overview's priority-location tile: the first configured ranking, still
   * worth looking at. Applied leads are not in the leads tab at all (they move
   * to Applications), and `leadRows` already drops them - so only "Not a fit"
   * needs excluding here.
   */
  "top-geo-open": {
    scope: "leads",
    label: (s) => `${s.priority_locations[0]?.label ?? "Top locations"} · still open`,
    test: (l, s) => {
      const g = geo(l.location, s.priority_locations);
      return !!g && g.i === 0 && l.status !== "Not a fit";
    },
  },
  "in-conversation": {
    scope: "apps",
    label: () => "In screen or loop stage",
    test: (a) => ACTIVE.includes(a.status),
  },
  "gone-quiet": {
    scope: "apps",
    label: () => "Applied 14+ days ago, no reply",
    test: (a) => {
      const d = daysSince(a.dateApplied);
      return a.status === "Applied" && d !== null && d > 14;
    },
  },
  /**
   * The funnel's first row. "To Apply" rows sit in that tab without having been
   * applied to, which is exactly what the Overview splits them out of.
   */
  applied: {
    scope: "apps",
    label: () => "Applied",
    test: (a) => a.status !== "To Apply",
  },
};

/**
 * One per pipeline stage, built from the same list the funnel is built from, so
 * a stage added there arrives here too. These test the stage *date*, not the
 * current status: the date is stamped once and never cleared, so an application
 * rejected after a tech screen still counts as having reached one - which is
 * what the funnel row it opens from counted.
 */
for (const [label, field] of STAGE_DATE_FIELDS) {
  base[`reached-${field}`] = {
    scope: "apps",
    label: () => `Reached ${label}`,
    test: (a) => a.status !== "To Apply" && !!(a as unknown as Record<string, string>)[field],
  };
}

export const DRILLS: Readonly<Record<string, Drill>> = base;

export function drillLabel(id: string | null, settings: Settings): string {
  const d = id ? DRILLS[id] : undefined;
  return d ? d.label(settings) : "";
}

/** True when a row survives the active drill. No drill, or one belonging to the other kind of tab, filters nothing. */
export function drillKeeps(id: string | null, scope: DrillScope, row: Lead | Application, settings: Settings): boolean {
  const d = id ? DRILLS[id] : undefined;
  if (!d || d.scope !== scope) return true;
  return d.scope === "leads"
    ? d.test(row as Lead, settings)
    : d.test(row as Application, settings);
}

/**
 * The rows a leads tab shows before any filter, drill or search. Applied leads
 * have moved to the Applications tab, so every lead count starts from here to
 * leave them out too.
 */
export function leadRows(leads: readonly Lead[], key: string): Lead[] {
  const isAll = key === ALL_LEADS;
  return leads.filter((l) => (isAll || l.search === key) && l.status !== "Applied");
}

/**
 * Every application, "To Apply" included. Named anyway, so application counts
 * start from the same place their lists do; a copy, so a caller's sort can't
 * reorder the query cache.
 */
export function appRows(applications: readonly Application[]): Application[] {
  return applications.slice();
}

/** What a tile or funnel row links to: a tab, plus at most one narrowing of it. */
export interface DrillTarget {
  tab: string;
  /** A plain status chip. */
  filter?: string;
  /** An entry in DRILLS, which owns the rule. */
  drill?: string;
}

export interface RowSource {
  leads: readonly Lead[];
  applications: readonly Application[];
  settings: Settings;
}

/** The rows a target opens. Nothing computes an Overview figure any other way. */
export function drillRows(t: DrillTarget, src: RowSource): (Lead | Application)[] {
  const isApps = t.tab === "applications";
  let rows: (Lead | Application)[] = isApps ? appRows(src.applications) : leadRows(src.leads, t.tab);
  if (t.filter) rows = rows.filter((r) => r.status === t.filter);
  if (t.drill) {
    const scope: DrillScope = isApps ? "apps" : "leads";
    rows = rows.filter((r) => drillKeeps(t.drill!, scope, r, src.settings));
  }
  return rows;
}

export function drillCount(t: DrillTarget, src: RowSource): number {
  return drillRows(t, src).length;
}
