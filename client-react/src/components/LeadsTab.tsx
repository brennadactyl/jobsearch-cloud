/**
 * A track's leads, or every track's for the pooled tab.
 *
 * One component draws both: `key === ALL_LEADS` is the only difference that
 * reaches the rows. Everything a single track has and a pooled list cannot
 * - its description, its run stamp, the empty state that explains why a search
 * found nothing - is skipped rather than faked.
 *
 * Every control here writes: status through its own endpoint, every other
 * field on blur. See ./writes.tsx.
 */
import { Fragment, type MouseEvent } from "react";
import { useSearchParams } from "react-router-dom";
import type { Lead, TrackerData } from "../api/schema";
import { useDeleteLead, useMoveLead } from "../api/mutations";
import { ALL_LEADS, LEAD_STATUS } from "../domain/constants";
import { drillKeeps, leadRows } from "../domain/drills";
import { safeUrl } from "../domain/format";
import { geo } from "../domain/geo";
import { leadComparator } from "../domain/rows";
import { runState } from "../domain/runs";
import { buildTracks, pathForTab, trackCountLine } from "../domain/tabs";
import { selectRow, setPrefs, usePrefs } from "../ui/prefs";
import { DrillChip, GeoBadge, GeoKey, Pill, RunStamp, SortSelect, TrashIcon, ViewSwitch } from "./bits";
import { LeadFactsCard, NotesBlock } from "./facts";
import { EditableField, LeadStatusSelect } from "./writes";

