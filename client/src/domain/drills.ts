/**
 * Drill-downs. **A number and the rows it opens come from one predicate:**
 * every Overview figure that is not simply a tab's worth of rows names an entry
 * here, the tab filters by the same `test`, and the count is the length of the
 * list the rule produces (see `drillRows`), never a second copy of the rule.
 *
 * A drill id is a name, or a name and a parameter after the first colon
 * (`found-week:2026-09-08`), resolved by `findDrill`.
 *
 * The scope union keeps a leads drill from being handed an application.
 */
import type { Application, Lead, Screened, Settings, Track } from "../api/schema";
import { ACTIVE, ALL_LEADS, STAGE_DATE_FIELDS } from "./constants";
import { daysSince, localDay, shortDate, weekOf } from "./format";
import { geo } from "./geo";
import {
  FLOW_SEGMENT_LABELS,
  FLOW_SEGMENTS,
  FORWARD_STAGES,
  OFFER_INDEX,
  RESPONSE_BINS,
  flowSegment,
  furthestStage,
  isWaiting,
  responded,
  responseBin,
  type FlowSegment,
} from "./stages";

export type DrillScope = "leads" | "apps";

/** An application still at Applied this many days or more after it was sent has gone quiet. */
export const GONE_QUIET_DAYS = 14;

/** What a drill may read besides the row: some rules ask about another table. */
export interface DrillContext {
  settings: Settings;
  leads: readonly Lead[];
  tracks: readonly Track[];
  screened: readonly Screened[];
}

/**
 * Postings found in the week starting `monday`: leads in any status, plus
 * removed postings whose screened row kept their found date.
 */
export function foundInWeek(c: DrillContext, monday: string): number {
  return (
    c.leads.filter((l) => weekOf(l.found) === monday).length +
    c.screened.filter((s) => weekOf(s.found) === monday).length
  );
}

export type Drill =
  | { scope: "leads"; label: (c: DrillContext) => string; test: (row: Lead, c: DrillContext) => boolean }
  | { scope: "apps"; label: (c: DrillContext) => string; test: (row: Application, c: DrillContext) => boolean };

