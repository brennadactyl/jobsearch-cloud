/**
 * A track's leads, or every track's for the pooled tab. What only a single track
 * has - its run stamp, the empty state explaining why a search found nothing -
 * is skipped for the pooled tab rather than faked.
 */
import { Fragment } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Lead, TrackerData } from "../api/schema";
import { useDeleteLead, useMoveLead, type LeavingView } from "../api/mutations";
import { ALL_LEADS, LABELS, LEAD_STATUS } from "../domain/constants";
import { ALL_FILTER, OPEN_FILTER, drillKeeps, leadFilterKeeps, leadRows, resolveLeadFilter } from "../domain/drills";
import { leadColumns } from "../domain/export";
import { safeUrl } from "../domain/format";
import { geo } from "../domain/geo";
import { leadComparator } from "../domain/rows";
import { runState } from "../domain/runs";
import { buildTracks, pathForTab, pathWithoutDrill, trackCountLine } from "../domain/tabs";
import { revealSelectedRow } from "../ui/hooks";
import { selectRow, shownRow, toggleGridRow, usePrefs } from "../ui/prefs";
import { DrillChip, ExportButton, GeoBadge, GeoKey, Pill, RunStamp, SortSelect, TrashIcon, ViewSwitch } from "./bits";
import { LeadFactsCard, NotesBlock } from "./facts";
import { ExpandableRow, SelectableRow } from "./listRows";
import { EditableField, LeadStatusSelect } from "./writes";

export default function LeadsTab({ data, trackKey }: { data: TrackerData; trackKey: string }) {
  const { settings } = data;
  const prefs = usePrefs();
  const [params, setParams] = useSearchParams();
  const drill = params.get("drill");
  const filter = resolveLeadFilter(params.get("filter"));
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
  const narrowed = (l: Lead) =>
    drillKeeps(drill, "leads", l, data) &&
    (!needle || `${l.company} ${l.title} ${l.location}`.toLowerCase().includes(needle));
  const rows = all
    .filter((l) => leadFilterKeeps(filter, l) && narrowed(l))
    .sort(leadComparator(prefs.leadSort, settings.priority_locations));

  const withFilter = (f: string) => {
    const next = new URLSearchParams(params);
    if (f === OPEN_FILTER) next.delete("filter");
    else next.set("filter", f);
    const qs = next.toString();
    return pathForTab(trackKey) + (qs ? `?${qs}` : "");
  };

  // A status change that hides its row from the chip on screen moves the
  // selection to the row that followed it, rather than back to the top.
  // Applied takes the row out of every leads tab, so its note names the tab it
  // went to rather than the chip it left.
  const onLeave = (lead: Lead, status: string): LeavingView | undefined => {
    if (status !== "Applied" && leadFilterKeeps(filter, { ...lead, status })) return undefined;
    const leaving: LeavingView = {
      note:
        status === "Applied"
          ? `Moved to ${settings.applications_label || "Applications"}`
          : `Marked ${status} — hidden from ${filter}`,
    };
    if (shownRow(rows, prefs.selected[trackKey]).id === lead.id) {
      const i = rows.findIndex((r) => r.id === lead.id);
      const next = rows[i + 1] ?? rows[i - 1];
      if (next) {
        selectRow(trackKey, String(next.id));
        leaving.restore = { scope: trackKey, id: String(lead.id) };
      }
    }
    return leaving;
  };

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
          {[OPEN_FILTER, ...LEAD_STATUS.filter((s) => s !== "Applied"), ALL_FILTER].map((f) => (
            <button
              key={f}
              className="chip"
              type="button"
              aria-pressed={filter === f}
              onClick={() => setParam("filter", f === OPEN_FILTER ? null : f)}
            >
              {f}
            </button>
          ))}
          <DrillChip drill={drill} ctx={data} clearTo={pathWithoutDrill(trackKey, params)} />
        </div>
        <ViewSwitch />
        <ExportButton rows={rows} columns={leadColumns(tracks, settings)} label={scopeLabel} />
      </div>
      {/* Sort sits in this quieter row: it is glanced at, not touched constantly. */}
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
    // Parenthesised: `a || b && x` binds as `a || (b && x)`, which renders
    // `true` (nothing) for a stale search.
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
    // Open is the default, so an empty Open list isn't something the person
    // filtered out: say what it holds instead, one click away.
    const notAFit = filter === OPEN_FILTER ? all.filter((l) => l.status === "Not a fit" && narrowed(l)).length : 0;
    return (
      <>
        {toolbar}
        <div className="card empty">
          {notAFit ? (
            <>
              <strong>Nothing open</strong>
              <Link className="jumplink" to={withFilter("Not a fit")}>
                {notAFit} marked Not a fit
              </Link>
            </>
          ) : (
            <>
              <strong>Nothing matches</strong>Try a different filter.
            </>
          )}
        </div>
      </>
    );
  }

  const trackLabel = (l: Lead) => tracks[l.search]?.label ?? l.search;

  if (prefs.view === "grid") {
    return (
      <>
        {toolbar}
        <LeadsGrid rows={rows} trackKey={trackKey} isAll={isAll} data={data} trackLabel={trackLabel} onLeave={onLeave} />
        <div className="note">
          Quick-scan columns only — referral, notes, team, setup, and the rest are in Detail view (click a row to open
          them). Edits save when you click away. {rows.length} of {all.length} shown.
        </div>
      </>
    );
  }

  const sel = shownRow(rows, prefs.selected[trackKey]);

  return (
    <>
      {toolbar}
      <div className="md">
        <div className="md-list" ref={revealSelectedRow}>
          {rows.map((l) => {
            const g = geo(l.location, settings.priority_locations);
            return (
              <SelectableRow
                key={l.id}
                selected={l.id === sel.id}
                tierClass={g ? g.p : ""}
                onSelect={() => selectRow(trackKey, String(l.id))}
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
                    {LABELS.found} <span className="mono">{l.found}</span>
                  </span>
                </div>
              </SelectableRow>
            );
          })}
        </div>
        <div className="md-detail">
          <LeadDetail lead={sel} data={data} onLeave={onLeave} />
        </div>
      </div>
      <div className="note">
        Status, notes, and details save when you click away from the field. {rows.length} of {all.length} shown.
      </div>
    </>
  );
}

