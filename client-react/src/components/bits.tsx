/**
 * The small shared pieces every panel uses. Each emits the class names
 * src/tracker.css already targets - none of this is new design.
 */
import { Link } from "react-router-dom";
import type { Application, Lead, Settings, Track } from "../api/schema";
import { APP_SORTS, LEAD_SORTS, pillFor } from "../domain/constants";
import { drillLabel } from "../domain/drills";
import { relWhen, safeUrl } from "../domain/format";
import { geo } from "../domain/geo";
import { runState, runSummary } from "../domain/runs";
import { setPrefs, usePrefs } from "../ui/prefs";

/** Status as a coloured pill. */
export function Pill({ status }: { status: string }) {
  return <span className={`pill ${pillFor(status)}`}>{status}</span>;
}

/** The location tier badge. Nothing when the location matches no configured rule. */
export function GeoBadge({ location, settings }: { location: string; settings: Settings }) {
  const g = geo(location, settings.priority_locations);
  if (!g) return null;
  return <span className={`geo ${g.p}`}>{g.label}</span>;
}

/**
 * The ranking legend, shared by every tab that colours a row by tier. Numbered
 * so the ranking reads as a ranking - with more than two tiers, colour alone
 * stops saying which outranks which.
 */
export function GeoKey({ settings }: { settings: Settings }) {
  return (
    <>
      {settings.priority_locations.map((r, i) => (
        <span key={r.label}>
          <i style={{ background: i < 5 ? `var(--pri-${i})` : "var(--ink3)" }} />
          {i + 1}. {r.label}
        </span>
      ))}
    </>
  );
}

/** "when did this search last run", above a track's list and in the Overview. */
export function RunStamp({ track, settings }: { track: Track | undefined; settings: Settings }) {
  if (!track) return null;
  const run = track.last_run;
  const st = runState(run, settings);
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

/** Detail / Grid. One switch drives both panels. */
export function ViewSwitch() {
  const { view } = usePrefs();
  return (
    <div className="viewsw">
      <button className="vbtn" type="button" aria-pressed={view !== "grid"} onClick={() => setPrefs({ view: "detail" })}>
        Detail
      </button>
      <button className="vbtn" type="button" aria-pressed={view === "grid"} onClick={() => setPrefs({ view: "grid" })}>
        Grid
      </button>
    </div>
  );
}

/**
 * One select drives both Grid and Detail, since both render from the same sorted
 * array - there is no separate "grid order" and "detail order" to keep in step.
 */
export function SortSelect({ kind, id }: { kind: "leads" | "applications"; id: string }) {
  const prefs = usePrefs();
  const opts = kind === "leads" ? LEAD_SORTS : APP_SORTS;
  const value = kind === "leads" ? prefs.leadSort : prefs.appSort;
  return (
    <div className="sortwrap">
      <label className="sort-label" htmlFor={id}>
        Sort
      </label>
      <select
        className="sortsel"
        id={id}
        value={value}
        onChange={(e) => setPrefs(kind === "leads" ? { leadSort: e.target.value } : { appSort: e.target.value })}
      >
        {opts.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The chip saying a drill-down is on, and taking it off again.
 *
 * Rendered only in the tab that owns it: the Overview sends you here with a
 * filter applied, and an applied filter you cannot see is a page lying about
 * what it is showing. Clearing it is a link back to the same tab without the
 * query param, so the back button works and the state is shareable.
 */
export function DrillChip({
  drill,
  settings,
  clearTo,
}: {
  drill: string | null;
  settings: Settings;
  clearTo: string;
}) {
  if (!drill) return null;
  const label = drillLabel(drill, settings);
  if (!label) return null;
  return (
    <Link className="chip drill" to={clearTo} aria-label={`Clear filter: ${label}`} title="Clear this filter">
      {label}
      <span className="x" aria-hidden="true">
        ×
      </span>
    </Link>
  );
}

/** A posting link, or plain text when there is nothing safe to open. */
export function PostingLink({ url, children }: { url: string; children: React.ReactNode }) {
  const safe = safeUrl(url);
  if (!safe) return <>{children}</>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * The facts cards under a row's header.
 *
 * Read-only in this phase: the inputs are rendered so the layout is the layout,
 * and marked readOnly rather than disabled so they stay selectable and
 * focusable. Phase 4 turns them into writes.
 */
export function FactsCards({
  item,
  fields,
}: {
  item: Lead | Application;
  fields: readonly (readonly [field: string, label: string])[];
}) {
  const row = item as unknown as Record<string, string>;
  return (
    <div className="facts">
      <div className="fcard">
        <h4>Role details</h4>
        <div className="fgrid">
          {fields.map(([field, label]) => (
            <label key={field} className="f">
              <span>{label}</span>
              <input type="text" value={row[field] ?? ""} placeholder={label} readOnly />
            </label>
          ))}
        </div>
      </div>
      <div className="fcard">
        <h4>Notes</h4>
        <textarea value={row.notes ?? ""} placeholder="Notes" readOnly />
      </div>
    </div>
  );
}
