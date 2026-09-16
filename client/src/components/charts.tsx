/**
 * The Overview's chart pieces: a figure that opens its rows, a column chart, a
 * stacked bar, and the table view every chart can switch to. Plain HTML - a
 * chart here is a handful of bars, and a mark has to be a real link.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { DrillTarget } from "../domain/drills";
import type { FoldId } from "../domain/overview";
import { pathForTarget } from "../domain/tabs";
import { toggleOverviewFold, usePrefs } from "../ui/prefs";

interface TipState {
  text: string;
  rect: DOMRect;
}

const TipContext = createContext<(el: HTMLElement | null, text?: string) => void>(() => {});

/**
 * One tooltip for the whole page, fixed to the viewport. A tooltip inside its
 * mark would be clipped by the table's sideways-scrolling container and run off
 * a 400px screen at the edge columns; this one is placed after measuring.
 */
export function TipLayer({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<TipState | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const show = (el: HTMLElement | null, text?: string) =>
    setTip(el && text ? { text, rect: el.getBoundingClientRect() } : null);

  useLayoutEffect(() => {
    if (!tip || !ref.current) {
      setPos(null);
      return;
    }
    const { width, height } = ref.current.getBoundingClientRect();
    const margin = 8;
    const centre = tip.rect.left + tip.rect.width / 2;
    const left = Math.min(Math.max(margin, centre - width / 2), window.innerWidth - margin - width);
    const above = tip.rect.top - height - 6;
    setPos({ left, top: above >= margin ? above : tip.rect.bottom + 6 });
  }, [tip]);

  // A scroll moves the mark out from under a tooltip fixed to the viewport.
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [tip]);

  return (
    <TipContext.Provider value={show}>
      {children}
      {tip && (
        <div
          ref={ref}
          className="tip"
          role="tooltip"
          style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
        >
          {tip.text}
        </div>
      )}
    </TipContext.Provider>
  );
}

function tipHandlers(show: (el: HTMLElement | null, text?: string) => void, text: string) {
  return {
    onMouseEnter: (e: { currentTarget: HTMLElement }) => show(e.currentTarget, text),
    onFocus: (e: { currentTarget: HTMLElement }) => show(e.currentTarget, text),
    onMouseLeave: () => show(null),
    onBlur: () => show(null),
  };
}

/**
 * A figure that opens the rows it counts. Zero, or no target, is plain text:
 * there is nothing to open. `focusable` keeps a plain figure reachable by
 * keyboard when its tooltip is the only place its detail lives.
 */
export function Mark({
  n,
  target,
  tip,
  className,
  focusable,
  grow,
  children,
}: {
  n: number;
  target?: DrillTarget;
  tip: string;
  className?: string;
  focusable?: boolean;
  /** flex-grow, for a segment sized by its share of a bar. */
  grow?: number;
  children?: ReactNode;
}) {
  const show = useContext(TipContext);
  const handlers = tipHandlers(show, tip);
  const style = grow === undefined ? undefined : { flexGrow: grow };
  if (n && target) {
    return (
      <Link className={className} style={style} to={pathForTarget(target)} aria-label={tip} data-n={n} {...handlers}>
        {children}
      </Link>
    );
  }
  return (
    <span
      className={className}
      style={style}
      aria-label={tip}
      data-n={n}
      tabIndex={focusable ? 0 : undefined}
      {...handlers}
    >
      {children}
    </span>
  );
}

interface FoldState {
  open: (id: FoldId) => boolean;
  toggle: (id: FoldId) => void;
  asTable: (id: FoldId) => boolean;
  setAsTable: (id: FoldId, on: boolean) => void;
}

const FoldContext = createContext<FoldState>({
  open: () => true,
  toggle: () => {},
  asTable: () => false,
  setAsTable: () => {},
});

/**
 * What the Overview has folded, and which charts show as tables. Folds are a
 * stored preference. Table views live here rather than in each chart, because
 * folded content isn't rendered and a chart's own state would reset when its
 * section opens again.
 */
export function FoldLayer({ children }: { children: ReactNode }) {
  const { overviewCollapsed } = usePrefs();
  const [tables, setTables] = useState<Partial<Record<FoldId, boolean>>>({});
  const state: FoldState = {
    open: (id) => !overviewCollapsed[id],
    toggle: toggleOverviewFold,
    asTable: (id) => !!tables[id],
    setAsTable: (id, on) => setTables((t) => ({ ...t, [id]: on })),
  };
  return <FoldContext.Provider value={state}>{children}</FoldContext.Provider>;
}

const domId = (id: FoldId) => `ov-${id.replace(/\./g, "-")}`;

function Chevron() {
  return (
    <span className="chev" aria-hidden="true">
      ▾
    </span>
  );
}

/**
 * A top-level Overview section. Folded, its heading and subline stay as the
 * summary; everything else, empty states included, isn't rendered.
 */