/**
 * The grid is for a fast scan without scrolling, so it shows a deliberately
 * short list of columns - Detail view has the rest. Comp earns the one extra
 * because it is the field most likely to change whether a posting is worth a
 * second look.
 */
const LEAD_GRID_FIELDS: readonly (readonly [string, string])[] = [["comp", "Comp range"]];

function LeadsGrid({
  rows,
  trackKey,
  isAll,
  data,
  trackLabel,
  onLeave,
}: {
  rows: Lead[];
  trackKey: string;
  isAll: boolean;
  data: TrackerData;
  trackLabel: (l: Lead) => string;
  onLeave: (lead: Lead, status: string) => LeavingView | undefined;
}) {
  const prefs = usePrefs();
  const { settings } = data;
  const cols = 6 + LEAD_GRID_FIELDS.length + (isAll ? 1 : 0);
  const shownId = shownRow(rows, prefs.selected[trackKey]).id;

  return (
    <div className="card grid-wrap">
      <table>
        <thead>
          <tr>
            <th>{LABELS.company}</th>
            <th>{LABELS.role}</th>
            <th>{LABELS.location}</th>
            <th>{LABELS.status}</th>
            {LEAD_GRID_FIELDS.map(([, label]) => (
              <th key={label}>{label}</th>
            ))}
            {isAll && <th>{LABELS.search}</th>}
            <th>{LABELS.found}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => {
            const g = geo(l.location, settings.priority_locations);
            const open = !!prefs.expanded[l.id];
            const cls = [g ? g.p : "", l.id === shownId ? "gr-sel" : ""]
              .filter(Boolean)
              .join(" ");
            const toggle = () => toggleGridRow(trackKey, l.id);
            const url = safeUrl(l.url);
            return (
              <Fragment key={l.id}>
                <ExpandableRow id={l.id} className={cls} onToggle={toggle}>
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
                    <LeadStatusSelect lead={l} onLeave={onLeave} />
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
                </ExpandableRow>
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

function LeadDetail({
  lead,
  data,
  onLeave,
}: {
  lead: Lead;
  data: TrackerData;
  onLeave: (lead: Lead, status: string) => LeavingView | undefined;
}) {
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
        <LeadStatusSelect lead={lead} onLeave={onLeave} />
        <span className="dh-dates">
          {LABELS.found} {lead.found} &middot; {LABELS.verified} {lead.verified}
        </span>
        <RemoveLead lead={lead} />
      </div>
      <LeadFactsCard lead={lead} />
      <NotesBlock row={lead} kind="lead" placeholder="Add a note" />
    </>
  );
}

/**
 * The track line of a lead's header: a plain label with one track, a picker with
 * more. Options carry the track *key*, so two tabs sharing a label still move
 * correctly and a rename doesn't break the control.
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
      // The moved row is the one selected under its new tab, so opening that tab
      // lands on it.
      onChange={(e) =>
        move.mutate(
          { id: lead.id, search: e.target.value },
          { onSuccess: (moved) => selectRow(moved.search, String(moved.id)) },
        )
      }
    >
      {keys.map((k) => (
        <option key={k} value={k}>
          {tracks[k].label}
        </option>
      ))}
    </select>
  );
}

/** Asks for a reason rather than just confirming - see client.ts deleteLead. */
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
