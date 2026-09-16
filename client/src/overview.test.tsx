/**
 * The Overview's charts as rendered: a chart and its table view show the same
 * figures, a figure that opens nothing isn't a link, and every section and chart
 * folds on its own and stays folded in this browser.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import { NOW, data } from "./domain/fixture";
import { OVERVIEW_FOLD_IDS, payoff } from "./domain/overview";
import { pathForTarget } from "./domain/tabs";
import { clearPrefs, readOverviewCollapsed, setPrefs } from "./ui/prefs";

async function renderOverview(payload = data) {
  vi.spyOn(client, "getData").mockResolvedValue(payload);
  window.history.pushState({}, "", "/");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: /^Momentum/ });
}

beforeEach(() => {
  localStorage.clear();
  clearPrefs();
  localStorage.setItem("tracker_token", "a-token");
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The figures a chart's marks carry, in order. */
function chartFigures(name: string, selector = ".ch-col"): number[] {
  const group = screen.getByRole("group", { name });
  return [...group.querySelectorAll(selector)].map((el) => Number(el.getAttribute("data-n")));
}

/** Column `col` of a table view, in row order. */
function tableColumn(name: string, col: number): number[] {
  const table = screen.getByRole("table", { name });
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((tr) => Number(tr.querySelectorAll("td")[col].textContent));
}

describe("each chart's table view", () => {
  it.each([
    ["Positions found", 1],
    ["Applications sent", 1],
    ["Time to first reply", 1],
  ])("%s shows the same rows and figures as the chart", async (name, col) => {
    await renderOverview();
    const chart = chartFigures(name);
    const block = screen.getByRole("group", { name }).closest(".ch-block") as HTMLElement;
    await userEvent.click(within(block).getByRole("button", { name: "Show as table" }));
    expect(tableColumn(name, col)).toEqual(chart);
  });

  it("By location shows each bar's segments as a row", async () => {
    await renderOverview();
    const tiers = data.settings.priority_locations.map((r) => r.label).concat("Other");
    const chart = tiers.map((t) => screen.getByRole("group", { name: t }).querySelector(".hbar")!);
    const segments = chart.map((bar) => [...bar.querySelectorAll(".hseg")].reduce((s, el) => s + Number(el.getAttribute("data-n")), 0));
    const block = screen.getByRole("heading", { name: /^By location/ }).closest(".ch-block") as HTMLElement;
    await userEvent.click(within(block).getByRole("button", { name: "Show as table" }));
    const rows = [1, 2, 3].map((c) => tableColumn("By location", c));
    expect(tiers.map((_, i) => rows[0][i] + rows[1][i] + rows[2][i])).toEqual(segments);
  });

  it("the pipeline flow shows each stage's reached count and segments", async () => {
    await renderOverview();
    const name = "Where applications move on or stall";
    const block = screen.getByRole("heading", { name: new RegExp(`^${name}`) }).closest(".ch-block") as HTMLElement;
    const reached = [...block.querySelectorAll(".hbars > div > .hrow-head .mono")].map((el) => Number(el.textContent));
    await userEvent.click(within(block).getByRole("button", { name: "Show as table" }));
    expect(tableColumn(name, 1)).toEqual(reached);
    for (const [i, n] of reached.entries()) {
      const row = within(screen.getByRole("table", { name })).getAllByRole("row")[i + 1];
      const parts = [...row.querySelectorAll("td")].slice(2).map((td) => Number(td.textContent));
      expect(parts.reduce((s, x) => s + x, 0)).toBe(n);
    }
  });
});

