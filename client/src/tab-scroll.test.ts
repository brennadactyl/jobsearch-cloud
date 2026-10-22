/**
 * The tab strip's arithmetic: what counts as hidden, and where one press lands.
 *
 * The measuring itself can't be checked here - jsdom gives every element a
 * zero-sized box, so a strip is never overflowing in it. That is why these two
 * are separate from the component: the half that decides is testable, and a
 * real browser is what proves the half that measures.
 */
import { describe, expect, it } from "vitest";
import { edgeToShow, hiddenSides, nextEdge } from "./ui/tabScroll";

/** Her nine tabs at a width that cuts the last two: a strip of 1181 showing 1045. */
const VIEW = { scrollLeft: 0, clientWidth: 1045 };
const TABS = [
  { start: 0, end: 96 },
  { start: 99, end: 243 },
  { start: 246, end: 380 },
  { start: 383, end: 507 },
  { start: 510, end: 610 },
  { start: 613, end: 745 },
  { start: 748, end: 960 },
  { start: 963, end: 1063 },
  { start: 1066, end: 1181 },
];

describe("what counts as hidden", () => {
  it("sees the right end when tabs run past it, and nothing on the left at rest", () => {
    expect(hiddenSides({ ...VIEW, scrollWidth: 1181 })).toEqual({ left: false, right: true });
  });

  it("sees the left end once scrolled, and the right end gone at the far side", () => {
    expect(hiddenSides({ scrollLeft: 136, clientWidth: 1045, scrollWidth: 1181 })).toEqual({
      left: true,
      right: false,
    });
  });

  it("offers neither when everything fits", () => {
    expect(hiddenSides({ scrollLeft: 0, clientWidth: 1320, scrollWidth: 1320 })).toEqual({
      left: false,
      right: false,
    });
  });

  it("ignores a fractional scroll position, which would leave an arrow pointing at nothing", () => {
    expect(hiddenSides({ scrollLeft: 0.5, clientWidth: 1045, scrollWidth: 1045.5 })).toEqual({
      left: false,
      right: false,
    });
  });
});

describe("where one press lands", () => {
  it("brings the first cut-off tab fully into view, not a fixed step", () => {
    // Tab eight ends at 1063 and the view is 1045 wide, so its right edge
    // lands on the view's: 18px, not a round number anyone chose.
    expect(nextEdge("right", VIEW, TABS)).toBe(18);
  });

  it("takes the next press to the tab after it, so a label is never left halved", () => {
    const after = { scrollLeft: 18, clientWidth: 1045 };
    expect(nextEdge("right", after, TABS)).toBe(1181 - 1045);
  });

  it("goes back to the nearest tab off the left, rather than all the way to the start", () => {
    // Scrolled fully right, the last tab starting before the left edge is the
    // third - so one press back shows it whole rather than jumping to tab one.
    expect(nextEdge("left", { scrollLeft: 136, clientWidth: 1045 }, TABS)).toBe(99);
  });

  it("stays put when that side holds nothing, so a caller needn't check first", () => {
    expect(nextEdge("left", VIEW, TABS)).toBe(0);
    expect(nextEdge("right", { scrollLeft: 136, clientWidth: 1045 }, TABS)).toBe(136);
  });

  it("never scrolls past the start", () => {
    expect(nextEdge("left", { scrollLeft: 50, clientWidth: 1045 }, TABS)).toBe(0);
  });
});

describe("bringing the tab you are on into view", () => {
  it("pulls in one that sits off the right, and no further", () => {
    // The last tab ends at 1181 in a 1045-wide view, so it lands flush at the
    // right edge: the tabs before it stay as visible as they can.
    expect(edgeToShow(TABS[8], VIEW)).toBe(1181 - 1045);
  });

  it("pulls in one that sits off the left, to its own start", () => {
    expect(edgeToShow(TABS[1], { scrollLeft: 500, clientWidth: 1045 })).toBe(99);
  });

  it("leaves a tab already whole exactly where it is", () => {
    expect(edgeToShow(TABS[0], VIEW)).toBe(0);
    expect(edgeToShow(TABS[3], VIEW)).toBe(0);
  });

  it("moves as little as it takes rather than centring", () => {
    // Centring tab eight would scroll past where it becomes readable and take
    // the tabs either side of it off screen for no gain.
    const flush = edgeToShow(TABS[7], VIEW);
    expect(flush).toBe(1063 - 1045);
    expect(flush).toBeLessThan(TABS[7].start);
  });

  it("never scrolls past the start for a tab near the beginning", () => {
    expect(edgeToShow(TABS[0], { scrollLeft: 300, clientWidth: 1045 })).toBe(0);
  });
});
