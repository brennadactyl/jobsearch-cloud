import { Link } from "react-router-dom";
import type { Settings, Track } from "../api/schema";
import { APP_SORTS, LEAD_SORTS, pillFor } from "../domain/constants";
import { drillLabel } from "../domain/drills";
import { relWhen, safeUrl } from "../domain/format";
import { geo } from "../domain/geo";
import { runState, runSummary } from "../domain/runs";
import { setPrefs, usePrefs } from "../ui/prefs";

export function Pill({ status }: { status: string }) {
  return <span className={`pill ${pillFor(status)}`}>{status}</span>;
}

export function GeoBadge({ location, settings }: { location: string; settings: Settings }) {
  const g = geo(location, settings.priority_locations);
  if (!g) return null;
  return <span className={`geo ${g.p}`}>{g.label}</span>;
}

/** Numbered, because past two tiers colour alone doesn't say which outranks which. */
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
 * An applied filter you can't see is a page misreporting what it shows, so a
 * drill always gets this chip. Clearing is a link without the query param, so
 * Back restores it.
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

export function PostingLink({ url, children }: { url: string; children: React.ReactNode }) {
  const safe = safeUrl(url);
  if (!safe) return <>{children}</>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** stroke is currentColor, so the button's colour (.icon-btn.danger) colours the icon. */
export function TrashIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 4.5h10" />
      <path d="M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" />
      <path d="M4.5 4.5 5 13a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8.5" />
      <path d="M6.7 7v4M9.3 7v4" />
    </svg>
  );
}
