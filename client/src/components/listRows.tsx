/**
 * The row shapes both list tabs draw, Leads and Applications alike: the
 * clickable row in Detail view's list, and the expandable row in Grid view.
 * What goes inside a row is the tab's own business; how a row is selected or
 * opened is the same everywhere, so it lives here once.
 */
import type { MouseEvent, ReactNode } from "react";

/**
 * A row in Detail view's list. It is a `div` with a button role rather than a
 * `button`, because it holds block layout; the role, tab stop and Enter/Space
 * handling are what make it one to a keyboard or a screen reader.
 */
export function SelectableRow({
  selected,
  tierClass,
  onSelect,
  children,
}: {
  selected: boolean;
  /** The tier stripe class from `matchLocationTier()`, or "" for none. */
  tierClass: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={`md-row${selected ? " sel" : ""}${tierClass ? ` ${tierClass}` : ""}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {children}
    </div>
  );
}

/**
 * A row in Grid view. A click anywhere on it toggles its details - except a
 * click on a control inside it, which does its own thing.
 */
export function ExpandableRow({
  id,
  className,
  onToggle,
  children,
}: {
  id: number;
  className: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <tr
      data-expand={id}
      className={className || undefined}
      onClick={(e) => {
        if (!isClickOnControl(e)) onToggle();
      }}
    >
      {children}
    </tr>
  );
}

function isClickOnControl(e: MouseEvent) {
  return !!(e.target as HTMLElement).closest("input,select,textarea,a,button");
}
