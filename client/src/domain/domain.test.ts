import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_LEADS } from "./constants";
import { NOW, applications, leads, settings, tracks as trackList } from "./fixture";
import { daysSince, hostOf, relWhen, safeUrl } from "./format";
import { tierCssClass, tierOf, tierRank } from "./geo";
import { appComparator, fillState, leadComparator } from "./rows";
import { runState, runSummary, trackWarn } from "./runs";
import { buildTabs, buildTracks, pathForTab } from "./tabs";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("safeUrl", () => {
  it("passes http and https through", () => {
    expect(safeUrl("https://example.com/1")).toBe("https://example.com/1");
    expect(safeUrl("http://example.com/1")).toBe("http://example.com/1");
  });

  it("assumes https for a bare host, which is a common enough thing to type", () => {
    expect(safeUrl("acme.com/jobs/1")).toBe("https://acme.com/jobs/1");
  });

  it("refuses anything that is not a link, rather than building an href from it", () => {
    for (const hostile of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "  javascript:alert(1)  ",
      "ask the recruiter for the link",
      "",
    ]) {
      expect(safeUrl(hostile), hostile).toBe("");
    }
  });

  it("handles null and undefined", () => {
    expect(safeUrl(null)).toBe("");
    expect(safeUrl(undefined)).toBe("");
  });
});

describe("hostOf", () => {
  it("names where a posting lives, without the www", () => {
    expect(hostOf("https://www.boards.greenhouse.io/acme/jobs/1")).toBe("boards.greenhouse.io");
  });
  it("is empty for anything safeUrl refuses", () => {
    expect(hostOf("javascript:alert(1)")).toBe("");
  });
});

describe("tierOf", () => {
  it("ranks a row by its area's position in the ranked list, so index is the tier", () => {
    expect(tierOf({ area: "Metro core" }, settings)?.rank).toBe(0);
    expect(tierOf({ area: "Wider region" }, settings)?.rank).toBe(1);
    expect(tierOf({ area: "Wider region" }, settings)?.cssClass).toBe("pri1");
  });

  it("gives no tier to a row with no area, or an area no longer ranked", () => {
    expect(tierOf({ area: "" }, settings)).toBeNull();
    expect(tierOf({ area: "Old region" }, settings)).toBeNull();
  });

  it("tiers by the area alone, whatever the location says", () => {
    // The nightly search placed this row; the page doesn't second-guess it by matching towns.
    const placed: { location: string; area: string } = { location: "Shelbyville", area: "Metro core" };
    const unplaced: { location: string; area: string } = { location: "Springfield", area: "" };
    expect(tierOf(placed, settings)?.label).toBe("Metro core");
    expect(tierOf(unplaced, settings)).toBeNull();
  });
});

describe("tier colours and sorting", () => {
  it("caps the colour class at the five the stylesheet defines", () => {
    expect(tierCssClass(0)).toBe("pri0");
    expect(tierCssClass(4)).toBe("pri4");
    expect(tierCssClass(5)).toBe("");
  });

  it("sorts a row with no tier last rather than first", () => {
    expect(tierRank({ area: "" }, settings)).toBe(999);
  });
});

