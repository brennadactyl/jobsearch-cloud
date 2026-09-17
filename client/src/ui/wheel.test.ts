import { afterEach, describe, expect, it } from "vitest";
import { wheelTarget } from "./wheel";

/** A box that scrolls vertically, sized as a browser would measure it. */
function scroller(parent: Element, { height = 100, content = 400, top = 0, target = false } = {}): HTMLDivElement {
  const el = document.createElement("div");
  el.style.overflowY = "auto";
  if (target) el.setAttribute("data-wheel-target", "");
  Object.defineProperty(el, "clientHeight", { value: height });
  Object.defineProperty(el, "scrollHeight", { value: content });
  el.scrollTop = top;
  parent.appendChild(el);
  return el;
}

function plain(parent: Element): HTMLDivElement {
  const el = document.createElement("div");
  parent.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("wheelTarget", () => {
  it("sends a wheel over the header or margins into the page's scroll region", () => {
    const header = plain(document.body);
    const region = scroller(document.body, { target: true });
    expect(wheelTarget(header, 40)).toBe(region);
  });

  it("leaves a wheel over something that can already scroll that way to the browser", () => {
    const region = scroller(document.body, { target: true });
    const card = plain(region);
    expect(wheelTarget(card, 40)).toBeNull();
    // A detail pane beside the list scrolls itself, not the list.
    const detail = scroller(document.body);
    expect(wheelTarget(plain(detail), 40)).toBeNull();
  });

  it("sends the wheel on once the box under the pointer has no room left that way", () => {
    const region = scroller(document.body, { target: true });
    const detail = scroller(document.body, { height: 100, content: 400, top: 300 });
    expect(wheelTarget(plain(detail), 40)).toBe(region);
    expect(wheelTarget(plain(detail), -40)).toBeNull();
  });

  it("does nothing when the region has no room to move, so the page scrolls as it would", () => {
    const header = plain(document.body);
    scroller(document.body, { target: true, top: 300 });
    expect(wheelTarget(header, 40)).toBeNull();
    const short = document.createElement("div");
    expect(wheelTarget(short, 40)).toBeNull();
  });

  it("scrolls an open dialog's body rather than the page behind it", () => {
    scroller(document.body, { target: true });
    const overlay = plain(document.body);
    overlay.className = "modal-overlay";
    const body = scroller(overlay, { target: true });
    expect(wheelTarget(overlay, 40)).toBe(body);
  });
});
