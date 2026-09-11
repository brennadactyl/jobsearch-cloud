import { Fragment, useState, type MouseEvent } from "react";
import { useSearchParams } from "react-router-dom";
import type { Application, TrackerData } from "../api/schema";
import { useAddApplication, useDeleteApplication } from "../api/mutations";
import { appRows, drillKeeps } from "../domain/drills";
import { daysSince, hostOf, safeUrl } from "../domain/format";
import { geo } from "../domain/geo";
import { appComparator, fillState, type FillState } from "../domain/rows";
import { buildTracks, pathForTab } from "../domain/tabs";
import { revealSelectedRow } from "../ui/hooks";
import { saved } from "../ui/saved";
import { selectRow, setPrefs, shownRow, usePrefs } from "../ui/prefs";
import { DrillChip, GeoBadge, GeoKey, Pill, SortSelect, TrashIcon, ViewSwitch } from "./bits";
import { AppFactsCards, AutofillNote, NotesBlock } from "./facts";
import { AppStatusSelect, EditableField, StageDateModal, type PendingStage } from "./writes";

export default function ApplicationsTab({ data }: { data: TrackerData }) {
  const { settings } = data;
  const prefs = usePrefs();
  const [params] = useSearchParams();
  const drill = params.get("drill");

  const [link, setLink] = useState("");
  const [pending, setPending] = useState<PendingStage | null>(null);
  const addApp = useAddApplication();

  // The duplicate check is exact-match only: it catches pasting the same URL
  // twice. The box empties once there is a row for it, so a failed save leaves
  // the link there to retry.
  const add = () => {
    const url = link.trim();
    if (url) {
      const same = data.applications.find((a) => String(a.link || "").trim().toLowerCase() === url.toLowerCase());
      if (same) {
        setLink("");
        selectRow("applications", String(same.id));
        saved.note("Already in your applications");
        return;
      }
    }
    addApp.mutate(
      { link: url },
      {
        onSuccess: (app) => {
          setLink("");
          selectRow("applications", String(app.id));
          saved.note(url ? "Added — it fills in overnight" : "Saved");
        },
      },
    );
  };

  const all = appRows(data.applications).sort(appComparator(prefs.appSort));
  const rows = all.filter((a) => drillKeeps(drill, "apps", a, settings));

  const clearTo = () => {
    const next = new URLSearchParams(params);
    next.delete("drill");
    const q = next.toString();
    return pathForTab("applications") + (q ? `?${q}` : "");
  };

  const toolbar = (
    <>
      <div className="toolbar">
        <div className="search">
          <input
            type="url"
            id="appurl"
            placeholder="Paste a link straight to the job posting"
            aria-label="Link to a job posting"
            aria-describedby="addhint"
            // "Straight to" is the constraint: the run opens exactly this URL,
            // so a search page or a careers index produces a row nothing can fill.
            title="The posting’s own page, not a search or a careers index — that page is what tonight’s run opens and reads. Greenhouse, Lever, Workday and company careers pages all work."
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
        </div>
        {/* Never disabled: with the box empty it adds a blank row. */}
        <button className={link.trim() ? "btn primary" : "btn"} id="addapp" type="button" onClick={add}>
          {link.trim() ? "Add from link" : "Add empty row"}
        </button>
        <span className="hint" id="addhint">
          {link.trim()
            ? "Tonight’s run opens the posting and fills in the company, role and location."
            : "Adds a row for you to fill in yourself."}
        </span>
        <ViewSwitch />
      </div>
      <div className="key">
        <SortSelect kind="applications" id="appSort" />
        {/* Rows here carry the same tier stripe the leads grids do, and a colour
            down the edge of a row says nothing without the ranking it belongs to. */}
        <GeoKey settings={settings} />
        {drill && (
          <div className="chips">
            <DrillChip drill={drill} settings={settings} clearTo={clearTo()} />
          </div>
        )}
      </div>
    </>
  );

  const modal = <StageDateModal pending={pending} onClose={() => setPending(null)} />;

  if (!all.length) {
    return (
      <>
        {toolbar}
        <div className="card empty">
          <strong>No applications logged</strong>
          When you apply to something, add it here to track the conversation. Days-since and the follow-up list update
          themselves.
        </div>
        {modal}
      </>
    );
  }

  if (!rows.length) {
    return (
      <>
        {toolbar}
        <div className="card empty">
          <strong>Nothing matches</strong>
          No application matches this filter. Clear it above to see all {all.length}.
        </div>
        {modal}
      </>
    );
  }

  if (prefs.view === "grid") {
    return (
      <>
        {toolbar}
        <AppsGrid rows={rows} data={data} pending={pending} setPending={setPending} />
        <div className="note">
          Quick-scan columns only — referral, notes, team, setup, comp, and the rest are in Detail view (click a row to open
          them). Edits save when you click away. Days counts from the applied date.
        </div>
        {modal}
      </>
    );
  }

  const sel = shownRow(rows, prefs.selected.applications);

  return (
    <>
      {toolbar}
      <div className="md">
        <div className="md-list" ref={revealSelectedRow}>
          {rows.map((a) => {
            const g = geo(a.location, settings.priority_locations);
            const d = daysSince(a.dateApplied);
            const label = a.company || hostOf(a.link) || "Untitled";
            return (
              <div
                key={a.id}
                className={`md-row${a.id === sel.id ? " sel" : ""}${g ? ` ${g.p}` : ""}`}
                role="button"
                tabIndex={0}
                aria-pressed={a.id === sel.id}
                onClick={() => selectRow("applications", String(a.id))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selectRow("applications", String(a.id));
                  }
                }}
              >
                <div className="md-row-top">
                  <span className="co">{label}</span>
                  <Pill status={a.status} />
                </div>
                <div className="md-row-ttl">
                  {a.title || (a.autofill === "failed" ? "Couldn’t read the posting" : "—")}
                </div>
                <div className="md-row-loc">
                  <span className="md-row-place">{a.location}</span>
                  <GeoBadge location={a.location} settings={settings} />
                  {a.status === "To Apply" ? (
                    <span className="md-row-found">Not applied yet</span>
                  ) : (
                    a.dateApplied && (
                      <span className="md-row-found" title="Date applied">
                        Applied <span className="mono">{a.dateApplied}</span>
                        {d !== null && ` · ${d}d`}
                      </span>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="md-detail">
          <AppDetail app={sel} data={data} pending={pending} onNeedsDate={setPending} />
        </div>
      </div>
      <div className="note">Edits save when you click away. Days counts from the applied date.</div>
      {modal}
    </>
  );
}

/** Just confirms: unlike a lead, nothing has to stop a search rediscovering it. */
function RemoveApp({ app, icon }: { app: Application; icon?: boolean }) {
  const del = useDeleteApplication();
  const name = `${app.company} ${app.title}`.trim() || "this row";
  const onClick = () => {
    if (window.confirm(`Remove ${name} from Applications?`)) del.mutate({ id: app.id });
  };
  return icon ? (
    <button
      className="icon-btn danger"
      type="button"
      title="Remove application"
      aria-label={`Remove ${name}`}
      onClick={onClick}
    >
      <TrashIcon />
    </button>
  ) : (
    <button className="btn ghost" type="button" title="Remove" aria-label={`Remove ${name}`} onClick={onClick}>
      ×
    </button>
  );
}

/** The track an application came from, when it came from a lead - the one thing the tab no longer says by itself. */
function appTrackLabel(app: Application, data: TrackerData): string {
  if (!app.leadId) return "";
  const lead = data.leads.find((l) => String(l.id) === String(app.leadId));
  return lead ? (buildTracks(data.tracks)[lead.search]?.label ?? "") : "";
}

/** Order is what needs you first. The middle group takes the tab's own name from config. */
function groupsFor(rows: Application[], applicationsLabel: string) {
  const specs: { key: FillState; label: string; note: string }[] = [
    { key: "stuck", label: "Couldn’t be read", note: "type it in, no run will fix this" },
    { key: "", label: applicationsLabel || "Applications", note: "" },
    { key: "waiting", label: "Waiting on tonight’s fill", note: "added by link, nothing to do" },
  ];
  return specs
    .map((g) => ({ ...g, rows: rows.filter((a) => fillState(a) === g.key) }))
    .filter((g) => g.rows.length);
}

/** A click on a row toggles it - except a click on an actual control, which does its own thing. */
function isControl(e: MouseEvent) {
  return !!(e.target as HTMLElement).closest("input,select,textarea,a,button");
}

function AppsGrid({
  rows,
  data,
  pending,
  setPending,
}: {
  rows: Application[];
  data: TrackerData;
  pending: PendingStage | null;
  setPending: (p: PendingStage) => void;
}) {
  const prefs = usePrefs();
  const { settings } = data;
  const COLS = 9;
  const groups = groupsFor(rows, settings.applications_label);
  // On a day when every posting read cleanly there is one group, and a lone
  // divider across the whole table says nothing anyone needs.
  const grouped = groups.length > 1;
  const shownId = shownRow(rows, prefs.selected.applications).id;

  return (
    <div className="card grid-wrap">
      <table>
        <thead>
          <tr>
            <th>Company</th>
            <th>Role</th>
            <th>Location</th>
            <th>Link</th>
            <th>Status</th>
            <th>Applied</th>
            <th>Days</th>
            <th />
            <th />
          </tr>
        </thead>
        <tbody>
          {groups.map((grp) => {
            const shut = grouped && !!prefs.collapsed[grp.key];
            return (
              <Fragment key={`g-${grp.key}`}>
                {grouped && (
                  <tr className={`group${grp.key ? ` ${grp.key}` : ""}`}>
                    <td colSpan={COLS}>
                      {/* The whole divider is the control - an 11px caret is a
                          poor click target and there is nothing else on the row. */}
                      <button
                        className="grp"
                        type="button"
                        aria-expanded={!shut}
                        onClick={() => setPrefs({ collapsed: { ...prefs.collapsed, [grp.key]: !shut } })}
                      >
                        <span className="caret" aria-hidden="true">
                          ▾
                        </span>
                        {grp.label}
                        <span className="cnt">
                          {grp.rows.length}
                          {grp.note && ` · ${grp.note}`}
                        </span>
                      </button>
                    </td>
                  </tr>
                )}
                {!shut &&
                  grp.rows.map((a) => {
                    const g = geo(a.location, settings.priority_locations);
                    const open = !!prefs.expanded[a.id];
                    const d = daysSince(a.dateApplied);
                    const link = safeUrl(a.link);
                    // A stuck row's edge says stuck rather than how close the
                    // job is: it has no location yet to be close to.
                    const cls = [
                      g && grp.key !== "stuck" ? g.p : "",
                      grp.key === "stuck" ? "stuck" : "",
                      a.id === shownId ? "gr-sel" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    const ph = grp.key === "waiting" ? "Reads overnight" : grp.key === "stuck" ? "Type it in" : "";
                    // Opening or closing a row is what "highlights" it: it is the
                    // row Detail view lands on when you switch there.
                    const toggle = () =>
                      setPrefs({
                        expanded: { ...prefs.expanded, [a.id]: !open },
                        selected: { ...prefs.selected, applications: String(a.id) },
                      });
                    return (
                      <Fragment key={a.id}>
                        <tr
                          data-expand={a.id}
                          className={cls || undefined}
                          onClick={(e) => {
                            if (!isControl(e)) toggle();
                          }}
                        >
                          <td>
                            <EditableField
                              row={a}
                              kind="application"
                              field="company"
                              placeholder={ph || "Company"}
                              ariaLabel="Company"
                            />
                          </td>
                          <td>
                            <EditableField row={a} kind="application" field="title" placeholder={ph || "Role"} ariaLabel="Role" />
                          </td>
                          <td className="loc">
                            <EditableField
                              row={a}
                              kind="application"
                              field="location"
                              placeholder={ph || "Location"}
                              ariaLabel="Location"
                            />
                          </td>
                          <td className="lk">
                            {link ? (
                              <a href={link} target="_blank" rel="noopener noreferrer" title={link}>
                                {hostOf(a.link)} ↗
                              </a>
                            ) : (
                              <span className="lk-none">—</span>
                            )}
                          </td>
                          <td>
                            <AppStatusSelect app={a} pending={pending} onNeedsDate={setPending} />
                          </td>
                          <td>
                            <EditableField row={a} kind="application" field="dateApplied" type="date" ariaLabel="Date applied" />
                          </td>
                          {/* Days counts from an applied date, which a row in
                              either fill state hasn't got - so the column says
                              what the row is waiting on instead of a dash. */}
                          <td className={`dt${grp.key ? "" : " mono"}`}>
                            {grp.key === "waiting" ? (
                              <span className="eta">
                                <i className="pulse" />
                                Tonight
                              </span>
                            ) : grp.key === "stuck" ? (
                              <span className="stuck-note" title={a.autofill_note}>
                                <i className="mark" />
                                {a.autofill_note || "Couldn’t read it"}
                              </span>
                            ) : d === null ? (
                              "—"
                            ) : (
                              d
                            )}
                          </td>
                          <td className="exp-ind">
                            <button type="button" aria-expanded={open} onClick={toggle}>
                              {open ? "Hide" : "Details"}
                            </button>
                          </td>
                          <td>
                            <RemoveApp app={a} />
                          </td>
                        </tr>
                        {open && (
                          <tr className="more-row">
                            <td colSpan={COLS}>
                              <AutofillNote app={a} />
                              <AppFactsCards app={a} compact />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * An application's detail pane. The header fields are inputs, not text: for a
 * row added as nothing but a URL this is the place to type the company, role and
 * location in, and correcting them is as common as reading them.
 */
function AppDetail({
  app,
  data,
  pending,
  onNeedsDate,
}: {
  app: Application;
  data: TrackerData;
  pending: PendingStage | null;
  onNeedsDate: (p: PendingStage) => void;
}) {
  const { settings } = data;
  const d = daysSince(app.dateApplied);
  const g = geo(app.location, settings.priority_locations);
  const track = appTrackLabel(app, data);
  const safe = safeUrl(app.link);

  return (
    <>
      <div className="dh-app-top">
        <div className="dh-app-fields">
          {track && <div className="dh-track">{track}</div>}
          <EditableField
            row={app}
            kind="application"
            field="company"
            className="dh-in dh-h1"
            placeholder="Company"
            ariaLabel="Company"
          />
          <EditableField
            row={app}
            kind="application"
            field="title"
            className="dh-in dh-sub-in"
            placeholder="Role"
            ariaLabel="Role"
          />
          <div className="dh-meta dh-app-meta">
            {/* Sized to its text, so a full-width box doesn't push the tier and
                link to the far edge. */}
            <EditableField
              row={app}
              kind="application"
              field="location"
              className="dh-in dh-loc-in"
              size={Math.max(14, Math.min(38, (app.location || "").length + 1))}
              placeholder="Location"
              ariaLabel="Location"
            />
            {g && <span className={`geo ${g.p}`}>{g.label}</span>}
            {safe && (
              <>
                <span className="dh-sep">·</span>
                <a href={safe} target="_blank" rel="noopener noreferrer">
                  View posting ↗
                </a>
              </>
            )}
          </div>
        </div>
        <RemoveApp app={app} icon />
      </div>

      <div className="dh-status">
        <AppStatusSelect app={app} pending={pending} onNeedsDate={onNeedsDate} />
        <span className="dh-dates">
          Applied <EditableField row={app} kind="application" field="dateApplied" type="date" ariaLabel="Date applied" />
          {d !== null && ` · ${d} days`}
        </span>
      </div>

      <AutofillNote app={app} />
      <AppFactsCards app={app} />
      <NotesBlock row={app} kind="application" />
    </>
  );
}
