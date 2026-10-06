/**
 * The two halves of the place lists' move from one comma-joined string to an
 * array of entries.
 *
 * The lists have three readers - this page, the settings routes and the
 * nightly helper - and they ship three different ways, so every reader has to
 * understand both shapes before any writer sends an array. These pin the
 * page's side of that: it reads either, and it still writes the old shape.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveSettings } from "./api/client";
import { settingsSchema } from "./api/schema";
import { data as fixture } from "./domain/fixture";

/** The stored settings with the places under test swapped in. */
function parseWith(places: Record<string, unknown>) {
  return settingsSchema.parse({ ...fixture.settings, ...places });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reading a place list", () => {
  it("takes an array entry for entry, commas and all", () => {
    // The whole point: a place whose name holds a comma is one place. Split on
    // commas it becomes two, and neither is a place any search matches.
    const s = parseWith({ priority_locations: ["Vancouver, BC", "Remote (US)"] });
    expect(s.priority_locations).toEqual(["Vancouver, BC", "Remote (US)"]);
    // A lead's tier reads this list, so it has to carry the same entries.
    expect(s.areas).toEqual(["Vancouver, BC", "Remote (US)"]);
  });

  it("still splits a string, the one way every reader splits it", () => {
    const s = parseWith({ search_locations: "Seattle WA, Remote (US) ,, Portland OR " });
    expect(s.search_locations).toEqual(["Seattle WA", "Remote (US)", "Portland OR"]);
  });

  it("reads a missing or empty list as no places rather than one blank one", () => {
    expect(parseWith({ excluded_locations: null }).excluded_locations).toEqual([]);
    expect(parseWith({ excluded_locations: "" }).excluded_locations).toEqual([]);
    expect(parseWith({ excluded_locations: [] }).excluded_locations).toEqual([]);
    expect(parseWith({ excluded_locations: ["  ", "Ogdenville"] }).excluded_locations).toEqual(["Ogdenville"]);
  });

  it("leaves the note alone, because it is a sentence and not a list", () => {
    const note = "Open to relocating, for the right team.";
    expect(parseWith({ location_note: note }).location_note).toBe(note);
  });
});

describe("writing a place list", () => {
  it("sends the joined string, because the write flips last", async () => {
    // A reader that hasn't shipped yet would read an array as empty and say
    // nothing about it, which is the same silent failure this move exists to
    // end. So the page reads both shapes before any writer sends the new one.
    const fetched = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ resumes: {}, locations: {}, settings: {}, searches: {} }),
    });
    vi.stubGlobal("fetch", fetched);

    await saveSettings({ priority_locations: ["Metro core", "Wider region"], location_note: "A note" });

    const body = JSON.parse(fetched.mock.calls[0][1].body);
    expect(body.priority_locations).toBe("Metro core, Wider region");
    expect(body.location_note).toBe("A note");
  });

  it("sends nothing for a list that wasn't edited", async () => {
    const fetched = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ resumes: {}, locations: {}, settings: {}, searches: {} }),
    });
    vi.stubGlobal("fetch", fetched);

    await saveSettings({ display_title: "Renamed" });

    const body = JSON.parse(fetched.mock.calls[0][1].body);
    expect("priority_locations" in body).toBe(false);
    expect("search_locations" in body).toBe(false);
  });
});
