/**
 * Every class name a component writes has to exist in the stylesheet.
 *
 * tracker.css is a copy of the old client's stylesheet, and components are meant
 * to emit the class names it already targets. The first pass at the facts cards
 * didn't - it invented `facts`, `fcard`, `fgrid` and `stage-history`, none of
 * which the stylesheet has ever had - so Role details, Notes and Stage history
 * rendered unstyled. Nothing failed: a class with no rule behind it is not an
 * error anywhere, jsdom applies no styling, and a test that asks whether a card
 * exists gets the same answer either way.
 *
 * This reads the literal class names out of the components and checks each one
 * is selected somewhere in tracker.css. Names built at runtime (a tier's `pri0`,
 * a status pill's colour) can't be read statically and are not covered; the
 * literal ones are where invention happens.
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
