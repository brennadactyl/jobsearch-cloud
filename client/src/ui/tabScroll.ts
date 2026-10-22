/**
 * What a sideways-scrolling strip is hiding, and where to scroll so the next of
 * it comes fully into view.
 *
 * Separate from the component because these are the parts that can be checked:
 * jsdom gives every element a zero-sized box, so a test can exercise the
 * arithmetic and can't exercise the measuring.
 */

/** A child's span inside the strip's scrollable content, in CSS px from its start. */
export interface Span {
  start: number;
  end: number;
}

export interface View {
  scrollLeft: number;
  clientWidth: number;
}

/**
 * A pixel of slack either side: a scroll position can land fractionally, and
 * rounding it to "something is still hidden" leaves an arrow pointing at
 * nothing.
 */
const SLACK = 1;

/** Whether anything sits off each end, which is what decides if an arrow is worth showing. */
export function hiddenSides(m: View & { scrollWidth: number }): { left: boolean; right: boolean } {
  return {
    left: m.scrollLeft > SLACK,
    right: m.scrollLeft + m.clientWidth < m.scrollWidth - SLACK,
  };
}

/**
 * Where to scroll so one child is wholly in view, moving as little as it takes.
 * Arriving at a tab that sits off the end should bring it in, not re-centre the
 * strip around it: a jump further than necessary loses the tabs either side of
 * where you landed.
 *
 * Returns the current position when it is already whole, so a caller can scroll
 * to it unconditionally.
 */
export function edgeToShow(span: Span, view: View): number {
  // The same tolerance the other two use, because this file's job is to answer
  // "is this visible" once. Without it a tab clipped by half a pixel moves the
  // strip while hiddenSides reports nothing hidden and shows no arrow - two
  // answers to one question, from neighbouring functions.
  if (span.start < view.scrollLeft - SLACK) {
    return Math.max(0, span.start);
  }
  if (span.end > view.scrollLeft + view.clientWidth + SLACK) {
    return Math.max(0, span.end - view.clientWidth);
  }
  return view.scrollLeft;
}

/**
 * Where to scroll so the next child that is cut off becomes whole. A fixed step
 * would be simpler and would regularly stop with half a label showing, which
 * reads as the same bug this is here to fix.
 *
 * Returns the current position when nothing is cut off that way, so a caller
 * can scroll to it without checking first.
 */
export function nextEdge(direction: "left" | "right", view: View, children: readonly Span[]): number {
  const visibleEnd = view.scrollLeft + view.clientWidth;
  if (direction === "right") {
    const cut = children.find((c) => c.end > visibleEnd + SLACK);
    return cut ? Math.max(0, cut.end - view.clientWidth) : view.scrollLeft;
  }
  // The last one starting before the left edge: the nearest way back, rather
  // than all the way to the beginning.
  const cut = [...children].reverse().find((c) => c.start < view.scrollLeft - SLACK);
  return cut ? Math.max(0, cut.start) : view.scrollLeft;
}
