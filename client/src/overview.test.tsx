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
import { OVERVIEW_FOLD_IDS } from "./domain/overview";
import { clearPrefs, readOverviewCollapsed, setPrefs } from "./ui/prefs";

async function renderOverview() {
  vi.spyOn(client, "getData").mockResolvedValue(data);
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
