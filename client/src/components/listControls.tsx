/** The controls above a leads or applications list: view, sort, the drill filter chip and CSV export. */
import { Link } from "react-router-dom";
import { APP_SORTS, LEAD_SORTS } from "../domain/constants";
import { drillLabel, type DrillContext } from "../domain/drills";
import { exportFilename, toCsv, type Column } from "../domain/export";
import { isoDay } from "../domain/format";
import { downloadFile } from "../ui/download";
import { setPrefs, usePrefs } from "../ui/prefs";

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
  ctx,
  clearTo,
}: {
  drill: string | null;
  ctx: DrillContext;
  clearTo: string;
}) {
  if (!drill) return null;
  const label = drillLabel(drill, ctx);
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

/**
 * Downloads the rows a list shows as CSV. `rows` must be the array the list
 * renders, filtered and sorted, never a second filtering of its own. Nothing is
 * written to the server, so the save indicator stays silent.
 */
export function ExportButton<T>({
  rows,
  columns,
  label,
}: {
  rows: readonly T[];
  columns: readonly Column<T>[];
  label: string;
}) {
  const n = rows.length;
  return (
    <button
      className="btn"
      type="button"
      disabled={!n}
      title={
        n === 0
          ? "Nothing in this list to export"
          : n === 1
            ? "Download this row as a CSV file"
            : `Download these ${n} rows as a CSV file`
      }
      onClick={() => downloadFile(exportFilename(label, isoDay(new Date())), toCsv(columns, rows), "text/csv;charset=utf-8")}
    >
      Export {n}
    </button>
  );
}
