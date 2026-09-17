/**
 * Scrolling from anywhere on the page. Some pages keep their header and tiles
 * still and scroll a region below them, which otherwise only moves while the
 * pointer is over it. A wheel turned anywhere else scrolls that region instead.
 *
 * The region is whatever element carries `data-wheel-target`: the Overview's
 * cards, a Detail view's list, an open dialog's body. An open dialog's region
 * wins over the page's, since the page is behind it.
 */
import { useEffect } from "react";

export const WHEEL_TARGET = "data-wheel-target";

/** Whether `el` scrolls vertically and has room to move `dy` pixels that way. */
function canScroll(el: Element, dy: number): boolean {
  const overflow = getComputedStyle(el).overflowY;
  if (overflow !== "auto" && overflow !== "scroll") return false;
  if (el.scrollHeight <= el.clientHeight) return false;
  return dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0;
}

/**
 * Where a wheel over `from` should scroll the page, or null to leave it to the
 * browser: when the pointer is already over something that can scroll that way,
 * when the page has no region, or when the region has no room to move.
 */
export function wheelTarget(from: Element, dy: number, doc: Document = document): HTMLElement | null {
  for (let el: Element | null = from; el && el !== doc.documentElement; el = el.parentElement) {
    if (canScroll(el, dy)) return null;
  }
  const dialogs = doc.querySelectorAll(".modal-overlay");
  const scope: ParentNode = dialogs.length ? dialogs[dialogs.length - 1] : doc;
  const target = scope.querySelector<HTMLElement>(`[${WHEEL_TARGET}]`);
  return target && canScroll(target, dy) ? target : null;
}

/** A wheel's vertical distance in pixels, whichever unit the device reports it in. */
function pixelsOf(e: WheelEvent, target: HTMLElement): number {
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) return e.deltaY * 16;
  if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) return e.deltaY * target.clientHeight;
  return e.deltaY;
}

/** Sends a wheel turned outside the page's scroll region into it. */
export function useWheelAnywhere(): void {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      // Pinch and ctrl+wheel zoom; a sideways scroll belongs to a wide table.
      if (e.defaultPrevented || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (!(e.target instanceof Element)) return;
      const target = wheelTarget(e.target, e.deltaY);
      if (!target) return;
      e.preventDefault();
      target.scrollTop += pixelsOf(e, target);
    };
    // Not passive, or preventDefault can't stop the page moving as well.
    document.addEventListener("wheel", onWheel, { passive: false });
    return () => document.removeEventListener("wheel", onWheel);
  }, []);
}
