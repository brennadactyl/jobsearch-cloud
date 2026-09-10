/**
 * Scheduled-run status.
 *
 * Each track carries the last run its search recorded. This is the only thing
 * on the page that can tell "the search ran and genuinely found nothing" apart
 * from "the search stopped running" - every other signal (lead counts, the tab
 * badges, meta.updated) looks identical in both cases.
 */
import type { LastRun, Settings } from "../api/schema";
import { hoursSince } from "./format";

export type RunState = "ok" | "stale" | "error" | "never";

/**
 * "never" is deliberately not treated as a problem: it is the honest state of a
 * freshly configured track that has not hit its first scheduled run yet, and
 * flagging it would mean every new install opens covered in warnings.
 */
export function runState(run: LastRun | null | undefined, settings: Settings): RunState {
  if (!run || !run.at) return "never";
  if (run.status === "error") return "error";
  const h = hoursSince(run.at);
  const limit = Number(settings.stale_run_hours) || 36;
  return h === null || h > limit ? "stale" : "ok";
}

/**
 * What the run did, in one clause. Counts come from the run record rather than
 * being recomputed from leads[], so a day that added nothing still reads as a
 * real result ("found nothing new") instead of a blank.
 */
export function runSummary(run: LastRun | null | undefined): string {
  if (!run || !run.at) return "";
  if (run.status === "error") return run.note || "the run reported an error";
  const bits: string[] = [];
  if (run.leads_added) bits.push(`${run.leads_added} new`);
  if (run.screened_added) bits.push(`${run.screened_added} screened out`);
  // The run record still counts these ("2 postings came down today") even
  // though nothing on a lead marks it - those rows were deleted.
  if (run.delisted) bits.push(`${run.delisted} taken down`);
  return bits.length ? bits.join(", ") : "found nothing new";
}

export interface TabWarning {
  cls: string;
  title: string;
}

/**
 * The mark a tab carries when something behind it needs attention, in the shape
 * buildTabs puts on every tab. Null when there is nothing to say.
 */
export function trackWarn(run: LastRun | null | undefined, settings: Settings): TabWarning | null {
  const st = runState(run, settings);
  if (st === "error") return { cls: "error", title: "The last scheduled run reported an error" };
  if (st === "stale") return { cls: "stale", title: "This search hasn’t run recently" };
  return null;
}
