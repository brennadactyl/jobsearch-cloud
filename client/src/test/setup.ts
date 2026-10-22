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

/**
 * jsdom has no matchMedia, and the page asks it two unrelated questions:
 * useTheme subscribes to prefers-color-scheme, scrollBehavior reads
 * prefers-reduced-motion. A whole MediaQueryList answering "no" to everything
 * is the baseline, so a test wanting a different answer changes one query's
 * answer rather than replacing the global.
 *
 * Which is the point: replacing it is how a stub carrying only `matches`
 * reaches a file that subscribes to a different query, and throws there - a
 * timeout in a file that names neither the stub nor the cause.
 */
globalThis.matchMedia ??= (media: string) =>
  ({
    media,
    matches: false,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList;
