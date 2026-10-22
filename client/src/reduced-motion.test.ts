/**
 * Scrolling this code starts obeys a request for less motion.
 *
 * The stylesheet says what should happen - `prefers-reduced-motion: reduce`
 * switches transitions and animations off - but a smooth scroll is neither of
 * those, and passing `behavior` at all overrides the element's own
 * `scroll-behavior`, so no CSS rule could reach it. That makes this the one
 * path where the intent has to be honoured in script, which is the sort of
 * thing a later edit re-introduces without noticing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrollBehavior } from "./ui/hooks";

/**
 * Changes one query's answer and keeps the rest of the list the test setup
 * installs. Building on that baseline rather than replacing the global is what
 * keeps the other query whole - `useTheme` subscribes to prefers-color-scheme,
 * and a replacement missing `addEventListener` throws there rather than here.
 */
/** Captured once, before any spy: read inside the mock it would be the mock. */
const baseline = window.matchMedia;

function asksFor(reduced: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    ...baseline(query),
    matches: query.includes("prefers-reduced-motion: reduce") && reduced,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  // The spy as well as the stub: a spy left in place becomes the next test's
  // baseline, and a mock reading itself never returns.
  vi.restoreAllMocks();
});

describe("a scroll the page starts", () => {
  it("jumps for someone who asked for less motion", () => {
    asksFor(true);
    expect(scrollBehavior()).toBe("auto");
  });

  it("glides for someone who didn't", () => {
    asksFor(false);
    expect(scrollBehavior()).toBe("smooth");
  });

  it("glides where the browser won't say", () => {
    // Where matchMedia is missing - an older embedded browser - both answers
    // work and the arrows scroll either way; the choice is only whether an
    // unreadable preference animates for everyone or for no one. Gliding is
    // what osPrefersDark does with the same absence, falling through to "not
    // dark", so the file answers an unanswerable query one way throughout.
    vi.stubGlobal("matchMedia", undefined);
    expect(scrollBehavior()).toBe("smooth");
  });
});
