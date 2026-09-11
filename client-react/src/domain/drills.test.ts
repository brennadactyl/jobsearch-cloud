/**
 * The drill invariant: for every drill, the number shown equals the rows the tab
 * opens. "moves the number with the rule" proves it keeps holding after a rule
 * is edited.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_LEADS, STAGE_DATE_FIELDS } from "./constants";
import { DRILLS, drillCount, drillKeeps, drillLabel, drillRows, leadRows, appRows, type DrillTarget } from "./drills";
import { NOW, applications, leads, settings } from "./fixture";

const src = { leads, applications, settings };

beforeEach(() => {
  // Every "days ago" rule below is measured from here. Without freezing it the
  // fixture ages into and out of its own thresholds.
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

/** Every target the Overview offers: the six tiles and every funnel row. */
const targets: DrillTarget[] = [
  { tab: ALL_LEADS, filter: "New" },
  { tab: ALL_LEADS, drill: "top-geo-open" },
  { tab: ALL_LEADS },
  { tab: "applications", drill: "applied" },
  { tab: "applications", drill: "in-conversation" },
  { tab: "applications", drill: "gone-quiet" },
  ...STAGE_DATE_FIELDS.map(([, field]) => ({ tab: "applications", drill: `reached-${field}` })),
];

describe("drill parity", () => {
  it.each(targets)("the count for %o is the length of the rows it opens", (t) => {
    // Reproduces what the tab does on arrival, independently of drillRows, and
    // asserts the two agree. Computing it the same way would prove nothing.
    const isApps = t.tab === "applications";
    const base = isApps ? appRows(applications) : leadRows(leads, t.tab);
    const shown = base.filter(
      (r) =>
        (!t.filter || r.status === t.filter) &&
        drillKeeps(t.drill ?? null, isApps ? "apps" : "leads", r, settings),
    );
    expect(drillCount(t, src)).toBe(shown.length);
  });

  it("moves the number with the rule, not alongside it", () => {
    // Edit one predicate and nothing else: the count has to follow it.
    const before = drillCount({ tab: "applications", drill: "gone-quiet" }, src);
    const original = DRILLS["gone-quiet"];
    try {
      (DRILLS as Record<string, typeof original>)["gone-quiet"] = {
        scope: "apps",
        label: () => "Applied 21+ days ago, no reply",
        test: (a) => {
          const d = a.dateApplied ? Math.floor((NOW - Date.parse(a.dateApplied)) / 86_400_000) : null;
          return a.status === "Applied" && d !== null && d > 21;
        },
      };
      const after = drillCount({ tab: "applications", drill: "gone-quiet" }, src);
      expect(after).not.toBe(before); // the fixture has a row between 14 and 21 days
      expect(after).toBe(drillRows({ tab: "applications", drill: "gone-quiet" }, src).length);
    } finally {
      (DRILLS as Record<string, typeof original>)["gone-quiet"] = original;
    }
  });
});

describe("leadRows", () => {
  it("drops applied leads, which have moved to the Applications tab", () => {
    expect(leads.some((l) => l.status === "Applied")).toBe(true);
    expect(leadRows(leads, ALL_LEADS).some((l) => l.status === "Applied")).toBe(false);
  });

  it("scopes to one track, or pools every track for the cross-track tab", () => {
    expect(leadRows(leads, "alpha").every((l) => l.search === "alpha")).toBe(true);
    expect(leadRows(leads, ALL_LEADS).length).toBeGreaterThan(leadRows(leads, "alpha").length);
  });
});

describe("appRows", () => {
  it("keeps To Apply rows - this tab is not only what was applied to", () => {
    expect(appRows(applications).some((a) => a.status === "To Apply")).toBe(true);
  });

  it("returns a copy, so a caller's sort cannot reorder the query cache", () => {
    const rows = appRows(applications);
    rows.reverse();
    expect(applications[0].id).toBe(11);
  });
});

describe("individual drills", () => {
  it("top-geo-open counts the first configured tier, still open", () => {
    const rows = drillRows({ tab: ALL_LEADS, drill: "top-geo-open" }, src);
    // Acme (New), Bolt (Reviewing), Gil (Remote, Reviewing). Cog is Applied so
    // leadRows already dropped it; Dyn is Not a fit; Echo is tier 1.
    expect(rows.map((r) => r.company).sort()).toEqual(["Acme", "Bolt", "Gil"]);
  });

  it("reached-* tests the stamped date, not the current status", () => {
    // Rho was rejected after a recruiter screen and still counts as having
    // reached one - which is what the funnel row it opens from counted.
    const rows = drillRows({ tab: "applications", drill: "reached-dateRecruiterScreen" }, src);
    expect(rows.map((r) => r.company)).toContain("Rho");
  });

  it("gone-quiet excludes rows that have moved on", () => {
    const rows = drillRows({ tab: "applications", drill: "gone-quiet" }, src);
    expect(rows.every((r) => r.status === "Applied")).toBe(true);
    expect(rows.map((r) => r.company).sort()).toEqual(["Lux", "Mox", "Tau"]);
  });

  it("ignores a drill belonging to the other kind of tab", () => {
    // A leads drill applied to an application filters nothing, rather than
    // throwing or silently emptying the list.
    expect(drillKeeps("in-conversation", "leads", leads[0], settings)).toBe(true);
  });
});

describe("drillLabel", () => {
  it("names the configured tier rather than a hardcoded place", () => {
    expect(drillLabel("top-geo-open", settings)).toBe("Metro core · still open");
    expect(drillLabel("top-geo-open", { ...settings, priority_locations: [] })).toBe(
      "Top locations · still open",
    );
  });

  it("is empty for a drill that does not exist", () => {
    expect(drillLabel("no-such-drill", settings)).toBe("");
    expect(drillLabel(null, settings)).toBe("");
  });
});
