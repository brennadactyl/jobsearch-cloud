/**
 * The rules under the Overview's charts: local weeks, how far an application
 * got, and that every chart's parts add up to its whole.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Application, Screened, TrackerData } from "../api/schema";
import { ALL_LEADS } from "./constants";
import { drillCount, drillKeeps, drillLabel, drillRows, findDrill, leadRows, appRows, type DrillTarget } from "./drills";
import { NOW, daysAgo, data as fixture } from "./fixture";
import { isoDay, lastWeeks, localDay, mondayOf, shortDate, weekOf } from "./format";
import { flow, momentum, payoff, responseHistogram, tierBars } from "./overview";
import { FLOW_STAGES, FORWARD_STAGES, flowSegment, furthestStage, median } from "./stages";

// Pacific time, where a date read as UTC lands on the day before - the bug
// localDay exists to prevent - and where DST changes happen.
// Set at load, before the tables below are built at collection time.
const originalTz = process.env.TZ;
process.env.TZ = "America/Los_Angeles";
afterAll(() => {
  process.env.TZ = originalTz;
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function app(over: Partial<Application> & Pick<Application, "id">): Application {
  return { ...fixture.applications.find((a) => a.id === 13)!, company: `App${over.id}`, ...over };
}

function screened(over: Partial<Screened> & Pick<Screened, "id">): Screened {
  return {
    search: "alpha", url: `https://example.com/s${over.id}`, company: "", title: "", location: "",
    reason: "", date: daysAgo(1), added_by: "run", found: "", ...over,
  };
}

/** The fixture plus a skipped stage, a status with no date, and removed postings. */
const data: TrackerData = {
  ...fixture,
  applications: [
    ...fixture.applications,
    // Applied straight to Tech Screen: the Recruiter Screen date was never stamped.
    app({ id: 31, leadId: "3", status: "Tech Screen", dateApplied: daysAgo(20), dateTechScreen: daysAgo(10) }),
    // Rejected after a tech screen that skipped the recruiter screen.
    app({ id: 32, leadId: "8", status: "Rejected", dateApplied: daysAgo(30), dateTechScreen: daysAgo(20), dateRejected: daysAgo(15) }),
    // Withdrawn with no stage dates at all, not even the applied date.
    app({ id: 33, status: "Withdrawn", dateApplied: "", dateWithdrawn: daysAgo(3) }),
    // A status set with its date cleared.
    app({ id: 34, status: "Onsite / Loop", dateApplied: daysAgo(25) }),
  ],
  screened: [
    screened({ id: 1, added_by: "hand", found: daysAgo(9), location: "Springfield" }),
    screened({ id: 2, added_by: "run", reason: "posting taken down", found: daysAgo(2) }),
    screened({ id: 3, search: "beta", added_by: "run", reason: "below target level" }),
    screened({ id: 4, search: "beta", added_by: "", reason: "removed before the column existed" }),
  ],
};

describe("localDay", () => {
  it("reads a date as that calendar day, not UTC midnight", () => {
    const d = localDay("2026-09-07")!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 8, 7, 0]);
    // Date.parse would make this Sunday evening in Pacific time.
    expect(new Date(Date.parse("2026-09-07")).getDate()).toBe(6);
  });

  it("refuses what isn't a real date", () => {
    expect(localDay("")).toBeNull();
    expect(localDay("2026-02-31")).toBeNull();
    expect(localDay("Sept 7")).toBeNull();
    expect(localDay(undefined)).toBeNull();
  });
});

