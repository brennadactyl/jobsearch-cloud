/**
 * Layout rules read from tracker.css, which jsdom can't apply: it evaluates no
 * media queries and lays nothing out.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src", "tracker.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first @media block whose query contains `query`. */
function mediaBlock(query: string): string {
  const start = css.indexOf("@media");
  for (let at = start; at !== -1; at = css.indexOf("@media", at + 1)) {
    const open = css.indexOf("{", at);
    if (!css.slice(at, open).replace(/\s+/g, "").includes(query)) continue;
    let depth = 1;
    let i = open + 1;
    for (; i < css.length && depth; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
    return css.slice(open + 1, i - 1);
  }
  throw new Error(`no @media block for ${query}`);
}

describe("the Overview's tile row", () => {
  it("reserves the scroll region's gutter only while the region scrolls", () => {
    // --sbw is measured by usePinnedLayout and only re-measured when the page
    // renders, so the layout that doesn't scroll must not read it.
    expect(css.replace(/\s+/g, "")).toContain("#app.pinned.tiles{padding-right:var(--sbw,0px)}");
    const unpinned = mediaBlock("(max-width:700px)").replace(/\s+/g, "");
    expect(unpinned).toContain("#app.pinned.panel-scroll{overflow:visible");
    expect(unpinned).toContain("#app.pinned.tiles{padding-right:0}");
  });
});
