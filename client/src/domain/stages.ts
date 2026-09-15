/**
 * How far an application has got, when it last moved and how long a reply
 * took. The pipeline card's segments, bins and waiting list all read these, and
 * so do the drills they open, so a chart and its rows can't disagree.
 */
import type { Application } from "../api/schema";
import { ACTIVE, STAGE_DATE_FIELDS } from "./constants";
import { daysBetween, localDay, localToday } from "./format";

type Row = Record<string, string>;

export interface Stage {
  /** URL-safe, for drill ids. */
  slug: string;
  label: string;
  field: string;
}

/**
 * The forward stages in order, Offer last. Rejected and Withdrawn are outcomes,
 * not stages: they end an application at whatever stage it had reached.
 */
export const FORWARD_STAGES: readonly Stage[] = [
  ["Applied", "dateApplied"] as const,
  ...STAGE_DATE_FIELDS.filter(([label]) => label !== "Rejected" && label !== "Withdrawn"),
].map(([label, field]) => ({ slug: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"), label, field }));

/** The stages that get a flow bar. Offer only closes the chart. */
export const FLOW_STAGES = FORWARD_STAGES.slice(0, -1);
export const OFFER_INDEX = FORWARD_STAGES.length - 1;

/**
 * The index in FORWARD_STAGES of the furthest stage an application reached, or
 * null for a "To Apply" row, which hasn't been sent.
 *
 * The last stage with a date set, but never below the stage its status names
 * and never below Applied: the server stamps only the stage a status moves to,
 * so Applied straight to Tech Screen leaves the Recruiter Screen date empty,
 * and a status can be set with its date cleared.
 */
export function furthestStage(a: Application): number | null {
  if (a.status === "To Apply") return null;
  let furthest = Math.max(0, FORWARD_STAGES.findIndex((s) => s.label === a.status));
  FORWARD_STAGES.forEach((s, i) => {
    if ((a as unknown as Row)[s.field]) furthest = Math.max(furthest, i);
  });
  return furthest;
}

export const FLOW_SEGMENTS = ["moved-on", "waiting", "rejected", "withdrew"] as const;
export type FlowSegment = (typeof FLOW_SEGMENTS)[number];

/**
 * The one name for each segment: the bar's labels, tooltips and table headers
 * use it as written, and the drill chip lower-cased after the stage name.
 */
export const FLOW_SEGMENT_LABELS: Record<FlowSegment, string> = {
  "moved-on": "Moved on",
  waiting: "Still waiting",
  rejected: "Rejected at this stage",
  withdrew: "Withdrew at this stage",
};

/** Where an application sits in one stage's bar, or null if it never reached that stage. */
export function flowSegment(a: Application, stage: number): FlowSegment | null {
  const f = furthestStage(a);
  if (f === null || f < stage) return null;
  if (f > stage) return "moved-on";
  if (a.status === "Rejected") return "rejected";
  if (a.status === "Withdrawn") return "withdrew";
  return "waiting";
}

/**
 * Any reply from the company. A rejection is one - just not a forward one - and
 * a withdrawal isn't: it's your action.
 */
export const RESPONSE_FIELDS = ["dateRecruiterScreen", "dateTechScreen", "dateOnsite", "dateOffer", "dateRejected"];

export function responded(a: Application): boolean {
  return RESPONSE_FIELDS.some((f) => (a as unknown as Row)[f]);
}

/** Whole days from applying to the first reply, or null without both dates. */
export function daysToFirstResponse(a: Application): number | null {
  const applied = localDay(a.dateApplied);
  if (!applied) return null;
  let earliest: Date | null = null;
  for (const f of RESPONSE_FIELDS) {
    const d = localDay((a as unknown as Row)[f]);
    if (d && (!earliest || d < earliest)) earliest = d;
  }
  if (!earliest) return null;
  const days = daysBetween(applied, earliest);
  return days >= 0 ? days : null;
}

export const RESPONSE_BINS: readonly { key: string; label: string; max: number }[] = [
  { key: "0-3", label: "0–3 days", max: 3 },
  { key: "4-7", label: "4–7 days", max: 7 },
  { key: "8-14", label: "8–14 days", max: 14 },
  { key: "15-30", label: "15–30 days", max: 30 },
  { key: "31+", label: "31+ days", max: Infinity },
];

export function responseBin(a: Application): string | null {
  const d = daysToFirstResponse(a);
  if (d === null) return null;
  return RESPONSE_BINS.find((b) => d <= b.max)!.key;
}

/** The middle value, rounded to a whole day; null for no values. */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

/** Still in play and waiting on the company: Applied, or a screen or loop. */
export function isWaiting(a: Application): boolean {
  return a.status === "Applied" || ACTIVE.includes(a.status);
}

/** The latest of the applied date and the forward stage dates, or null for none. */
export function lastMoved(a: Application): Date | null {
  let latest: Date | null = null;
  for (const s of FORWARD_STAGES) {
    const d = localDay((a as unknown as Row)[s.field]);
    if (d && (!latest || d > latest)) latest = d;
  }
  return latest;
}

/** Days since an application last moved, or null when it has no dates. */
export function daysSinceMoved(a: Application): number | null {
  const d = lastMoved(a);
  return d ? Math.max(0, daysBetween(d, localToday())) : null;
}
