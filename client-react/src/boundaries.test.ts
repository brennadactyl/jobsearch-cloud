/**
 * Source-level boundaries.
 *
 * These are the parity-bar items that are properties of the *codebase* rather
 * than of any rendered output, so they are checked by reading the source. That
 * is a blunt instrument and deliberately so: each one is a rule that would
 * otherwise be enforced by everyone remembering it, which is the arrangement
 * this whole rebuild exists to stop relying on.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) return [];
    return [full];
  });
}

const files = sourceFiles().map((path) => ({
  path: path.slice(SRC.length + 1).replace(/\\/g, "/"),
  text: readFileSync(path, "utf8"),
}));

describe("one path to the server", () => {
  it("calls fetch only from the API client", () => {
    // Everything else goes through request(), which attaches the bearer token
    // and turns a 401 into a session reset. A stray fetch elsewhere would be a
    // request that skips both.
    const callers = files.filter((f) => /\bfetch\(/.test(f.text)).map((f) => f.path);
    expect(callers).toEqual(["api/client.ts"]);
  });

  it("keeps the number of call sites small enough to have read them all", () => {
    // request() itself, and logout - which is outside a session by definition,
    // because the token it carries is the one being discarded. Login needs no
    // exception here: it goes through request() with an empty token.
    const client = files.find((f) => f.path === "api/client.ts")!;
    expect(client.text.match(/\bfetch\(/g)).toHaveLength(2);
  });
});

describe("the XSS boundary", () => {
  it("never sets HTML from a string", () => {
    // React escapes text and attributes, and this is the one way to opt out of
    // that. It should stay at zero: the page renders company names and titles
    // read off job postings on the internet.
    for (const f of files) {
      expect(f.text, f.path).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=/);
    }
  });

  it("routes every href through safeUrl", () => {
    // The half React does not cover - it will render a javascript: URL into an
    // href quite happily. Any href built from row data has to be gated.
    for (const f of files) {
      const hrefs = f.text.match(/href=\{[^}]*\}/g) ?? [];
      for (const href of hrefs) {
        expect(
          /safeUrl\(|\bsafe\b|\blink\b|\burl\b/.test(href),
          `${f.path}: ${href} should come from safeUrl()`,
        ).toBe(true);
      }
    }
  });
});

/** Test data. Named here so the checks below can exempt it deliberately rather than by accident. */
const FIXTURE = "domain/fixture.ts";

describe("nothing per-person is hardcoded", () => {
  it("is not reachable from the app at all - only tests import the fixture", () => {
    // Which is what makes exempting it below safe: it names invented tracks,
    // and none of them can reach a bundle.
    const importers = files
      .filter((f) => f.path !== FIXTURE && /from "[./]*(domain\/)?fixture"/.test(f.text))
      .map((f) => f.path);
    expect(importers).toEqual([]);
  });

  it("names no track key or label from the fixture", () => {
    // The same deployed client serves every account. A track key written into
    // a component is one person's job search baked into everybody's page.
    for (const f of files.filter((f) => f.path !== FIXTURE)) {
      for (const forbidden of ["alpha", "beta", "Alpha roles", "Beta roles", "Fixture Search"]) {
        expect(f.text, `${f.path} mentions ${forbidden}`).not.toContain(`"${forbidden}"`);
      }
    }
  });
});
