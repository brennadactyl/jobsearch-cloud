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

/** jsdom has no matchMedia, so each case says what the browser would answer. */
function asksFor(reduced: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion: reduce") && reduced,
    media: query,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("glides where the browser won't say, rather than failing", () => {
    // matchMedia is absent in jsdom and in older embedded browsers. Treating
    // that as "no preference" keeps the ordinary case working; treating it as
    // an error would break the arrows for everyone to serve no one.
    vi.stubGlobal("matchMedia", undefined);
    expect(scrollBehavior()).toBe("smooth");
  });
});
