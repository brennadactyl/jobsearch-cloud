/**
 * The Overview's charts as data: one series per chart, each point carrying its
 * figure and the target it opens. The chart and its table view both render
 * these, so they can't show different numbers, and every figure that opens
 * rows is `drillCount` of its own target.
 */
import type { Application, Lead, Screened, TrackerData } from "../api/schema";
import { ALL_LEADS, DELISTED_REASON, LEAD_STATUS } from "./constants";
import { drillCount, drillRows, isOpen, type DrillTarget, type RowSource } from "./drills";
import { lastWeeks, localToday, weekOf } from "./format";
import {
  FLOW_SEGMENTS,
  FLOW_STAGES,
  FORWARD_STAGES,
  OFFER_INDEX,
  RESPONSE_BINS,
  daysSinceMoved,
  daysToFirstResponse,
  isWaiting,
  median,
  type FlowSegment,
} from "./stages";
import { buildTracks } from "./tabs";

export const MOMENTUM_WEEKS = 12;

export interface WeekPoint {
  monday: string;
  /** The week still under way. */
  current: boolean;
  n: number;
  target: DrillTarget;
  /** How many of `n` the target opens, when that differs. */
  opens: number;
}

export interface Momentum {
  found: WeekPoint[];
  applied: WeekPoint[];
  /**
   * False when the server predates removed postings keeping their found date,
   * so the found counts can't include them.
   */
  removedCounted: boolean;
}

export function momentum(data: TrackerData, now: Date = localToday()): Momentum {
  const weeks = lastWeeks(MOMENTUM_WEEKS, now);
  const last = weeks[weeks.length - 1];
  const removedCounted = data.screened.length === 0 || data.screened.some((s) => s.found != null);
  const found = weeks.map((monday) => {
    const target = { tab: ALL_LEADS, drill: `found-week:${monday}` };
    const n =
      data.leads.filter((l) => weekOf(l.found) === monday).length +
      data.screened.filter((s) => weekOf(s.found) === monday).length;
    return { monday, current: monday === last, n, target, opens: drillCount(target, data) };
  });
  const applied = weeks.map((monday) => {
    const target = { tab: "applications", drill: `applied-week:${monday}` };
    const n = drillCount(target, data);
    return { monday, current: monday === last, n, target, opens: n };
  });
  return { found, applied, removedCounted };
}

export interface Count {
  n: number;
  /** Absent for a figure that opens nothing. */
  target?: DrillTarget;
}

export interface FoundBreakdown {
  open: number;
  notAFit: number;
  applied: number;
  /** Leads in a status outside LEAD_STATUS, which only a hand edit can write. */
  other: number;
  removed: number;
}

export interface PayoffRow {
  key: string;
  label: string;
  /** Null on the hand-added row, which found nothing. */
  found: { n: number; breakdown: FoundBreakdown } | null;
  open: Count | null;
  notAFit: Count | null;
  applied: Count;
  responded: Count;
}

/** A posting the search found and that has since left the board: removed by hand, or taken down. */
export function isRemoved(s: Screened): boolean {
  return s.added_by === "hand" || s.reason === DELISTED_REASON;
}

function count(target: DrillTarget, src: RowSource): Count {
  return { n: drillCount(target, src), target };
}

function breakdown(leads: readonly Lead[], removed: number): FoundBreakdown {
  const known = LEAD_STATUS as readonly string[];
  return {
    open: leads.filter(isOpen).length,
    notAFit: leads.filter((l) => l.status === "Not a fit").length,
    applied: leads.filter((l) => l.status === "Applied").length,
    other: leads.filter((l) => !known.includes(l.status)).length,
    removed,
  };
}

