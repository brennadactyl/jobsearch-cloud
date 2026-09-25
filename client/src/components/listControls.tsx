/** The controls above a leads or applications list: view, sort, the drill filter chip and CSV export. */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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
 * Downloads a list as CSV: either the rows it shows, or every row the tab holds.
 *
 * `shown` must be the array the list renders, filtered and sorted, never a
 * second filtering of its own; `all` is the tab's every row in the same sort.
 * The button always reads "Export". When the two differ it opens a menu of
 * both, with the counts; when they're the same length they're the same rows,
 * so a click downloads them and the tooltip gives the count. The counts decide
 * it, so the control never offers a choice that makes no difference. Nothing
 * is written to the server, so the save indicator stays silent.
 */
export function ExportButton<T>({
  shown,
  all,
  columns,
  label,
}: {
  shown: readonly T[];
  all: readonly T[];
  columns: readonly Column<T>[];
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Closes on a click anywhere else, and on Escape, like any menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const save = (rows: readonly T[], filtered: boolean) => {
    setOpen(false);
    if (!rows.length) return;
    const name = exportFilename(filtered ? `${label}-shown` : label, isoDay(new Date()));
    downloadFile(name, toCsv(columns, rows), "text/csv;charset=utf-8");
  };

  if (shown.length === all.length) {
    const n = all.length;
    const title =
      n === 0 ? "Nothing in this list to export" : n === 1 ? "Download the one row as a CSV file" : `Download all ${n} rows as a CSV file`;
    return (
      <button className="btn" type="button" disabled={!n} title={title} onClick={() => save(all, false)}>
        Export
      </button>
    );
  }

  // Up and Down move between the two choices, as in any menu.
  const moveFocus = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };

  return (
    <div className="export-wrap" ref={wrap}>
      <button className="btn" type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Export
        <svg className="export-caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="export-menu" role="menu" aria-label="Export" onKeyDown={moveFocus}>
          <button
            className="export-item"
            type="button"
            role="menuitem"
            disabled={!shown.length}
            autoFocus={!!shown.length}
            onClick={() => save(shown, true)}
          >
            Export {shown.length} shown
          </button>
          <button
            className="export-item"
            type="button"
            role="menuitem"
            autoFocus={!shown.length}
            onClick={() => save(all, false)}
          >
            Export all {all.length}
          </button>
        </div>
      )}
    </div>
  );
}