describe("weeks", () => {
  it("files a Sunday under the week before and a Monday under its own", () => {
    expect(weekOf("2026-09-06")).toBe("2026-08-31"); // Sunday
    expect(weekOf("2026-09-07")).toBe("2026-09-07"); // Monday
    expect(weekOf("2026-09-13")).toBe("2026-09-07"); // the next Sunday
  });

  it("keeps every day of a DST change in the right week", () => {
    // US clocks fall back on Sunday 2026-11-01 and spring forward on 2026-03-08.
    expect(weekOf("2026-11-01")).toBe("2026-10-26");
    expect(weekOf("2026-11-02")).toBe("2026-11-02");
    expect(weekOf("2026-11-08")).toBe("2026-11-02");
    expect(weekOf("2026-03-08")).toBe("2026-03-02");
    expect(weekOf("2026-03-09")).toBe("2026-03-09");
    expect(lastWeeks(3, localDay("2026-11-04")!)).toEqual(["2026-10-19", "2026-10-26", "2026-11-02"]);
  });

  it("ends the last N weeks with the one under way", () => {
    const weeks = lastWeeks(12);
    expect(weeks).toHaveLength(12);
    expect(weeks[11]).toBe("2026-09-07");
    expect(weeks[0]).toBe("2026-06-22");
    expect(isoDay(localDay(weeks[0])!)).toBe(weeks[0]);
    expect(mondayOf(localDay("2026-09-10")!)).toBe("2026-09-07");
  });

  it("names a week by its Monday", () => {
    expect(shortDate("2026-09-08")).toBe("Sep 8");
    expect(drillLabel("found-week:2026-09-08", data)).toBe("Found week of Sep 8");
  });
});

describe("furthestStage", () => {
  const stageOf = (id: number) => {
    const i = furthestStage(data.applications.find((a) => a.id === id)!);
    return i === null ? null : FORWARD_STAGES[i].label;
  };

  it("counts a rejection after a tech screen as rejected at Tech Screen, not at Applied", () => {
    expect(stageOf(32)).toBe("Tech Screen");
    expect(flowSegment(data.applications.find((a) => a.id === 32)!, 0)).toBe("moved-on");
    expect(flowSegment(data.applications.find((a) => a.id === 32)!, 2)).toBe("rejected");
  });

  it("counts a withdrawn row with no stage dates as withdrawn at Applied", () => {
    expect(stageOf(33)).toBe("Applied");
    expect(flowSegment(data.applications.find((a) => a.id === 33)!, 0)).toBe("withdrew");
  });

  it("counts a skipped stage as reached", () => {
    expect(stageOf(31)).toBe("Tech Screen");
    expect(flowSegment(data.applications.find((a) => a.id === 31)!, 1)).toBe("moved-on");
  });

  it("never sits below the stage the status names", () => {
    expect(stageOf(34)).toBe("Onsite / Loop");
  });

  it("is null for a row not yet sent", () => {
    expect(stageOf(11)).toBeNull();
  });
});

describe("the charts add up", () => {
  it("each stage's flow segments add up to the applications that reached it, a skipped stage included", () => {
    const { bars } = flow(data);
    expect(bars.map((b) => b.label)).toEqual(FLOW_STAGES.map((s) => s.label));
    for (const b of bars) {
      expect(b.segments.reduce((s, x) => s + x.n, 0), b.label).toBe(b.reached.n);
    }
    // Every sent application reached Applied.
    expect(bars[0].reached.n).toBe(drillCount({ tab: "applications", drill: "applied" }, data));
  });

  it("every Found breakdown adds up to its Found figure", () => {
    const { rows, total } = payoff(data);
    for (const r of [...rows, total]) {
      if (!r.found) continue;
      const b = r.found.breakdown;
      expect(b.open + b.notAFit + b.applied + b.other + b.removed, r.label).toBe(r.found.n);
    }
    // Only a hand removal or a delisting counts as a removed posting.
    expect(rows.find((r) => r.key === "alpha")!.found!.breakdown.removed).toBe(2);
    expect(rows.find((r) => r.key === "beta")!.found!.breakdown.removed).toBe(0);
  });

  it("gives hand-added applications their own row", () => {
    const hand = payoff(data).rows.find((r) => r.key === "")!;
    expect(hand.found).toBeNull();
    expect(hand.applied.n).toBe(drillRows({ tab: "applications", drill: "applied" }, data).filter((a) => !(a as Application).leadId).length);
  });

  it("counts removed postings in the week they were found, once the server dates them", () => {
    const m = momentum(data);
    const week = m.found.find((w) => w.monday === weekOf(daysAgo(9)))!;
    const leadsThatWeek = data.leads.filter((l) => weekOf(l.found) === week.monday).length;
    expect(week.n).toBe(leadsThatWeek + 1);
    expect(m.removedCounted).toBe(true);
    const older = { ...data, screened: data.screened.map((s) => ({ ...s, found: undefined })) };
    expect(momentum(older).removedCounted).toBe(false);
  });

  it("shows twelve weeks even with under two weeks of data", () => {
    const m = momentum({ ...data, leads: [], screened: [], applications: [] });
    expect(m.found).toHaveLength(12);
    expect(m.found.every((w) => w.n === 0)).toBe(true);
    expect(m.found[11].current).toBe(true);
  });

  it("takes the median, not the average, of days to a first reply", () => {
    expect(median([1, 2, 30])).toBe(2);
    expect(median([2, 4])).toBe(3);
    expect(median([])).toBeNull();
    const h = responseHistogram(data);
    expect(h.median).not.toBeNull();
  });
});

