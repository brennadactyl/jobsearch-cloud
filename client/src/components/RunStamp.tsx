import { Link } from "react-router-dom";
import type { Settings, Track } from "../api/schema";
import { ALL_FILTER, drillId } from "../domain/drills";
import { relWhen } from "../domain/format";
import { pausedDay, runState, runSummary } from "../domain/runs";
import { pathForSearch } from "../domain/screened";
import { pathForTab, pathForTarget } from "../domain/tabs";

/**
 * That night's finds on the search's own tab, every status shown: a lead marked
 * "Not a fit" since is still one the run added, and hiding it would make the
 * list disagree with the number that opened it. A run with no local date of its
 * own opens the tab itself.
 */
function pathForFound(key: string, on: string): string {
  return on ? pathForTarget({ tab: key, filter: ALL_FILTER, drill: drillId.foundDay(key, on) }) : pathForTab(key);
}

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
        // One flex item, or the stamp's gap opens up around the commas between
        // the counts. Both counts lead somewhere: one to what that night put on
        // the board, the other to what it set aside.
        <span className="runstamp-counts">
          <Link className="runstamp-found" to={pathForFound(track.key, run.on)}>{`${run.leads_added} new`}</Link>
          {/* What this person's own settings turned away, which is the number
              worth reading; a night that recorded no such count says nothing
              here rather than a zero it can't stand behind. */}
          {run.screened_by_rules != null && (
            <>
              {", "}
              <Link className="runstamp-screened" to={pathForSearch(track.key)}>
                {`${run.screened_by_rules} screened out`}
              </Link>
            </>
          )}
          {run.delisted > 0 && `, ${run.delisted} taken down`}
        </span>
      )}
    </span>
  );
}
