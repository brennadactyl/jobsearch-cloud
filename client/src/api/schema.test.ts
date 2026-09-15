/**
 * The API boundary. These are the checks that make the schema worth having
 * rather than a second set of type declarations: that it defaults what the
 * server omits, ignores what the server adds, and fails loudly on the shape it
 * cannot make sense of.
 */
import { describe, expect, it } from "vitest";
import { dataSchema, loginSchema, settingsSchema } from "./schema";

/** The minimum a freshly created database returns: no config posted, nothing found yet. */
const emptyPayload = {
  user: { id: "u1", name: "Ada" },
  updated: "",
  leads: [],
  applications: [],
  screened: [],
  tracks: [],
  settings: {},
};

describe("dataSchema", () => {
  it("accepts a brand-new deployment with no config posted", () => {
    const data = dataSchema.parse(emptyPayload);
    // The page has to be usable before setup has posted anything, which is why
    // the server defaults these too (DEFAULT_SETTINGS in server/src/db.js).
    expect(data.settings.display_title).toBe("Job Search Tracker");
    expect(data.settings.all_leads_label).toBe("All leads");
    expect(data.settings.stale_run_hours).toBe(36);
    expect(data.settings.priority_locations).toEqual([]);
  });

  it("ignores fields the server has that this client does not render", () => {
    // TRACK_CONFIG_FIELDS ride along on every track. Adding one server-side
    // must not stop the page loading.
    const data = dataSchema.parse({
      ...emptyPayload,
      tracks: [
        {
          key: "alpha",
          label: "Alpha roles",
          full_description: "",
          sort_order: 1,
          last_run: { at: "", on: "", status: "", leads_added: 0, screened_added: 0, delisted: 0, note: "" },
          target_companies: "a very long prose block",
          some_field_added_next_year: 42,
        },
      ],
    });
    expect(data.tracks[0].label).toBe("Alpha roles");
    expect(data.tracks[0]).not.toHaveProperty("target_companies");
  });

  it("treats a never-run track as a run record, not a missing one", () => {
    // getTracksAndSettings builds last_run from a LEFT JOIN and defaults every
    // field, so "" is how "never ran" arrives - it is never null.
    const data = dataSchema.parse({
      ...emptyPayload,
      tracks: [
        {
          key: "beta", label: "Beta", full_description: "", sort_order: 0,
          last_run: { at: "", on: "", status: "", leads_added: 0, screened_added: 0, delisted: 0, note: "" },
        },
      ],
    });
    expect(data.tracks[0].last_run.at).toBe("");
  });

  it("fills a null text column rather than failing the whole payload", () => {
    const data = dataSchema.parse({
      ...emptyPayload,
      leads: [{ id: 1, search: "alpha", company: null, title: "Eng", url: "https://example.com/1" }],
    });
    expect(data.leads[0].company).toBe("");
    expect(data.leads[0].notes).toBe("");
  });

  it("rejects a payload missing the envelope", () => {
    expect(dataSchema.safeParse({ leads: [] }).success).toBe(false);
    expect(dataSchema.safeParse(null).success).toBe(false);
  });

  it("rejects a lead with no id, rather than rendering a row that cannot be addressed", () => {
    const bad = dataSchema.safeParse({
      ...emptyPayload,
      leads: [{ search: "alpha", company: "Acme" }],
    });
    expect(bad.success).toBe(false);
  });
});

describe("settingsSchema", () => {
  it("keeps ordered priority locations, which is what makes index mean rank", () => {
    const s = settingsSchema.parse({
      priority_locations: [
        { label: "Metro core", anyOf: ["springfield"] },
        { label: "Wider region", anyOf: ["shelbyville"] },
      ],
    });
    expect(s.priority_locations.map((r) => r.label)).toEqual(["Metro core", "Wider region"]);
  });
});

describe("loginSchema", () => {
  it("accepts a response with no user block", () => {
    expect(loginSchema.parse({ token: "abc" }).token).toBe("abc");
  });

  it("rejects a 200 that carries no token", () => {
    expect(loginSchema.safeParse({ user: { id: "u1", name: "Ada" } }).success).toBe(false);
    expect(loginSchema.safeParse({ token: "" }).success).toBe(false);
  });
});
