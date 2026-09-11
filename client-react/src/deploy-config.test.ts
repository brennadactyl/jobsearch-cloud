/**
 * The deployed Worker's routing, checked in the repo rather than discovered live.
 *
 * Tabs are real URLs here - /applications, /all-leads, /t/<track> - and none of
 * them is a file in dist/. A static-assets Worker serves only files that exist,
 * so without single-page-application fallback every one of those answers 404
 * the moment it is reloaded, bookmarked or opened from a shared link. Only /
 * works, which is why clicking around from the Overview never showed it.
 *
 * No local run can see this either: `vite dev` and `vite preview` both fall back
 * to index.html by themselves. It shipped, and was found by loading
 * /applications on the deployed site. Reading wrangler.toml is the only check
 * available before a deploy, so here it is.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const toml = readFileSync(join(process.cwd(), "wrangler.toml"), "utf8");

/** A string value from the [assets] table, ignoring comments. */
function assetsSetting(key: string): string | undefined {
  let inAssets = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (/^\[.*\]$/.test(line)) {
      inAssets = line === "[assets]";
      continue;
    }
    if (!inAssets) continue;
    const m = line.match(/^([\w-]+)\s*=\s*"([^"]*)"$/);
    if (m && m[1] === key) return m[2];
  }
  return undefined;
}

describe("the deployed Worker's routing", () => {
  it("serves index.html for any path that is not a file, so a tab's URL survives a reload", () => {
    expect(assetsSetting("not_found_handling")).toBe("single-page-application");
  });

  it("serves the build output, not the source", () => {
    expect(assetsSetting("directory")).toBe("./dist");
  });
});