export default function LeadsTab({ data, trackKey }: { data: TrackerData; trackKey: string }) {
  const { settings } = data;
  const prefs = usePrefs();
  const [params, setParams] = useSearchParams();
  const drill = params.get("drill");
  const filter = params.get("filter") ?? "All";
  const q = params.get("q") ?? "";

  const isAll = trackKey === ALL_LEADS;
  const tracks = buildTracks(data.tracks);
  const track = tracks[trackKey];
  const scopeLabel = isAll ? settings.all_leads_label || "All leads" : (track?.label ?? trackKey);

  // `tracked` keeps the unfiltered set only so the empty state below can tell a
  // search that has never found anything from one whose finds have all been
  // applied to.
  const tracked = data.leads.filter((l) => isAll || l.search === trackKey);
  const all = leadRows(data.leads, trackKey);
  const needle = q.toLowerCase();
  const rows = all
    .filter((l) => {
      if (filter !== "All" && l.status !== filter) return false;
      if (!drillKeeps(drill, "leads", l, settings)) return false;
      if (!needle) return true;
      return `${l.company} ${l.title} ${l.location}`.toLowerCase().includes(needle);
    })
    .sort(leadComparator(prefs.leadSort, settings.priority_locations));

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const toolbar = (
    <>
      <div className="toolbar">
        <div className="search">
          <input
            type="search"
            id="q"
            placeholder={`Filter ${scopeLabel}…`}
            value={q}
            onChange={(e) => setParam("q", e.target.value)}
          />
        </div>
        <div className="chips">
          {["All", ...LEAD_STATUS.filter((s) => s !== "Applied")].map((f) => (
            <button
              key={f}
              className="chip"
              type="button"
              aria-pressed={filter === f}
              onClick={() => setParam("filter", f === "All" ? null : f)}
            >
              {f}
            </button>
          ))}
          <DrillChip drill={drill} settings={settings} clearTo={clearDrillTo(trackKey, params)} />
        </div>
        <ViewSwitch />
      </div>
      {/* The controls people touch constantly stay full-weight above. Sort and
          this row's other contents are settings you glance at, so they share
          one quieter line. */}
      <div className="key">
        <SortSelect kind="leads" id="leadSort" />
        <GeoKey settings={settings} />
        {/* Only true under the default sort - a flat sort means proximity no
            longer decides the order, so the legend shouldn't claim it does. */}
        {prefs.leadSort === "priority" && <span>Closest roles sorted first</span>}
        <span className="key-run">
          {isAll ? trackCountLine(tracks) : <RunStamp track={track} settings={settings} />}
        </span>
      </div>
    </>
  );

  if (!all.length && isAll) {
    return (
      <>
        {toolbar}
        <div className="card empty">
          <strong>Nothing open right now</strong>
          No tracked search has a posting waiting to be looked at — everything found so far has been applied to or ruled
          out. New postings land here as the daily runs find them.
        </div>
      </>
    );
  }

  if (!all.length) {
    // An empty track has more than one story behind it, and they read very
    // differently. Whether anything is still tracked separates a search that has
    // turned up nothing from one whose finds have all been applied to; the run
    // record separates a real zero from a search that hasn't run in a week.
    const st = runState(track?.last_run, settings);
    // Both states earn the warning. Parenthesised because `a || b && x` binds as
    // `a || (b && x)`, which rendered the boolean `true` - nothing at all - for a
    // stale search, the very case the warning exists for.
    const warn = (st === "stale" || st === "error") && (
      <div className="empty-warn">
        But this search hasn’t reported a clean run recently — check the scheduled task before reading this as a genuine
        zero.
      </div>
    );
    return (
      <>
        {toolbar}
        <div className="card empty">
          {tracked.length ? (
            <>
              <strong>Nothing open right now</strong>
              Everything this search is still tracking has been applied to — it’s all in the Applications tab. New
              postings land here as the daily run finds them.
            </>
          ) : (
            <>
              <strong>No postings yet</strong>
              The {(track?.label ?? trackKey).toLowerCase()} search hasn’t turned up a verified opening yet. An empty day
              is a real result — nothing gets padded in here.
            </>
          )}
          {warn}
        </div>
      </>
    );
  }

  if (!rows.length) {
    return (
      <>
        {toolbar}
        <div className="card empty">
          <strong>Nothing matches</strong>Try a different filter.
        </div>
      </>
    );
  }

  const trackLabel = (l: Lead) => tracks[l.search]?.label ?? l.search;

  if (prefs.view === "grid") {
    return (
      <>
        {toolbar}
        <LeadsGrid rows={rows} trackKey={trackKey} isAll={isAll} data={data} trackLabel={trackLabel} />
        <div className="note">
          Quick-scan columns only — referral, notes, team, setup, and the rest are in Detail view (click a row to open
          them). Edits save when you click away. {rows.length} of {all.length} shown.
        </div>
      </>
    );
  }

  const selectedId = prefs.selected[trackKey];
  const sel = rows.find((l) => String(l.id) === String(selectedId)) ?? rows[0];

  return (
    <>
      {toolbar}
      <div className="md">
        <div className="md-list">
          {rows.map((l) => {
            const g = geo(l.location, settings.priority_locations);
            return (
              <div
                key={l.id}
                className={`md-row${l.id === sel.id ? " sel" : ""}${g ? ` ${g.p}` : ""}`}
                role="button"
                tabIndex={0}
                aria-pressed={l.id === sel.id}
                onClick={() => selectRow(trackKey, String(l.id))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selectRow(trackKey, String(l.id));
                  }
                }}
              >
                <div className="md-row-top">
                  <span className="co">{l.company}</span>
                  <Pill status={l.status} />
                </div>
                <div className="md-row-ttl">
                  {l.title}
                  {/* In the pooled list, which search found a posting is the one
                      thing a row no longer says by virtue of which tab you are on. */}
                  {isAll && <span className="md-row-track">{trackLabel(l)}</span>}
                </div>
                <div className="md-row-loc">
                  <span className="md-row-place">{l.location}</span>
                  <GeoBadge location={l.location} settings={settings} />
                  <span className="md-row-found" title="Date this listing was added">
                    Found <span className="mono">{l.found}</span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="md-detail">
          <LeadDetail lead={sel} data={data} />
        </div>
      </div>
      <div className="note">
        Status, notes, and details save when you click away from the field. {rows.length} of {all.length} shown.
      </div>
    </>
  );
}

/** Clearing a drill is a link back to the same tab without the query param. */
function clearDrillTo(trackKey: string, params: URLSearchParams): string {
  const next = new URLSearchParams(params);
  next.delete("drill");
  const q = next.toString();
  return pathForTab(trackKey) + (q ? `?${q}` : "");
}

/**
 * The grid is for a fast scan without scrolling, so it shows a deliberately
 * short list of columns - Detail view has the rest. Comp earns the one extra
 * because it is the field most likely to change whether a posting is worth a
 * second look.
 */
const LEAD_GRID_FIELDS: readonly (readonly [string, string])[] = [["comp", "Comp range"]];

/** A click on a row toggles it - except a click on an actual control, which does its own thing. */
function isControl(e: MouseEvent) {
  return !!(e.target as HTMLElement).closest("input,select,textarea,a,button");
}

function LeadsGrid({
  rows,
  trackKey,
  isAll,
  data,
  trackLabel,
}: {
  rows: Lead[];
  trackKey: string;
  isAll: boolean;
  data: TrackerData;
  trackLabel: (l: Lead) => string;
}) {
  const prefs = usePrefs();
  const { settings } = data;
  const cols = 6 + LEAD_GRID_FIELDS.length + (isAll ? 1 : 0);

  return (
    <div className="card grid-wrap">
      <table>
        <thead>
          <tr>
            <th>Company</th>
            <th>Role</th>
            <th>Location</th>
            <th>Status</th>
            {LEAD_GRID_FIELDS.map(([, label]) => (
              <th key={label}>{label}</th>
            ))}
            {isAll && <th>Search</th>}
            <th>Found</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => {
            const g = geo(l.location, settings.priority_locations);
            const open = !!prefs.expanded[l.id];
            const cls = [g ? g.p : "", String(prefs.selected[trackKey]) === String(l.id) ? "gr-sel" : ""]
              .filter(Boolean)
              .join(" ");
            // Opening or closing a row is what "highlights" it: it is the row
            // Detail view lands on when you switch there.
            const toggle = () =>
              setPrefs({
                expanded: { ...prefs.expanded, [l.id]: !open },
                selected: { ...prefs.selected, [trackKey]: String(l.id) },
              });
            const url = safeUrl(l.url);
            return (
              <Fragment key={l.id}>
                <tr
                  data-expand={l.id}
                  className={cls || undefined}
                  onClick={(e) => {
                    if (!isControl(e)) toggle();
                  }}
                >
                  <td className="co cc" title={l.company}>
                    {l.company}
                  </td>
                  <td className="rc">
                    {url ? (
                      <a href={url} target="_blank" rel="noopener noreferrer" title={l.title}>
                        {l.title}
                      </a>
                    ) : (
                      l.title
                    )}
                  </td>
                  {/* The tier is the stripe down the row's left edge, not a
                      badge here: a grid is scanned down a column, and the same
                      ranking said twice on one row is one more thing to read
                      past. Detail view keeps the badge. */}
                  <td className="loc" title={l.location}>
                    <div className="loc-txt">{l.location}</div>
                  </td>
                  <td>
                    <LeadStatusSelect lead={l} />
                  </td>
                  {LEAD_GRID_FIELDS.map(([field, label]) => (
                    <td key={field}>
                      <EditableField row={l} kind="lead" field={field} ariaLabel={label} />
                    </td>
                  ))}
                  {isAll && (
                    <td className="cc" title={trackLabel(l)}>
                      {trackLabel(l)}
                    </td>
                  )}
                  <td className="dt mono">{l.found}</td>
                  <td className="exp-ind">
                    <button type="button" aria-expanded={open} onClick={toggle}>
                      {open ? "Hide" : "Details"}
                    </button>
                  </td>
                </tr>
                {open && (
                  <tr className="more-row">
                    <td colSpan={cols}>
                      <LeadFactsCard lead={l} compact />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LeadDetail({ lead, data }: { lead: Lead; data: TrackerData }) {
  const { settings } = data;
  const g = geo(lead.location, settings.priority_locations);
  const url = safeUrl(lead.url);
  return (
    <>
      <MoveLead lead={lead} data={data} />
      <div className="dh-head">
        <h1 title={lead.company}>{lead.company}</h1>
        <div className="dh-sub">{lead.title}</div>
        <div className="dh-meta">
          {lead.location}
          {g && (
            <>
              {" · "}
              <span className={`geo ${g.p}`}>{g.label}</span>
            </>
          )}
          {url && (
            <>
              {" · "}
              <a href={url} target="_blank" rel="noopener noreferrer">
                View posting ↗
              </a>
            </>
          )}
        </div>
      </div>
      {lead.fit && <div className="dh-fit">{lead.fit}</div>}
      <div className="dh-status">
        <LeadStatusSelect lead={lead} />
        <span className="dh-dates">
          Found {lead.found} &middot; Confirmed live {lead.verified}
        </span>
        <RemoveLead lead={lead} />
      </div>
      <LeadFactsCard lead={lead} />
      <NotesBlock row={lead} kind="lead" placeholder="Add a note" />
    </>
  );
}

/**
 * The track line of a lead's header.
 *
 * A board with one track has nowhere to move a lead to, so it stays the plain
 * label it always was; with more, it is a picker over every configured tab.
 * Options carry the track *key* rather than the label, so two tabs sharing a
 * label still move correctly and a rename does not break the control.
 */
function MoveLead({ lead, data }: { lead: Lead; data: TrackerData }) {
  const move = useMoveLead();
  const tracks = buildTracks(data.tracks);
  const keys = Object.keys(tracks);
  if (keys.length < 2) return <div className="dh-track">{tracks[lead.search]?.label ?? lead.search}</div>;
  return (
    <select
      className="dh-track-in"
      value={lead.search}
      title="Move this posting to another tab"
      aria-label="Tab"
      onChange={(e) => move.mutate({ id: lead.id, search: e.target.value })}
    >
      {keys.map((k) => (
        <option key={k} value={k}>
          {tracks[k].label}
        </option>
      ))}
    </select>
  );
}

/**
 * Removing a posting asks for a reason rather than just confirming.
 *
 * The reason is stored on the screened row the removal leaves behind, which is
 * both the only lasting record of why it went and the thing that stops
 * tomorrow's run rediscovering the URL and adding it straight back.
 */
function RemoveLead({ lead }: { lead: Lead }) {
  const del = useDeleteLead();
  const name = `${lead.company} ${lead.title}`.trim() || "this posting";
  return (
    <button
      className="icon-btn danger"
      type="button"
      title="Remove this posting"
      aria-label={`Remove ${name}`}
      onClick={() => {
        const why = window.prompt(
          `Remove ${name}?\n\nWhy? This is kept so the search doesn't find it again.`,
          "outside target locations",
        );
        if (why?.trim()) del.mutate({ id: lead.id, reason: why.trim() });
      }}
    >
      <TrashIcon />
    </button>
  );
}
