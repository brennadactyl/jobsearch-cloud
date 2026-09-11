/**
 * Pins wrangler.toml's [assets] settings: the SPA fallback that keeps tab URLs
 * from 404ing on reload (why: wrangler.toml), and serving the build output.
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
