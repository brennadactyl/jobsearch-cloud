/**
 * Applications: the record of what was actually applied to.
 *
 * Grid view groups rows by the overnight fill's three states, ordered by what
 * needs you first - a posting no run will ever read, then everything in normal
 * shape, then the rows that need nothing from you until tonight. Headers appear
 * only when there is more than one state to separate, so on a day when
 * everything read cleanly the tab is the plain list it has always been.
 *
 * Read-only in this phase.
 */
import { useSearchParams } from "react-router-dom";
import type { Application, TrackerData } from "../api/schema";
import { APP_ROLE_FIELDS, APP_STATUS, STAGE_HISTORY_FIELDS } from "../domain/constants";
import { appRows, drillKeeps } from "../domain/drills";
import { daysSince, hostOf, safeUrl } from "../domain/format";
import { geo } from "../domain/geo";
import { appComparator, fillState, type FillState } from "../domain/rows";
import { pathForTab } from "../domain/tabs";
import { setPrefs, usePrefs } from "../ui/prefs";
import { DrillChip, FactsCards, GeoBadge, GeoKey, Pill, SortSelect, ViewSwitch } from "./bits";

export default function ApplicationsTab({ data }: { data: TrackerData }) {
  const { settings } = data;
  const prefs = usePrefs();
  const [params] = useSearchParams();
  const drill = params.get("drill");

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
            disabled
          />
        </div>
        <button className="btn" id="addapp" type="button" disabled>
          Add empty row
        </button>
        <span className="hint" id="addhint">
          Adding arrives in Phase 4 — this view is read-only.
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

  if (!all.length) {
    return (
      <>
        {toolbar}
        <div className="card empty">
          <strong>No applications logged</strong>
          When you apply to something, add it here to track the conversation. Days-since and the follow-up list update
          themselves.
        </div>
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
      </>
    );
  }

  if (prefs.view === "grid") {
    return (
      <>
        {toolbar}
        <AppsGrid rows={rows} data={data} />
        <div className="note">
          Quick-scan columns only — referral, notes and the rest are in Detail view. {rows.length} of {all.length} shown.
        </div>
      </>
    );
  }

  const sel = rows.find((a) => String(a.id) === String(prefs.selected.applications)) ?? rows[0];

  return (
    <>
      {toolbar}
      <div className="md">
        <div className="md-list">
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
                onClick={() => setPrefs({ selected: { ...prefs.selected, applications: String(a.id) } })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setPrefs({ selected: { ...prefs.selected, applications: String(a.id) } });
                  }
                }}
              >
                <div className="md-row-top">
                  <span className="co">{label}</span>
                  <Pill status={a.status} />
                </div>
                <div className="md-row-ttl">{a.title}</div>
                <div className="md-row-loc">
                  <span className="md-row-place">{a.location}</span>
                  <GeoBadge location={a.location} settings={settings} />
                  {a.dateApplied && (
                    <span className="md-row-found" title="Date applied">
                      Applied <span className="mono">{a.dateApplied}</span>
                      {d !== null && ` · ${d}d`}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="md-detail">
          <AppDetail app={sel} data={data} />
        </div>
      </div>
      <div className="note">
        {rows.length} of {all.length} shown. Editing arrives in Phase 4 — this view is read-only for now.
      </div>
    </>
  );
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

function AppsGrid({ rows, data }: { rows: Application[]; data: TrackerData }) {
  const prefs = usePrefs();
  const { settings } = data;
  const COLS = 9;
  const groups = groupsFor(rows, settings.applications_label);
  // On a day when every posting read cleanly there is one group, and a lone
  // divider across the whole table says nothing anyone needs.
  const grouped = groups.length > 1;

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
              <>
                {grouped && (
                  <tr className={`group${grp.key ? ` ${grp.key}` : ""}`} key={`h-${grp.key}`}>
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
                      String(prefs.selected.applications) === String(a.id) ? "gr-sel" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    const ph = grp.key === "waiting" ? "Reads overnight" : grp.key === "stuck" ? "Type it in" : "";
                    return (
                      <>
                        <tr key={a.id} className={cls || undefined}>
                          <td>
                            <input type="text" value={a.company} placeholder={ph || "Company"} aria-label="Company" readOnly />
                          </td>
                          <td>
                            <input type="text" value={a.title} placeholder={ph || "Role"} aria-label="Role" readOnly />
                          </td>
                          <td className="loc">
                            <input type="text" value={a.location} placeholder={ph || "Location"} aria-label="Location" readOnly />
                          </td>
                          <td className="lk">
                            {link ? (
                              <a href={link} target="_blank" rel="noopener noreferrer" title={link}>
                                {hostOf(a.link)}
                              </a>
                            ) : (
                              <span className="lk-none">—</span>
                            )}
                          </td>
                          <td>
                            <select value={a.status} disabled aria-label="Status">
                              {APP_STATUS.map((s) => (
                                <option key={s}>{s}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input type="date" value={a.dateApplied} aria-label="Date applied" readOnly />
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
                            <button
                              type="button"
                              className="linkish"
                              onClick={() =>
                                setPrefs({
                                  expanded: { ...prefs.expanded, [a.id]: !open },
                                  selected: { ...prefs.selected, applications: String(a.id) },
                                })
                              }
                            >
                              {open ? "Hide" : "Details"}
                            </button>
                          </td>
                          <td />
                        </tr>
                        {open && (
                          <tr className="more-row" key={`${a.id}-more`}>
                            <td colSpan={COLS}>
                              <div className="facts-card" style={{ marginTop: 0 }}>
                                <FactsCards item={a} fields={APP_ROLE_FIELDS} />
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AppDetail({ app, data }: { app: Application; data: TrackerData }) {
  const { settings } = data;
  const g = geo(app.location, settings.priority_locations);
  const link = safeUrl(app.link);
  const label = app.company || hostOf(app.link) || "Untitled";
  const history = STAGE_HISTORY_FIELDS.filter(([field]) => (app as unknown as Record<string, string>)[field]);
  const state = fillState(app);

  return (
    <>
      <div className="dh-head">
        <h1 title={label}>{label}</h1>
        <div className="dh-sub">{app.title}</div>
        <div className="dh-meta">
          {app.location}
          {g && (
            <>
              {" · "}
              <span className={`geo ${g.p}`}>{g.label}</span>
            </>
          )}
          {link && (
            <>
              {" · "}
              <a href={link} target="_blank" rel="noopener noreferrer">
                View posting ↗
              </a>
            </>
          )}
        </div>
      </div>

      {/* The only thing the overnight fill says on this page, and it says it
          only when there is something to do about it. */}
      {state === "stuck" && (
        <div className="dh-fit">
          Couldn’t read this posting{app.autofill_note ? `: ${app.autofill_note}` : ""}. No later run will try again —
          type in what you know.
        </div>
      )}
      {state === "waiting" && <div className="dh-fit">Tonight’s run will read this posting and fill in what it states.</div>}

      <div className="dh-status">
        <select value={app.status} disabled aria-label="Status">
          {APP_STATUS.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        {app.dateApplied && <span className="dh-dates">Applied {app.dateApplied}</span>}
      </div>

      {history.length > 1 && (
        <div className="facts-card">
          <h4>Stage history</h4>
          <table className="stage-history">
            <tbody>
              {history.map(([field, label]) => (
                <tr key={field}>
                  <td>{label}</td>
                  <td className="mono">{(app as unknown as Record<string, string>)[field]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="facts-card">
        <FactsCards item={app} fields={APP_ROLE_FIELDS} />
      </div>
    </>
  );
}
