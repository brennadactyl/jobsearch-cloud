/**
 * The Overview's charts as rendered: a chart and its table view show the same
 * figures, and a figure that opens nothing isn't a link.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import { NOW, data } from "./domain/fixture";
import { clearPrefs } from "./ui/prefs";

async function renderOverview() {
  vi.spyOn(client, "getData").mockResolvedValue(data);
  window.history.pushState({}, "", "/");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "Momentum" });
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
    const block = screen.getByRole("heading", { name: "By location" }).closest(".ch-block") as HTMLElement;
    await userEvent.click(within(block).getByRole("button", { name: "Show as table" }));
    const rows = [1, 2, 3].map((c) => tableColumn("By location", c));
    expect(tiers.map((_, i) => rows[0][i] + rows[1][i] + rows[2][i])).toEqual(segments);
  });

  it("the pipeline flow shows each stage's reached count and segments", async () => {
    await renderOverview();
    const name = "Where applications move on or stall";
    const block = screen.getByRole("heading", { name }).closest(".ch-block") as HTMLElement;
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
