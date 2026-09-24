/**
 * A track's last recorded run is the only thing that tells "ran and found
 * nothing" apart from "stopped running"; lead counts and badges look the same
 * in both cases.
 */
import { DEFAULT_STALE_RUN_HOURS, type LastRun, type Settings, type Track } from "../api/schema";
import { hoursSince } from "./format";

export type RunState = "ok" | "stale" | "error" | "never" | "paused";

/** What judging a search's state needs of it: when it last ran, and whether it's paused. */
export type RunTrack = Pick<Track, "last_run" | "paused">;

/**
 * "never" is not a problem: flagging it would open every new install covered in
 * warnings. "paused" comes first: a paused search isn't meant to run, so however
 * long ago its last run was, it isn't stale.
 *
 * The whole track is passed rather than its run alone, so no caller can judge a
 * paused search without its pause and read it as stale.
 */
export function runState(track: RunTrack | null | undefined, settings: Settings): RunState {
  if (track?.paused) return "paused";
  const run: LastRun | null | undefined = track?.last_run;
  if (!run || !run.at) return "never";
  if (run.status === "error") return "error";
  const h = hoursSince(run.at);
  const limit = Number(settings.stale_run_hours) || DEFAULT_STALE_RUN_HOURS;
  return h === null || h > limit ? "stale" : "ok";
}

/** Counts come from the run record, not leads[], so a day that added nothing still reads as a result. */
export function runSummary(run: LastRun | null | undefined): string {
  if (!run || !run.at) return "";
  if (run.status === "error") return run.note || "the run reported an error";
  const bits: string[] = [];
  if (run.leads_added) bits.push(`${run.leads_added} new`);
  if (run.screened_added) bits.push(`${run.screened_added} screened out`);
  // Only the run record counts these: the delisted rows were deleted.
  if (run.delisted) bits.push(`${run.delisted} taken down`);
  return bits.length ? bits.join(", ") : "found nothing new";
}

export interface TabWarning {
  cls: string;
  title: string;
}

export function trackWarn(track: RunTrack | null | undefined, settings: Settings): TabWarning | null {
  const st = runState(track, settings);
  if (st === "error") return { cls: "error", title: "The last scheduled run reported an error" };
  if (st === "stale") return { cls: "stale", title: "This search hasn’t run recently" };
  return null;
}
