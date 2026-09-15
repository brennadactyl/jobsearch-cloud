/**
 * The Overview's chart pieces: a figure that opens its rows, a column chart, a
 * stacked bar, and the table view every chart can switch to. Plain HTML - a
 * chart here is a handful of bars, and a mark has to be a real link.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { DrillTarget } from "../domain/drills";
import { pathForTarget } from "../domain/tabs";

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

/** Switches a chart to the same rows as an HTML table. */
export function TableToggle({ on, set }: { on: boolean; set: (on: boolean) => void }) {
  return (
    <button type="button" className="ch-toggle" aria-pressed={on} onClick={() => set(!on)}>
      {on ? "Show as chart" : "Show as table"}
    </button>
  );
}

export function ChartHead({ title, sub, toggle }: { title: string; sub?: ReactNode; toggle?: ReactNode }) {
  return (
    <div className="ch-head">
      <h3>{title}</h3>
      {sub && <span className="ch-sub">{sub}</span>}
      {toggle}
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
  /** A token class: s-accent, s-soft, s-line or s-crit. */
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
