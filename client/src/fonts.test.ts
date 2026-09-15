/**
 * Every font family tracker.css names must be requested in index.html, and the
 * reverse. A missing family fails silently: the browser falls back to the next
 * in the stack and renders a plausible wrong face.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/tracker.css"), "utf8");
const html = readFileSync(join(process.cwd(), "index.html"), "utf8");

/** Quoted families named in a font-family declaration - the webfonts, not the generic fallbacks. */
function familiesUsed(): string[] {
  const decls = css.match(/font-family:[^;}]*/g) ?? [];
  const names = new Set<string>();
  for (const d of decls) {
    for (const m of d.matchAll(/"([^"]+)"/g)) names.add(m[1]);
  }
  return [...names].sort();
}

/** Families the Google Fonts link asks for. */
function familiesRequested(): string[] {
  const link = html.match(/fonts\.googleapis\.com\/css2\?([^"]+)/)?.[1] ?? "";
  return [...link.matchAll(/family=([^:&]+)/g)].map((m) => decodeURIComponent(m[1].replace(/\+/g, " "))).sort();
}

describe("webfonts", () => {
  it("requests every family the stylesheet names", () => {
    const requested = new Set(familiesRequested());
    for (const family of familiesUsed()) {
      expect(requested.has(family), `${family} is used in tracker.css but never requested in index.html`).toBe(true);
    }
  });

  it("requests nothing the stylesheet does not use", () => {
    // The other direction: a family paid for on every page load and never
    // applied is a request nobody benefits from.
    const used = new Set(familiesUsed());
    for (const family of familiesRequested()) {
      expect(used.has(family), `${family} is requested but never used in tracker.css`).toBe(true);
    }
  });

  it("asks for the display=swap behaviour, so text is readable before the fonts arrive", () => {
    expect(html).toMatch(/display=swap/);
  });
});