describe("which searches pay off", () => {
  it("leaves Found as plain text, with its breakdown in the tooltip", async () => {
    await renderOverview();
    const table = screen.getByRole("table", { name: "Which searches pay off" });
    const alpha = within(table).getByRole("link", { name: "Alpha roles" }).closest("tr")!;
    const found = alpha.querySelectorAll("td")[1].firstElementChild!;
    expect(found.tagName).toBe("SPAN");
    // Alpha: Acme New, Bolt Reviewing, Cog Applied, Dyn Not a fit; nothing removed.
    expect(found).toHaveAttribute("aria-label", "4 found: 2 open · 1 not a fit · 1 moved to Applications · 0 removed");
    const open = alpha.querySelectorAll("td")[2].querySelector("a")!;
    expect(open).toHaveAttribute("href", "/t/alpha");
  });

  it("shows a zero as plain text, not a link", async () => {
    await renderOverview();
    const table = screen.getByRole("table", { name: "Which searches pay off" });
    const beta = within(table).getByRole("link", { name: "Beta roles" }).closest("tr")!;
    // Beta has no application whose lead is one of its own.
    const applied = beta.querySelectorAll("td")[4];
    expect(applied.textContent).toBe("0");
    expect(applied.querySelector("a")).toBeNull();
  });

  it("heads Applied and Responded over two cells each: the count, then its rate", async () => {
    await renderOverview();
    const table = screen.getByRole("table", { name: "Which searches pay off" });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((th) => th.textContent)).not.toContain("Apply rate");
    const span = (label: string) => headers.find((th) => th.textContent === label)!.getAttribute("colspan");
    expect(span("Applied")).toBe("2");
    expect(span("Responded")).toBe("2");
    for (const tr of within(table).getAllByRole("row").slice(1)) expect(tr.querySelectorAll("td")).toHaveLength(8);
  });

  it("puts the apply rate in its own cell after the count, with the count as the link and the fraction in the tooltip", async () => {
    await renderOverview();
    const { rows, total } = payoff(data);
    const row = rows.find((r) => r.found && r.applied.n > 0) ?? total;
    const { n: applied } = row.applied;
    const found = row.found!.n;
    expect(applied).toBeGreaterThan(0);

    const table = screen.getByRole("table", { name: "Which searches pay off" });
    const tr = row === total ? table.querySelector("tr.total")! : within(table).getByRole("link", { name: row.label }).closest("tr")!;
    const [count, rateCell] = [tr.querySelectorAll("td")[4], tr.querySelectorAll("td")[5]];
    expect(count.querySelector("a")!.textContent).toBe(String(applied));
    expect(rateCell.textContent).toBe(`${Math.round((applied / found) * 100)}%`);
    expect(rateCell.querySelector("a")).toBeNull();
    expect(rateCell.querySelector(".rate")).toHaveAttribute("aria-label", expect.stringContaining(`${applied} of ${found}`));
  });

  it("keeps every count link opening exactly its count, with no rate inside the link", async () => {
    await renderOverview();
    const table = screen.getByRole("table", { name: "Which searches pay off" });
    const { rows, total } = payoff(data);
    const expected = [...rows, total].flatMap((r) =>
      [r.open, r.notAFit, r.applied, r.responded].filter((c) => c && c.n && c.target).map((c) => [pathForTarget(c!.target!), c!.n]),
    );
    const links = [...table.querySelectorAll("td.num a")].map((a) => [a.getAttribute("href"), Number(a.textContent)]);
    // The drill invariant, as rendered: each link's text is its count, and that
    // count is what its target opens.
    expect(links).toEqual(expected);
    expect(table.querySelector("a .rate")).toBeNull();
  });

  it("gives each count cell the word a phone's stacked line shows, and marks each row's first shown count", async () => {
    await renderOverview();
    const table = screen.getByRole("table", { name: "Which searches pay off" });
    const words = ["found", "open", "not a fit", "applied", "responded"];
    for (const tr of within(table).getAllByRole("row").slice(1)) {
      const counts = [...tr.querySelectorAll("td.cnt-cell")];
      expect(counts.map((td) => td.getAttribute("data-label"))).toEqual(words);
      // The stacked line's separators start after this one, so it must be the first cell with a figure.
      const lead = counts.filter((td) => td.hasAttribute("data-lead"));
      expect(lead).toHaveLength(1);
      expect(lead[0]).toBe(counts.find((td) => td.textContent !== ""));
    }
  });

  it("leaves a rate's cell empty when there's no rate to show, with no dot or dash", async () => {
    await renderOverview();
    const table = screen.getByRole("table", { name: "Which searches pay off" });
    for (const r of payoff(data).rows.filter((row) => row.key)) {
      const cells = within(table).getByRole("link", { name: r.label }).closest("tr")!.querySelectorAll("td");
      if (r.applied.n === 0) expect(cells[5].textContent, `${r.label} apply rate`).toBe("");
      if (r.applied.n < 3) {
        expect(cells[6].textContent, `${r.label} responded`).toBe(String(r.responded.n));
        expect(cells[7].textContent, `${r.label} response rate`).toBe("");
      }
    }
  });
});