describe("drill parity for every chart", () => {
  const m = momentum(data);
  const { rows, total } = payoff(data);
  const targets: [string, DrillTarget, number | null][] = [
    ...m.applied.map((w): [string, DrillTarget, number] => [`applied ${w.monday}`, w.target, w.n]),
    // The found chart's figure includes rows no tab shows; what it opens is `opens`.
    ...m.found.map((w): [string, DrillTarget, number] => [`found ${w.monday}`, w.target, w.opens]),
    ...[...rows, total].flatMap((r) =>
      [r.open, r.notAFit, r.applied, r.responded]
        .filter((c) => !!c?.target)
        .map((c): [string, DrillTarget, number] => [`payoff ${r.label}`, c!.target!, c!.n]),
    ),
    ...tierBars(data).flatMap((t) => t.segments.map((s): [string, DrillTarget, number] => [`tier ${t.key} ${s.key}`, s.target, s.n])),
    ...flow(data).bars.flatMap((b) => [
      [`flow ${b.slug}`, b.reached.target!, b.reached.n] as [string, DrillTarget, number],
      ...b.segments.map((s): [string, DrillTarget, number] => [`flow ${b.slug} ${s.key}`, s.target, s.n]),
    ]),
    ["offer", flow(data).offer.target!, flow(data).offer.n],
    ...responseHistogram(data).bins.map((b): [string, DrillTarget, number] => [`reply ${b.key}`, b.target, b.n]),
    ["waiting", { tab: "applications", drill: "waiting" }, null],
  ];

  it.each(targets)("%s: the figure is the length of the rows it opens", (_name, t, shown) => {
    if (t.drill) expect(findDrill(t.drill), `${t.drill} resolves`).toBeDefined();
    // Reproduces what the tab does on arrival, independently of drillRows.
    const isApps = t.tab === "applications";
    const base = isApps ? appRows(data.applications) : leadRows(data.leads, t.tab);
    const opened = base.filter(
      (r) => (!t.filter || r.status === t.filter) && drillKeeps(t.drill ?? null, isApps ? "apps" : "leads", r, data),
    );
    expect(drillCount(t, data)).toBe(opened.length);
    if (shown !== null) expect(shown).toBe(opened.length);
  });

  it("tiers applications by their own location, and leads by theirs", () => {
    const top = tierBars(data)[0];
    const applied = drillRows(top.segments[0].target, data) as Application[];
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.every((a) => /springfield|remote/i.test(a.location))).toBe(true);
    expect(drillRows({ tab: ALL_LEADS, drill: "tier:other:open" }, data).map((l) => (l as { company: string }).company)).toEqual(["Fox"]);
  });

  it("ignores a parameter it can't read rather than filtering everything out", () => {
    for (const id of ["found-week:soon", "flow:nowhere:waiting", "flow:offer:waiting", "tier:x:open", "response-days:9-9"]) {
      expect(findDrill(id), id).toBeUndefined();
      expect(drillKeeps(id, "apps", data.applications[0], data)).toBe(true);
    }
  });
});
