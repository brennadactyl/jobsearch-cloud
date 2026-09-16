import "@testing-library/jest-dom/vitest";

/**
 * jsdom has no ResizeObserver; usePinnedLayout needs one. A no-op, because the
 * `offsetWidth - clientWidth` it measures is 0 in jsdom anyway - the gutter's
 * width can only be checked in a real browser, since jsdom does no layout.
 */
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

/** jsdom has no scrollIntoView; revealSelectedRow calls it. */
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