const base: Record<string, Drill> = {
  /**
   * The Overview's priority-location tile: the first configured ranking, still
   * worth looking at. Applied leads are not in the leads tab at all (they move
   * to Applications), and `leadRows` already drops them - so only "Not a fit"
   * needs excluding here.
   */
  "top-geo-open": {
    scope: "leads",
    label: (c) => `${c.settings.priority_locations[0]?.label ?? "Top locations"} · still open`,
    test: (l, c) => {
      const g = geo(l.location, c.settings.priority_locations);
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
    label: () => `Applied ${GONE_QUIET_DAYS}+ days ago, no reply`,
    test: (a) => {
      const d = daysSince(a.dateApplied);
      return a.status === "Applied" && d !== null && d >= GONE_QUIET_DAYS;
    },
  },
  /**
   * The funnel's first row. "To Apply" rows sit in that tab without having been
   * applied to, which is exactly what the Overview splits them out of.
   */
  applied: {
    scope: "apps",
    label: () => "Applied",
    test: (a) => sent(a),
  },
  responded: {
    scope: "apps",
    label: () => "Applied and heard back",
    test: (a) => sent(a) && responded(a),
  },
  "hand-applied": {
    scope: "apps",
    label: () => "Applied · added by hand",
    test: (a) => sent(a) && !a.leadId,
  },
  "hand-responded": {
    scope: "apps",
    label: () => "Heard back · added by hand",
    test: (a) => sent(a) && !a.leadId && responded(a),
  },
  waiting: {
    scope: "apps",
    label: () => "Waiting to hear back",
    test: (a) => isWaiting(a),
  },
};

/**
 * One per pipeline stage, built from the same list the funnel is built from, so
 * a stage added there arrives here too. These test the stage *date*, not the
 * current status: the date is stamped once and never cleared, so an application
 * rejected after a tech screen still counts as having reached one.
 */
for (const [label, field] of STAGE_DATE_FIELDS) {
  base[`reached-${field}`] = {
    scope: "apps",
    label: () => `Reached ${label}`,
    test: (a) => sent(a) && !!(a as unknown as Record<string, string>)[field],
  };
}

export const DRILLS: Readonly<Record<string, Drill>> = base;


const TIER_SEGMENTS = ["applied", "open", "not-a-fit"] as const;
type TierSegment = (typeof TIER_SEGMENTS)[number];

/**
 * Builds the id of a drill that takes a parameter: `<name>:<parameter>`, read
 * back by the PARAMETERISED entry of the same name below. A chart or table asks
 * for its target through these rather than writing the string, so each format
 * is spelled out once, beside its parser.
 */
export const drillId = {
  /** Postings found in the week starting `monday` (YYYY-MM-DD). */
  foundWeek: (monday: string) => `found-week:${monday}`,
  /** Applications sent in the week starting `monday` (YYYY-MM-DD). */
  appliedWeek: (monday: string) => `applied-week:${monday}`,
  /** Applications sent from a lead one search found. */
  searchApplied: (trackKey: string) => `search-applied:${trackKey}`,
  /** Of those, the ones that heard back. */
  searchResponded: (trackKey: string) => `search-responded:${trackKey}`,
  /** One segment of a location tier's bar; `tier` is a priority_locations rank or `other`, as tierKey returns. */
  tier: (tier: string, segment: TierSegment) => `tier:${tier}:${segment}`,
  /** One segment of a pipeline stage's bar, or `reached` for the whole bar. */
  flow: (stageSlug: string, segment: FlowSegment | "reached") => `flow:${stageSlug}:${segment}`,
  /** Applications whose first reply came within one RESPONSE_BINS range. */
  responseDays: (binKey: string) => `response-days:${binKey}`,
};

/**
 * Drills that take a parameter. Each returns undefined for a parameter it
 * can't read, which filters nothing and shows no chip - the same as an unknown
 * drill name.
 */
const PARAMETERISED: Record<string, (arg: string) => Drill | undefined> = {
  /**
   * The label gives both counts: the week's column counts postings no leads tab
   * shows (applied to, or removed), so the list it opens can be shorter.
   */
  "found-week": (monday) =>
    localDay(monday)
      ? {
          scope: "leads",
          label: (c) => {
            const onBoard = leadRows(c.leads, ALL_LEADS).filter((l) => weekOf(l.found) === monday).length;
            return `Found week of ${shortDate(monday)} · ${onBoard} of ${foundInWeek(c, monday)} still on your board`;
          },
          test: (l) => weekOf(l.found) === monday,
        }
      : undefined,
  "applied-week": (monday) =>
    localDay(monday)
      ? {
          scope: "apps",
          label: () => `Applied week of ${shortDate(monday)}`,
          test: (a) => sent(a) && weekOf(a.dateApplied) === monday,
        }
      : undefined,
  "search-applied": (key) => ({
    scope: "apps",
    label: (c) => `Applied · ${trackLabel(key, c)}`,
    test: (a, c) => sent(a) && leadSearch(a, c) === key,
  }),
  "search-responded": (key) => ({
    scope: "apps",
    label: (c) => `Heard back · ${trackLabel(key, c)}`,
    test: (a, c) => sent(a) && leadSearch(a, c) === key && responded(a),
  }),
  /** `tier:<index>:<segment>`, index being a priority_locations rank or `other`. */
  tier: (arg) => {
    const [tier, segment] = splitOnce(arg);
    if (!(tier === "other" || /^\d+$/.test(tier))) return undefined;
    if (!(TIER_SEGMENTS as readonly string[]).includes(segment)) return undefined;
    const name = (c: DrillContext) =>
      tier === "other" ? "Other locations" : (c.settings.priority_locations[Number(tier)]?.label ?? "Unknown tier");
    const inTier = (location: string, c: DrillContext) => tierKey(location, c.settings) === tier;
    if (segment === "applied") {
      return { scope: "apps", label: (c) => `${name(c)} · Applied`, test: (a, c) => sent(a) && inTier(a.location, c) };
    }
    return segment === "open"
      ? { scope: "leads", label: (c) => `${name(c)} · Open`, test: (l, c) => isOpen(l) && inTier(l.location, c) }
      : {
          scope: "leads",
          label: (c) => `${name(c)} · Not a fit`,
          test: (l, c) => l.status === "Not a fit" && inTier(l.location, c),
        };
  },
  /** `flow:<stage slug>:<segment>`, or `flow:<stage slug>:reached` for the whole bar. */
  flow: (arg) => {
    const [slug, segment] = splitOnce(arg);
    const stage = FORWARD_STAGES.findIndex((s) => s.slug === slug);
    if (stage < 0) return undefined;
    const label = FORWARD_STAGES[stage].label;
    if (segment === "reached") {
      return {
        scope: "apps",
        label: () => `Reached ${label}`,
        test: (a) => (furthestStage(a) ?? -1) >= stage,
      };
    }
    if (!(FLOW_SEGMENTS as readonly string[]).includes(segment) || stage === OFFER_INDEX) return undefined;
    const seg = segment as FlowSegment;
    return { scope: "apps", label: () => `${label} · ${FLOW_SEGMENT_LABELS[seg].toLowerCase()}`, test: (a) => flowSegment(a, stage) === seg };
  },
  "response-days": (bin) => {
    const b = RESPONSE_BINS.find((r) => r.key === bin);
    return b
      ? { scope: "apps", label: () => `First reply in ${b.label}`, test: (a) => sent(a) && responseBin(a) === bin }
      : undefined;
  },
};

/** The rule a drill id names, parameterised or not. */
export function findDrill(id: string | null): Drill | undefined {
  if (!id) return undefined;
  if (Object.hasOwn(DRILLS, id)) return DRILLS[id];
  const [name, arg] = splitOnce(id);
  return arg && Object.hasOwn(PARAMETERISED, name) ? PARAMETERISED[name](arg) : undefined;
}

export function drillLabel(id: string | null, ctx: DrillContext): string {
  const d = findDrill(id);
  return d ? d.label(ctx) : "";
}

/** True when a row survives the active drill. No drill, or one belonging to the other kind of tab, filters nothing. */
export function drillKeeps(id: string | null, scope: DrillScope, row: Lead | Application, ctx: DrillContext): boolean {
  const d = findDrill(id);
  if (!d || d.scope !== scope) return true;
  return d.scope === "leads"
    ? d.test(row as Lead, ctx)
    : d.test(row as Application, ctx);
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

/** The chip a leads view shows when its URL names none: postings still waiting on a decision. */
export const OPEN_FILTER = "Open";
/** The chip for every status a leads tab holds, Not a fit included. */
export const ALL_FILTER = "All";

/** Still waiting on a decision. */
export function isOpen(lead: Lead): boolean {
  return lead.status === "New" || lead.status === "Reviewing";
}

/**
 * A leads view with no filter shows Open. The Overview's counts and the tabs
 * they open both resolve through here, so a figure and its list can't disagree.
 */
export function resolveLeadFilter(filter: string | null | undefined): string {
  return filter || OPEN_FILTER;
}

/** Whether a lead shows under a resolved leads filter: Open, All, or one status. */
export function leadFilterKeeps(filter: string, lead: Lead): boolean {
  if (filter === OPEN_FILTER) return isOpen(lead);
  if (filter === ALL_FILTER) return true;
  return lead.status === filter;
}

/** What a tile or chart mark links to: a tab, plus at most one narrowing of it. */
export interface DrillTarget {
  tab: string;
  /** A status chip. On a leads tab, none means Open; every status is ALL_FILTER. */
  filter?: string;
  /** An entry in DRILLS, which owns the rule. */
  drill?: string;
}

export interface RowSource extends DrillContext {
  applications: readonly Application[];
}

/** The rows a target opens. Nothing computes an Overview figure any other way. */
export function drillRows(t: DrillTarget, src: RowSource): (Lead | Application)[] {
  const isApps = t.tab === "applications";
  let rows: (Lead | Application)[];
  if (isApps) {
    rows = appRows(src.applications);
    if (t.filter) rows = rows.filter((r) => r.status === t.filter);
  } else {
    const filter = resolveLeadFilter(t.filter);
    rows = leadRows(src.leads, t.tab).filter((l) => leadFilterKeeps(filter, l));
  }
  if (t.drill) {
    const scope: DrillScope = isApps ? "apps" : "leads";
    rows = rows.filter((r) => drillKeeps(t.drill!, scope, r, src));
  }
  return rows;
}

export function drillCount(t: DrillTarget, src: RowSource): number {
  return drillRows(t, src).length;
}

/** Sent, as opposed to parked in "To Apply". */
function sent(a: Application): boolean {
  return a.status !== "To Apply";
}

/** A location's tier as a drill parameter: its rank, or `other`. */
export function tierKey(location: string, settings: Settings): string {
  const g = geo(location, settings.priority_locations);
  return g ? String(g.i) : "other";
}

function splitOnce(s: string): [string, string] {
  const i = s.indexOf(":");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

function trackLabel(key: string, c: DrillContext): string {
  return c.tracks.find((t) => t.key === key)?.label || key;
}

// Built once per leads array, so filtering every application doesn't rescan
// the leads for each one. The query cache replaces the array on any change.
const searchById = new WeakMap<readonly Lead[], Map<string, string>>();

/** The search an application's lead was filed under, or "" when it has none. */
function leadSearch(a: Application, c: DrillContext): string {
  if (!a.leadId) return "";
  let m = searchById.get(c.leads);
  if (!m) {
    m = new Map(c.leads.map((l) => [String(l.id), l.search]));
    searchById.set(c.leads, m);
  }
  return m.get(String(a.leadId)) ?? "";
}
