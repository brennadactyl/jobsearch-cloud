/**
 * Every font family the stylesheet names has to actually be requested.
 *
 * This exists because it went wrong. The font link in index.html was written by
 * hand rather than copied from the page the CSS came from, and it left out
 * Bricolage Grotesque - which the stylesheet asks for on every heading. The
 * failure is silent by design: the family is simply absent, the browser walks
 * to the next entry in the stack, and the page renders in a plausible wrong
 * face. It survived a build, a deploy, and a screenshot before a check of what
 * the browser had actually loaded caught it.
 *
 * The same shape as the theme test: a rule that would otherwise hold only for
 * as long as everyone remembers it.
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