export function Section({ id, title, sub, children }: { id: FoldId; title: string; sub: ReactNode; children: ReactNode }) {
  const fold = useContext(FoldContext);
  const open = fold.open(id);
  return (
    <>
      <div className="sec">
        <h2>
          <button type="button" className="fold" aria-expanded={open} aria-controls={domId(id)} onClick={() => fold.toggle(id)}>
            <Chevron />
            <span className="fold-title">{title}</span>
            <span className="fold-sub">{sub}</span>
          </button>
        </h2>
      </div>
      {open && <div id={domId(id)}>{children}</div>}
    </>
  );
}

/**
 * One chart or table inside a section. The heading button folds it; "Show as
 * table" sits outside that button, so switching views never folds anything, and
 * a folded chart hides the switch along with the chart.
 */
export function Subsection({
  id,
  title,
  sub,
  tableView,
  children,
}: {
  id: FoldId;
  title: string;
  sub?: ReactNode;
  /** Offers "Show as table"; `children` is then called with the current choice. */
  tableView?: boolean;
  children: (asTable: boolean) => ReactNode;
}) {
  const fold = useContext(FoldContext);
  const open = fold.open(id);
  const asTable = !!tableView && fold.asTable(id);
  return (
    <div className="ch-block">
      <div className={`ch-head${open ? "" : " folded"}`}>
        <h3>
          <button type="button" className="fold" aria-expanded={open} aria-controls={domId(id)} onClick={() => fold.toggle(id)}>
            <Chevron />
            <span className="fold-title">{title}</span>
            {sub && <span className="ch-sub">{sub}</span>}
          </button>
        </h3>
        {open && tableView && (
          <button type="button" className="ch-toggle" aria-pressed={asTable} onClick={() => fold.setAsTable(id, !asTable)}>
            {asTable ? "Show as chart" : "Show as table"}
          </button>
        )}
      </div>
      {open && <div id={domId(id)}>{children(asTable)}</div>}
    </div>
  );
}

export interface ColumnPoint {
  key: string;
  axis: string;
  /** Shown only on wide screens, so a narrow chart's axis doesn't collide. */
  minor?: boolean;
  n: number;
  target?: DrillTarget;
  tip: string;
  /** Drawn faded: a period still under way. */
  partial?: boolean;
}

export function ColumnChart({ label, points }: { label: string; points: readonly ColumnPoint[] }) {
  const max = Math.max(1, ...points.map((p) => p.n));
  return (
    <div role="group" aria-label={label}>
      <div className="ch-cols">
        {points.map((p) => (
          <Mark key={p.key} n={p.n} target={p.target} tip={p.tip} className={`ch-col${p.partial ? " now" : ""}`}>
            <i className="ch-fill" style={{ height: `${(p.n / max) * 100}%` }} />
          </Mark>
        ))}
      </div>
      <div className="ch-axis" aria-hidden="true">
        {points.map((p) => (
          <span key={p.key} className={p.minor ? "minor" : undefined}>
            {p.axis}
          </span>
        ))}
      </div>
    </div>
  );
}

export interface BarSegment {
  key: string;
  label: string;
  n: number;
  target: DrillTarget;
  tip: string;
  /** A token class: s-accent, s-accent-dim, s-soft, s-line, s-ink3-dim or s-crit. */
  tone: string;
}

/**
 * One stacked bar, `scale` of the row wide, with each non-zero segment labelled
 * directly beneath it. Both the segment and its label open the rows.
 */
export function StackedBar({
  label,
  segments,
  scale = 1,
}: {
  label: string;
  segments: readonly BarSegment[];
  scale?: number;
}) {
  const total = segments.reduce((s, x) => s + x.n, 0);
  return (
    <div role="group" aria-label={label}>
      <div className="hbar" style={{ width: `${Math.max(0, Math.min(1, scale)) * 100}%` }}>
        {/* Each segment grows by its count, so the widths are its share of the bar. */}
        {segments.map((s) =>
          s.n ? (
            <Mark key={s.key} n={s.n} target={s.target} tip={s.tip} className={`hseg ${s.tone}`} grow={s.n} />
          ) : null,
        )}
      </div>
      <div className="legend seglabels">
        {segments
          .filter((s) => s.n)
          .map((s) => (
            <Mark key={s.key} n={s.n} target={s.target} tip={s.tip} className="seglabel">
              <b className={s.tone} />
              {s.label} <span className="mono">{s.n}</span>
            </Mark>
          ))}
        {!total && <span className="seglabel">None yet</span>}
      </div>
    </div>
  );
}

export interface TableColumn<T> {
  header: string;
  cell: (row: T) => ReactNode;
  num?: boolean;
}

/** A chart's rows as a table, scrolling sideways inside its own container. */
export function ChartTable<T>({
  label,
  columns,
  rows,
  rowKey,
}: {
  label: string;
  columns: readonly TableColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
}) {
  return (
    <div className="ch-table">
      <table aria-label={label}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.header} className={c.num ? "num" : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c) => (
                <td key={c.header} className={c.num ? "num" : undefined}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