describe("leadComparator", () => {
  it("sinks Not a fit, then orders by tier, then newest found", () => {
    const sorted = [...leads].sort(leadComparator("priority", settings));
    expect(sorted[sorted.length - 1].status).toBe("Not a fit");
    const ranks = sorted.filter((l) => l.status !== "Not a fit").map((l) => tierRank(l, settings));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("makes an explicit sort exactly that sort", () => {
    const byCompany = [...leads].sort(leadComparator("company-asc", settings));
    expect(byCompany.map((l) => l.company)).toEqual([...leads.map((l) => l.company)].sort());
  });
});

describe("appComparator", () => {
  it("floats To Apply rows, which are the only ones still owing an application", () => {
    const sorted = [...applications].sort(appComparator("applied-desc"));
    const firstNonToApply = sorted.findIndex((a) => a.status !== "To Apply");
    expect(sorted.slice(0, firstNonToApply).every((a) => a.status === "To Apply")).toBe(true);
  });

  it("sinks blank locations in the sort that asks about location", () => {
    const sorted = [...applications].sort(appComparator("location-asc"));
    expect(sorted[sorted.length - 1].location).toBe("");
  });
});

describe("fillState", () => {
  it("calls a failed read stuck", () => {
    expect(fillState(applications.find((a) => a.id === 24)!)).toBe("stuck");
  });

  it("calls an unread row with a link and gaps waiting", () => {
    expect(fillState(applications.find((a) => a.id === 23)!)).toBe("waiting");
  });

  it("does not call a complete row waiting, because no run would fetch it", () => {
    expect(fillState(applications.find((a) => a.id === 11)!)).toBe("");
  });

  it("does not call a row with no link waiting", () => {
    expect(fillState(applications.find((a) => a.id === 12)!)).toBe("");
  });
});

describe("runState", () => {
  it("treats a track that has never run as honest, not broken", () => {
    const never = { at: "", on: "", status: "", leads_added: 0, screened_added: 0, delisted: 0, note: "" };
    expect(runState(never, settings)).toBe("never");
    expect(trackWarn(never, settings)).toBeNull();
  });

  it("reports a clean recent run as ok and an old one as stale", () => {
    expect(runState(trackList[0].last_run, settings)).toBe("ok");
    expect(runState(trackList[1].last_run, settings)).toBe("error");
  });

  it("uses the configured staleness threshold", () => {
    const run = { ...trackList[0].last_run, status: "ok" };
    expect(runState(run, { ...settings, stale_run_hours: 4 })).toBe("stale");
    expect(runState(run, { ...settings, stale_run_hours: 48 })).toBe("ok");
  });
});

describe("runSummary", () => {
  it("says a day that found nothing found nothing, rather than going blank", () => {
    const run = { at: new Date(NOW).toISOString(), on: "", status: "ok", leads_added: 0, screened_added: 0, delisted: 0, note: "" };
    expect(runSummary(run)).toBe("found nothing new");
  });

  it("counts from the run record, not from the rows", () => {
    expect(runSummary(trackList[0].last_run)).toBe("3 new, 5 screened out");
  });
});

describe("relWhen and daysSince", () => {
  it("is coarse on purpose", () => {
    expect(relWhen(new Date(NOW - 30 * 60_000).toISOString())).toBe("just now");
    expect(relWhen(new Date(NOW - 5 * 3_600_000).toISOString())).toBe("5h ago");
    expect(relWhen(new Date(NOW - 26 * 3_600_000).toISOString())).toBe("yesterday");
    expect(relWhen(new Date(NOW - 5 * 86_400_000).toISOString())).toBe("5d ago");
  });

  it("returns null rather than NaN for anything undated", () => {
    expect(daysSince("")).toBeNull();
    expect(daysSince("not a date")).toBeNull();
    expect(relWhen(null)).toBe("");
  });

  // Set in local clock terms, so these hold in any timezone the tests run in.
  // Read as UTC midnight, a bare date's count went up at 5pm Pacific instead.
  it("counts a bare date in calendar days, going up at local midnight and not before", () => {
    vi.setSystemTime(new Date(2026, 8, 15, 23, 30));
    expect(daysSince("2026-09-01")).toBe(14);
    vi.setSystemTime(new Date(2026, 8, 16, 0, 30));
    expect(daysSince("2026-09-01")).toBe(15);
  });

  it("gives the same count all day, morning to late evening", () => {
    vi.setSystemTime(new Date(2026, 8, 15, 9, 0));
    const morning = daysSince("2026-09-01");
    vi.setSystemTime(new Date(2026, 8, 15, 22, 0));
    expect(daysSince("2026-09-01")).toBe(morning);
  });

  it("still counts a full timestamp in whole 24-hour days", () => {
    expect(daysSince(new Date(NOW - 2.5 * 86_400_000).toISOString())).toBe(2);
  });

  it("never counts a future date as negative", () => {
    vi.setSystemTime(new Date(2026, 8, 1, 12, 0));
    expect(daysSince("2026-09-05")).toBe(0);
  });
});

describe("buildTabs", () => {
  const tracks = buildTracks(trackList);

  it("takes every label from config, hardcoding none", () => {
    const tabs = buildTabs(leads, applications, tracks, settings);
    expect(tabs.map((t) => t.label)).toEqual([
      "Overview", "Applications", "All leads", "Alpha roles", "Beta roles",
    ]);
    const renamed = buildTabs(leads, applications, tracks, {
      ...settings, overview_label: "Home", all_leads_label: "Everything",
    });
    expect(renamed.map((t) => t.label).slice(0, 3)).toEqual(["Home", "Applications", "Everything"]);
  });

  it("adds a tab for a track added to config", () => {
    const extra = buildTracks([...trackList, { ...trackList[0], key: "gamma", label: "Gamma roles", sort_order: 3 }]);
    expect(buildTabs(leads, applications, extra, settings).map((t) => t.id)).toContain("gamma");
  });

  it("orders tracks by sort_order", () => {
    const reversed = buildTracks([{ ...trackList[0], sort_order: 9 }, { ...trackList[1], sort_order: 1 }]);
    expect(Object.keys(reversed)).toEqual(["beta", "alpha"]);
  });

  it("badges track tabs with untriaged leads only", () => {
    const tabs = buildTabs(leads, applications, tracks, settings);
    // Alpha has one New lead (Acme); Reviewing, Applied and Not a fit are all
    // things already looked at.
    expect(tabs.find((t) => t.id === "alpha")?.n).toBe(1);
    expect(tabs.find((t) => t.id === "beta")?.n).toBe(2);
    expect(tabs.find((t) => t.id === ALL_LEADS)?.n).toBe(3);
  });

  it("marks the Applications tab when a posting could not be read", () => {
    const tabs = buildTabs(leads, applications, tracks, settings);
    expect(tabs.find((t) => t.id === "applications")?.warn?.cls).toBe("fill");
    const clean = applications.filter((a) => a.autofill !== "failed");
    const tabs2 = buildTabs(leads, clean, tracks, settings);
    expect(tabs2.find((t) => t.id === "applications")?.warn).toBeNull();
  });

  it("marks a track whose search stopped reporting cleanly", () => {
    const tabs = buildTabs(leads, applications, tracks, settings);
    expect(tabs.find((t) => t.id === "beta")?.warn?.cls).toBe("error");
    expect(tabs.find((t) => t.id === "alpha")?.warn).toBeNull();
  });

  it("gives every tab a route", () => {
    expect(pathForTab("dashboard")).toBe("/");
    expect(pathForTab("applications")).toBe("/applications");
    expect(pathForTab(ALL_LEADS)).toBe("/all-leads");
    expect(pathForTab("alpha")).toBe("/t/alpha");
    // A track key is an installer-chosen slug and could contain anything.
    expect(pathForTab("a b/c")).toBe("/t/a%20b%2Fc");
  });
});
