/**
 * A colour needs a value in `:root`, in the `prefers-color-scheme` block guarded
 * by `:not([data-theme="light"])`, and in `[data-theme="dark"]`. Miss one and it
 * is right in one theme and invisible in the other, which shows only if someone
 * looks at that theme.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Read off disk rather than imported. Vitest stubs CSS imports by default
// (`test.css` is false), which makes even `./tracker.css?raw` resolve to an
// empty string - a stub that would make every check below pass vacuously.
//
// Resolved from the project root, not from `import.meta.url`: under Vitest that
// is not a file: URL and readFileSync rejects it.
const css = readFileSync(join(process.cwd(), "src/tracker.css"), "utf8");

/** Custom-property *declarations* inside one block - `--x:` , not `var(--x)`. */
function declaredTokens(pattern: RegExp): string[] {
  const block = css.match(pattern);
  if (!block) throw new Error(`theme block not found: ${pattern}`);
  return [...block[0].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]).sort();
}

const light = () => declaredTokens(/^:root\{[^}]*\}/m);
const osDark = () =>
  declaredTokens(/@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme="light"\]\)\{[^}]*\}/m);
const explicitDark = () => declaredTokens(/^:root\[data-theme="dark"\]\{[^}]*\}/m);

describe("theme tokens", () => {
  it("declares a real palette, not an empty block", () => {
    expect(light().length).toBeGreaterThan(15);
  });

  it("defines every token in all three blocks", () => {
    expect(osDark()).toEqual(light());
    expect(explicitDark()).toEqual(light());
  });

  it("never leaves a token defined only in a dark block", () => {
    // The inverse of the check above, stated separately because it is the
    // direction that fails silently in light mode - where most work happens.
    const inLight = new Set(light());
    for (const token of [...osDark(), ...explicitDark()]) {
      expect(inLight.has(token), `${token} has no light value`).toBe(true);
    }
  });

  it("uses tokens rather than inlining colours in rules", () => {
    // Hex literals belong in the three palette blocks and nowhere else.
    const rules = css
      .replace(/^:root\{[^}]*\}/m, "")
      .replace(/@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme="light"\]\)\{[^}]*\}\}/m, "")
      .replace(/^:root\[data-theme="dark"\]\{[^}]*\}/m, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  });
});
