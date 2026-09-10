// Testing Library's DOM matchers (toBeInTheDocument, toHaveAccessibleName...),
// registered for every test file. See vite.config.ts's `setupFiles`.
import "@testing-library/jest-dom/vitest";

/**
 * jsdom implements no layout, so it has no ResizeObserver. usePinnedLayout uses
 * one to measure the Overview's scrollbar gutter.
 *
 * A no-op stub is the honest thing here rather than a simulated one: the
 * measurement it drives is `offsetWidth - clientWidth`, which is 0 for every
 * element in jsdom regardless. What the component tests can check is that the
 * hook attaches and cleans up without throwing; whether the gutter is the right
 * number of pixels is a question only a real browser can answer, and it stays on
 * the manual checklist in docs/react-adoption-plan.md.
 */
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

/**
 * jsdom has no scrollIntoView. Nothing calls it today - the old page needed it
 * to put a selected row back after a wholesale repaint, and here the row is
 * never replaced - but it is cheap insurance against a component reaching for
 * it later and failing in tests for a reason that has nothing to do with the
 * behaviour under test.
 */
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