/** One row per search in track order, the hand-added row when there are any, and the total. */
export function payoff(data: TrackerData): { rows: PayoffRow[]; total: PayoffRow } {
  const tracks = buildTracks(data.tracks);
  const rows: PayoffRow[] = Object.keys(tracks).map((key) => {
    const leads = data.leads.filter((l) => l.search === key);
    const removed = data.screened.filter((s) => s.search === key && isRemoved(s)).length;
    return {
      key,
      label: tracks[key].label,
      found: { n: leads.length + removed, breakdown: breakdown(leads, removed) },
      open: count({ tab: key, drill: "open" }, data),
      notAFit: count({ tab: key, filter: "Not a fit" }, data),
      applied: count({ tab: "applications", drill: `search-applied:${key}` }, data),
      responded: count({ tab: "applications", drill: `search-responded:${key}` }, data),
    };
  });
  if (data.applications.some((a) => !a.leadId)) {
    rows.push({
      key: "",
      label: "Added by hand",
      found: null,
      open: null,
      notAFit: null,
      applied: count({ tab: "applications", drill: "hand-applied" }, data),
      responded: count({ tab: "applications", drill: "hand-responded" }, data),
    });
  }
  const removed = data.screened.filter(isRemoved).length;
  const total: PayoffRow = {
    key: "total",
    label: "Total",
    found: { n: data.leads.length + removed, breakdown: breakdown(data.leads, removed) },
    open: count({ tab: ALL_LEADS, drill: "open" }, data),
    notAFit: count({ tab: ALL_LEADS, filter: "Not a fit" }, data),
    applied: count({ tab: "applications", drill: "applied" }, data),
    responded: count({ tab: "applications", drill: "responded" }, data),
  };
  return { rows, total };
}

/** Whole-percent rate, or null when it isn't worth stating. */
export function rate(part: number, whole: number, minWhole = 1): number | null {
  return whole >= minWhole && whole > 0 ? Math.round((part / whole) * 100) : null;
}

/** Response rate means nothing on one or two applications. */
export const MIN_FOR_RESPONSE_RATE = 3;

export interface Segment {
  key: string;
  label: string;
  n: number;
  target: DrillTarget;
}

export interface TierBar {
  key: string;
  label: string;
  segments: Segment[];
}

/** One bar per priority_locations rule plus Other. Empty when no rules are configured. */
export function tierBars(data: TrackerData): TierBar[] {
  const rules = data.settings.priority_locations;
  if (!rules.length) return [];
  const tiers = [...rules.map((r, i) => ({ key: String(i), label: r.label })), { key: "other", label: "Other" }];
  return tiers.map((t) => ({
    ...t,
    segments: [
      { key: "applied", label: "Applied", target: { tab: "applications", drill: `tier:${t.key}:applied` } },
      { key: "open", label: "Open", target: { tab: ALL_LEADS, drill: `tier:${t.key}:open` } },
      { key: "not-a-fit", label: "Not a fit", target: { tab: ALL_LEADS, drill: `tier:${t.key}:not-a-fit` } },
    ].map((s) => ({ ...s, n: drillCount(s.target, data) })),
  }));
}

export const FLOW_SEGMENT_LABELS: Record<FlowSegment, string> = {
  "moved-on": "Moved on",
  waiting: "Waiting",
  rejected: "Rejected here",
  withdrew: "Withdrew here",
};

export interface FlowBar {
  slug: string;
  label: string;
  reached: Count;
  segments: Segment[];
}

export function flow(data: TrackerData): { bars: FlowBar[]; offer: Count } {
  const bars = FLOW_STAGES.map((s) => ({
    slug: s.slug,
    label: s.label,
    reached: count({ tab: "applications", drill: `flow:${s.slug}:reached` }, data),
    segments: FLOW_SEGMENTS.map((seg) => {
      const target = { tab: "applications", drill: `flow:${s.slug}:${seg}` };
      return { key: seg, label: FLOW_SEGMENT_LABELS[seg], n: drillCount(target, data), target };
    }),
  }));
  const offer = count({ tab: "applications", drill: `flow:${FORWARD_STAGES[OFFER_INDEX].slug}:reached` }, data);
  return { bars, offer };
}

export interface Histogram {
  bins: Segment[];
  median: number | null;
}

export function responseHistogram(data: TrackerData): Histogram {
  const sent = drillRows({ tab: "applications", drill: "applied" }, data) as Application[];
  const days = sent.map(daysToFirstResponse).filter((d): d is number => d !== null);
  return {
    median: median(days),
    bins: RESPONSE_BINS.map((b) => {
      const target = { tab: "applications", drill: `response-days:${b.key}` };
      return { key: b.key, label: b.label, n: drillCount(target, data), target };
    }),
  };
}

export const WAITING_SHOWN = 5;

/** The applications waiting longest since they last moved, longest first. */
export function waitingLongest(data: TrackerData): { app: Application; days: number }[] {
  return data.applications
    .filter(isWaiting)
    .map((app) => ({ app, days: daysSinceMoved(app) }))
    .filter((w): w is { app: Application; days: number } => w.days !== null)
    .sort((a, b) => b.days - a.days || String(a.app.company).localeCompare(String(b.app.company)))
    .slice(0, WAITING_SHOWN);
}
