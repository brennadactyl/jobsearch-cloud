/**
 * Every literal class name a component writes must be selected somewhere in
 * tracker.css. Components emit the class names tracker.css targets, and an
 * invented one fails silently: a class with no rule is not an error, and jsdom
 * applies no styling.
 *
 * Names built at runtime (a tier's `pri0`, a pill's colour) can't be read
 * statically and aren't covered.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const css = readFileSync(join(SRC, "tracker.css"), "utf8");

const componentFiles = [
  join(SRC, "App.tsx"),
  ...readdirSync(join(SRC, "components"))
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => join(SRC, "components", f)),
];

/** Class tokens written literally - `className="a b"`, and the static text of `className={`a ${x}`}`. */
function literalClasses(source: string): string[] {
  const tokens = new Set<string>();
  for (const m of source.matchAll(/className="([^"]+)"/g)) {
    for (const t of m[1].split(/\s+/)) tokens.add(t);
  }
  for (const m of source.matchAll(/className=\{`([^`]*)`\}/g)) {
    const statics = m[1].replace(/\$\{[^}]*\}/g, " ");
    for (const t of statics.split(/\s+/)) tokens.add(t);
  }
  return [...tokens].filter((t) => /^[a-z][\w-]*$/i.test(t));
}

function styled(token: string): boolean {
  return new RegExp(`\\.${token.replace(/-/g, "\\-")}(?![\\w-])`).test(css);
}

describe("class names", () => {
  for (const file of componentFiles) {
    const name = file.slice(SRC.length + 1).replace(/\\/g, "/");
    it(`${name} writes only classes the stylesheet selects`, () => {
      const missing = literalClasses(readFileSync(file, "utf8")).filter((t) => !styled(t));
      expect(missing, `${name} writes classes tracker.css never selects`).toEqual([]);
    });
  }
});

describe("the drill chip", () => {
  it("keeps its accent text - no later rule of the same weight overrides the colour", () => {
    // The link resets at the end of tracker.css come later at the same
    // specificity, so `.chip.drill` must not be given `color: inherit` there.
    // Comments out first: they sit in front of selectors and hold commas.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const colours = [...rules.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, selectors, body]) =>
        selectors.split(",").some((s) => s.trim() === ".chip.drill") && /(^|;|\s)color\s*:/.test(body),
      )
      .map(([, , body]) => body.match(/(?:^|;|\s)color\s*:\s*([^;]+)/)![1].trim());
    expect(colours.at(-1)).toBe("var(--accent)");
  });
});
