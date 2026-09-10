/**
 * A track's leads, or every track's for the pooled tab.
 *
 * One component draws both: `key === ALL_LEADS` is the only difference that
 * reaches the rows. Everything a single track has and a pooled list cannot
 * - its description, its run stamp, the empty state that explains why a search
 * found nothing - is skipped rather than faked.
 *
 * Read-only in this phase. Status pickers and fields are rendered so the layout
 * is real, and marked readOnly/disabled rather than removed.
 */
import { useSearchParams } from "react-router-dom";
import type { Lead, TrackerData } from "../api/schema";
import { ALL_LEADS, LEAD_STATUS, ROLE_FIELDS } from "../domain/constants";
import { drillKeeps, leadRows } from "../domain/drills";
import { safeUrl } from "../domain/format";
import { geo } from "../domain/geo";
import { leadComparator } from "../domain/rows";
import { runState } from "../domain/runs";
import { buildTracks, pathForTab, trackCountLine } from "../domain/tabs";
import { setPrefs, usePrefs } from "../ui/prefs";
import { DrillChip, FactsCards, GeoBadge, GeoKey, Pill, RunStamp, SortSelect, ViewSwitch } from "./bits";

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
  const scopeLabel = isAll ? settings.all_leads_label || "All leads" : track?.label ?? trackKey;

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
    const warn = st === "stale" || st === "error" && (
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
          them). {rows.length} of {all.length} shown.
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
                onClick={() => setPrefs({ selected: { ...prefs.selected, [trackKey]: String(l.id) } })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setPrefs({ selected: { ...prefs.selected, [trackKey]: String(l.id) } });
                  }
                }}
              >
                <div className="md-row-top">
                  <span className="co">{l.company}</span>
                  <Pill status={l.status} />
                </div>
                <div className="md-row-ttl">
                  {l.title}
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
          <LeadDetail lead={sel} trackLabel={tracks[isAll ? sel.search : trackKey]?.label ?? trackKey} data={data} />
        </div>
      </div>
      <div className="note">
        {rows.length} of {all.length} shown. Editing arrives in Phase 4 — this view is read-only for now.
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

const LEAD_GRID_FIELDS: readonly (readonly [string, string])[] = [["comp", "Comp range"]];

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
            const row = l as unknown as Record<string, string>;
            const toggle = () =>
              setPrefs({
                expanded: { ...prefs.expanded, [l.id]: !open },
                selected: { ...prefs.selected, [trackKey]: String(l.id) },
              });
            return (
              <>
                <tr key={l.id} className={cls || undefined}>
                  <td className="co cc" title={l.company}>
                    {l.company}
                  </td>
                  <td className="rc">
                    {safeUrl(l.url) ? (
                      <a href={safeUrl(l.url)} target="_blank" rel="noopener noreferrer" title={l.title}>
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
                    <select value={l.status} disabled aria-label="Status">
                      {LEAD_STATUS.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                  {LEAD_GRID_FIELDS.map(([field, label]) => (
                    <td key={field}>
                      <input type="text" value={row[field] ?? ""} aria-label={label} readOnly />
                    </td>
                  ))}
                  {isAll && (
                    <td className="cc" title={trackLabel(l)}>
                      {trackLabel(l)}
                    </td>
                  )}
                  <td className="dt mono">{l.found}</td>
                  <td className="exp-ind">
                    <button type="button" className="linkish" onClick={toggle}>
                      {open ? "Hide" : "Details"}
                    </button>
                  </td>
                </tr>
                {open && (
                  <tr className="more-row" key={`${l.id}-more`}>
                    <td colSpan={cols}>
                      <div className="facts-card" style={{ marginTop: 0 }}>
                        <FactsCards item={l} fields={ROLE_FIELDS} />
                      </div>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LeadDetail({ lead, trackLabel, data }: { lead: Lead; trackLabel: string; data: TrackerData }) {
  const { settings } = data;
  const g = geo(lead.location, settings.priority_locations);
  const url = safeUrl(lead.url);
  return (
    <>
      <div className="dh-track">{trackLabel}</div>
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
        <select value={lead.status} disabled aria-label="Status">
          {LEAD_STATUS.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <span className="dh-dates">
          Found {lead.found} &middot; Confirmed live {lead.verified}
        </span>
      </div>
      <div className="facts-card">
        <FactsCards item={lead} fields={ROLE_FIELDS} />
      </div>
    </>
  );
}