describe("by location", () => {
  const tierRows = (labels: string[]) =>
    labels.map((t) => {
      const group = screen.getByRole("group", { name: t });
      const row = group.parentElement!;
      const segs = [...group.querySelectorAll(".hseg")];
      return {
        label: t,
        segments: segs.map((el) => Number(el.getAttribute("data-n"))),
        tones: segs.map((el) => el.className),
        total: Number(row.querySelector(".tier-total")!.textContent),
        width: group.querySelector<HTMLElement>(".hbar")!.style.width,
        breakdown: row.querySelector(".tier-breakdown"),
        track: group.querySelector(".tier-track")!,
      };
    });
  const labels = () => data.settings.priority_locations.map((r) => r.label).concat("Other");

  it("gives every bar the full length, split within its own tier, with the tier's total beside it", async () => {
    await renderOverview();
    for (const r of tierRows(labels())) {
      // No width of its own: a bar compares shares within its tier, and the total carries size.
      expect(r.width, r.label).toBe("");
      expect(r.total, r.label).toBe(r.segments.reduce((a, b) => a + b, 0));
    }
  });

  it("puts each tier's own breakdown under its bar, each count opening its rows, with no shared legend", async () => {
    await renderOverview();
    const block = screen.getByRole("heading", { name: /^By location/ }).closest(".ch-block") as HTMLElement;
    expect(block.querySelector(".tier-legend")).toBeNull();
    for (const r of tierRows(labels()).filter((row) => row.total > 0)) {
      const marks = [...r.breakdown!.querySelectorAll(".seglabel")];
      expect(marks.map((m) => Number(m.getAttribute("data-n"))), r.label).toEqual(r.segments);
      for (const m of marks) expect(m.tagName, r.label).toBe("A");
      // Filled segments only: an outline reads as an empty box. And none in the
      // --line shade, which is too close to an empty tier's track to read as filled.
      for (const tone of r.tones) {
        expect(tone).not.toMatch(/\bs-soft\b/);
        expect(tone).not.toMatch(/\bs-line\b/);
      }
    }
  });

  it("shows an empty track and a 0 for a tier with nothing in it", async () => {
    const nowhere = { label: "Nowhere yet", anyOf: ["no posting says this"] };
    await renderOverview({ ...data, settings: { ...data.settings, priority_locations: [...data.settings.priority_locations, nowhere] } });
    const [row] = tierRows([nowhere.label]);
    expect(row.total).toBe(0);
    expect(row.segments).toEqual([]);
    expect(row.track).toBeEmptyDOMElement();
    expect(row.breakdown).toBeNull();
  });
});

