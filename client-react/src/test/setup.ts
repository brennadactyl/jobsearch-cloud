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

/** jsdom has no scrollIntoView either, and the master/detail list calls it. */
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
