import type { Settings, Track } from "../api/schema";
import { isoDay, relWhen } from "../domain/format";
import { runState, runSummary } from "../domain/runs";

/** When a search last ran and what it found, beside its tab and on the Overview. */
export function RunStamp({ track, settings }: { track: Track | undefined; settings: Settings }) {
  if (!track) return null;
  const run = track.last_run;
  const st = runState(track, settings);
  if (st === "paused") {
    const since = new Date(track.paused_since);
    const day = Number.isNaN(since.getTime()) ? "" : isoDay(since);
    return (
      <span className="runstamp paused" title="Paused: this search doesn't run until it's resumed. Its leads stay here.">
        Paused
        {day && <span className="mono"> {day}</span>}
      </span>
    );
  }
  if (st === "never") {
    return (
      <span
        className="runstamp none"
        title="This track has no recorded run yet - its first scheduled search will fill this in"
      >
        No run recorded yet
      </span>
    );
  }
  return (
    <span className={`runstamp ${st}`} title={`Last run ${run.at}${run.on ? ` (local date ${run.on})` : ""}`}>
      <i className="rdot" />
      Ran {relWhen(run.at)}
      {run.on && <span className="mono"> {run.on}</span>} &middot; {runSummary(run)}
    </span>
  );
}