describe("folding sections and charts", () => {
  const foldButton = (id: string) =>
    document.querySelector(`button.fold[aria-controls="ov-${id.replace(/\./g, "-")}"]`) as HTMLButtonElement | null;
  const content = (id: string) => document.getElementById(`ov-${id.replace(/\./g, "-")}`);

  it("puts the sections in order, with the footer note last", async () => {
    await renderOverview();
    const titles = [...document.querySelectorAll(".sec .fold-title")].map((e) => e.textContent);
    expect(titles).toEqual(["Daily searches", "Application pipeline", "Momentum"]);
    expect(document.querySelector(".panel-scroll")!.lastElementChild).toHaveClass("note");
  });

  it.each(OVERVIEW_FOLD_IDS)("%s folds its own content and nothing else", async (id) => {
    await renderOverview();
    const before = Object.fromEntries(OVERVIEW_FOLD_IDS.map((other) => [other, foldButton(other)?.getAttribute("aria-expanded")]));
    expect(before[id]).toBe("true");
    expect(content(id)).not.toBeNull();

    await userEvent.click(foldButton(id)!);

    expect(foldButton(id)).toHaveAttribute("aria-expanded", "false");
    expect(content(id)).toBeNull();
    for (const other of OVERVIEW_FOLD_IDS) {
      // A folded section's charts aren't rendered; every heading still on the
      // page is as it was.
      if (other !== id && foldButton(other)) expect(foldButton(other)).toHaveAttribute("aria-expanded", before[other]!);
    }
  });

  it("brings a section's charts back as they were", async () => {
    await renderOverview();
    await userEvent.click(foldButton("momentum.found")!);
    const applied = content("momentum.applied")!.closest(".ch-block") as HTMLElement;
    await userEvent.click(within(applied).getByRole("button", { name: "Show as table" }));

    await userEvent.click(foldButton("momentum")!);
    expect(foldButton("momentum.found")).toBeNull();
    await userEvent.click(foldButton("momentum")!);

    expect(foldButton("momentum.found")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("table", { name: "Applications sent" })).toBeInTheDocument();
  });

  it("switches to a table without folding the chart, and hides the switch when folded", async () => {
    await renderOverview();
    const block = content("pipeline.reply")!.closest(".ch-block") as HTMLElement;
    await userEvent.click(within(block).getByRole("button", { name: "Show as table" }));
    expect(foldButton("pipeline.reply")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("table", { name: "Time to first reply" })).toBeInTheDocument();

    await userEvent.click(foldButton("pipeline.reply")!);
    expect(within(block).queryByRole("button", { name: /Show as/ })).toBeNull();
  });

  it("remembers folds in this browser, as JSON of the folded ids only", async () => {
    await renderOverview();
    await userEvent.click(foldButton("pipeline")!);
    await userEvent.click(foldButton("momentum.applied")!);
    await userEvent.click(foldButton("momentum.applied")!);
    expect(JSON.parse(localStorage.getItem("bjs.overviewCollapsed")!)).toEqual({ pipeline: true });
    expect(readOverviewCollapsed()).toEqual({ pipeline: true });

    // Signing out clears it with the rest of the view state.
    clearPrefs();
    expect(localStorage.getItem("bjs.overviewCollapsed")).toBeNull();
  });

  it("counts every fold when several land before the page re-renders", async () => {
    await renderOverview();
    for (const id of ["pipeline.flow", "momentum", "searches.location"]) foldButton(id)!.click();
    await waitFor(() => expect(foldButton("momentum")).toHaveAttribute("aria-expanded", "false"));
    expect(JSON.parse(localStorage.getItem("bjs.overviewCollapsed")!)).toEqual({
      "pipeline.flow": true,
      momentum: true,
      "searches.location": true,
    });
  });

  it("reads what it stored and ignores what it can't use", () => {
    localStorage.setItem("bjs.overviewCollapsed", '{"searches":true,"pipeline":false,"retired.chart":true}');
    expect(readOverviewCollapsed()).toEqual({ searches: true });
    for (const bad of ["{not json", "[]", "true", '"searches"']) {
      localStorage.setItem("bjs.overviewCollapsed", bad);
      expect(readOverviewCollapsed(), bad).toEqual({});
    }
  });

  it("renders everything expanded from a malformed stored value", async () => {
    localStorage.setItem("bjs.overviewCollapsed", "{not json");
    setPrefs({ overviewCollapsed: readOverviewCollapsed() });
    await renderOverview();
    for (const id of OVERVIEW_FOLD_IDS) expect(foldButton(id)).toHaveAttribute("aria-expanded", "true");
  });

  it("sums Momentum up as this week's columns", async () => {
    await renderOverview();
    const current = (name: string) => {
      const cols = screen.getByRole("group", { name }).querySelectorAll(".ch-col");
      return Number(cols[cols.length - 1].getAttribute("data-n"));
    };
    expect(foldButton("momentum")!.querySelector(".fold-sub")).toHaveTextContent(
      `${current("Positions found")} found · ${current("Applications sent")} applied this week`,
    );
  });
});

describe("waiting longest", () => {
  it("opens every waiting application without touching the saved sort", async () => {
    await renderOverview();
    const all = screen.getByRole("link", { name: "See all waiting ›" });
    expect(all).toHaveAttribute("href", "/applications?drill=waiting");
    await userEvent.click(all);
    expect(await screen.findByRole("link", { name: "Clear filter: Waiting to hear back" })).toBeInTheDocument();
    expect(localStorage.getItem("bjs.appSort")).toBeNull();
  });
});
