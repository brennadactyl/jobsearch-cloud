import { Link } from "react-router-dom";
import type { Settings, Track } from "../api/schema";
import { relWhen } from "../domain/format";
import { pausedDay, runState, runSummary } from "../domain/runs";
import { pathForSearch } from "../domain/screened";

/** When a search last ran and what it found, beside its tab and on the Overview. */
export function RunStamp({ track, settings }: { track: Track | undefined; settings: Settings }) {
  if (!track) return null;
  const run = track.last_run;
  const st = runState(track, settings);
  if (st === "paused") {
    const day = pausedDay(track.paused);
    return (
      <span className="runstamp paused" title="Paused: this search doesn't run until it's resumed. Its leads stay here.">
        Paused
        {day && (
          <>
            {" since "}
            <span className="mono">{day}</span>
          </>
        )}
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
      {run.on && <span className="mono"> {run.on}</span>} &middot;{" "}
      {run.status === "error" ? (
        runSummary(run)
      ) : (
        <>
          {run.leads_added} new,{" "}
          {/* What a night set aside is the one part of a run you can go and
              read, so the count is the way in. */}
          <Link className="runstamp-screened" to={pathForSearch(track.key)}>
            {run.screened_added} screened out
          </Link>
          {run.delisted > 0 && `, ${run.delisted} taken down`}
        </>
      )}
    </span>
  );
}
