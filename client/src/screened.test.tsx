/**
 * The Screened tab: what each search set aside, in the words its run wrote,
 * narrowed by how far back to look and by which search. Nothing here groups or
 * counts reasons - the page never reads them.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import type { TrackerData } from "./api/schema";
import { screenedColumns } from "./domain/export";
import { NOW, data as fixture } from "./domain/fixture";
import { clearPrefs } from "./ui/prefs";

async function openTab(data: TrackerData = fixture) {
  vi.spyOn(client, "getData").mockResolvedValue(data);
  window.history.pushState({}, "", "/screened");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
  return screen.findByRole("heading", { name: "What your searches set aside" });
}

const rows = () => within(document.querySelector(".screened-grid")!).getAllByRole("row").slice(1);

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

describe("the screened tab", () => {
  it("has a tab of its own, with no badge: nothing here is waiting on anyone", async () => {
    await openTab();
    const tab = screen.getByRole("tab", { name: "Screened" });
    expect(tab).toHaveAttribute("href", "/screened");
    expect(tab.querySelector(".n")).toBeNull();
    // Quiet beside the searches: nothing in here is waiting on anyone.
    expect(tab).toHaveClass("quiet");
  });

  it("shows each posting with the sentence its run wrote", async () => {
    await openTab();
    const first = rows()[0];
    expect(within(first).getByRole("link", { name: "Umber" })).toHaveAttribute("href", "https://example.com/31");
    expect(within(first).getByText("outside the US, with no remote option stated")).toBeInTheDocument();
    expect(within(first).getByText("Berlin, Germany")).toBeInTheDocument();
    // Newest first, and the 50-day-old row is outside the 30 days it opens on.
    expect(rows()).toHaveLength(5);
    expect(screen.queryByText(/below the floor set for this search/)).toBeNull();
  });

  it("counts what was set aside against what was kept, over the window it is showing", async () => {
    await openTab();
    expect(screen.getByText(/set aside, against/)).toHaveTextContent("5 set aside, against 8 kept, the last 30 days.");

    await userEvent.selectOptions(screen.getByRole("combobox"), "0");
    expect(rows()).toHaveLength(6);
    expect(screen.getByText(/set aside, against/)).toHaveTextContent("6 set aside, against 8 kept, everything.");
  });

  it("narrows to one search, counting each search's own rows", async () => {
    await openTab();
    await userEvent.click(screen.getByRole("button", { name: /Beta roles/ }));
    expect(rows()).toHaveLength(2);
    // The line follows the chip: both halves count the same search, or the
    // comparison is between two different things.
    expect(screen.getByText(/set aside, against/)).toHaveTextContent(
      "2 set aside, against 4 kept by Beta roles, the last 30 days.",
    );
    expect(screen.getByRole("button", { name: /Beta roles/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/above target level/)).toBeNull();
  });

  it("opens on one search when a run stamp's count links to it", async () => {
    vi.spyOn(client, "getData").mockResolvedValue(fixture);
    window.history.pushState({}, "", "/");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: "Fixture Search" });

    // Alpha's stamp says what its last run kept and what it set aside; the
    // second is the way in.
    const alpha = screen.getAllByRole("link", { name: "5 screened out" })[0];
    await userEvent.click(alpha);
    await screen.findByRole("heading", { name: "What your searches set aside" });
    expect(window.location.search).toBe("?search=alpha");
    expect(screen.getByRole("button", { name: /Alpha roles/ })).toHaveAttribute("aria-pressed", "true");
    expect(rows()).toHaveLength(3);
  });

  it("opens what a run put on the board from its other count", async () => {
    vi.spyOn(client, "getData").mockResolvedValue(fixture);
    window.history.pushState({}, "", "/");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: "Fixture Search" });

    // Alpha ran today and added 3. Every status shows, so a lead marked "Not a
    // fit" since is still one that run found.
    await userEvent.click(screen.getAllByRole("link", { name: "3 new" })[0]);
    expect(window.location.pathname).toBe("/t/alpha");
    expect(window.location.search).toContain(`drill=found-day%3Aalpha%3A${fixture.tracks[0].last_run.on}`);
    expect(screen.getByText(/still on your board/)).toBeInTheDocument();
  });

  it("exports the whole record, asking the server for what the page doesn't hold", async () => {
    const all = vi.spyOn(client, "getAllScreened").mockResolvedValue(fixture.screened);
    await openTab();
    await userEvent.click(screen.getByRole("button", { name: /Export/ }));
    const menu = screen.getByRole("menu", { name: "Export" });
    // The count is the window's; "everything" carries none, because the page
    // doesn't know how much is stored until the server answers.
    expect(within(menu).getByRole("menuitem", { name: "Export 5 shown" })).toBeInTheDocument();

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Export everything" }));
    expect(all).toHaveBeenCalledTimes(1);
  });

  it("says how many postings are kept outside the window, since nothing is deleted", async () => {
    await openTab({ ...fixture, screened_window: { days: 90, older: 412 } });
    expect(screen.getByText(/412 older postings aren't shown here/)).toBeInTheDocument();
    expect(screen.getByText(/Export everything includes them/)).toBeInTheDocument();

    // A server with no window sends nothing older, and the line stays away.
    cleanup();
    await openTab();
    expect(screen.queryByText(/older postings aren't shown/)).toBeNull();
  });

  it("writes the run's own sentence and who set each posting aside", () => {
    const columns = screenedColumns({ alpha: fixture.tracks[0], beta: fixture.tracks[1] });
    expect(columns.map((c) => c.header)).toEqual([
      "Search", "Set aside", "Company", "Role", "Location", "Why", "Set aside by", "Posting URL",
    ]);
    const byRun = fixture.screened.find((r) => r.added_by === "run")!;
    const byHand = fixture.screened.find((r) => r.added_by === "hand")!;
    const cell = (row: typeof byRun, header: string) => columns.find((c) => c.header === header)!.value(row);
    expect(cell(byRun, "Why")).toBe(byRun.reason);
    expect(cell(byRun, "Set aside by")).toBe("a run");
    expect(cell(byHand, "Set aside by")).toBe("you");
    expect(cell(byRun, "Search")).toBe("Alpha roles");
  });

  it("marks a posting the person removed themselves, which no run decided", async () => {
    await openTab();
    const mine = screen.getByText("not for me").closest("tr")!;
    expect(within(mine).getByText("you removed this")).toBeInTheDocument();
    // A run's row carries no such mark.
    expect(within(screen.getByText(/outside the US/).closest("tr")!).queryByText("you removed this")).toBeNull();
  });

  it("says so when a search has set nothing aside at all", async () => {
    await openTab({ ...fixture, screened: [] });
    expect(screen.getByText(/Nothing has been set aside yet/)).toBeInTheDocument();
    expect(document.querySelector(".screened-grid")).toBeNull();
  });

  it("tells an empty window from an empty tracker", async () => {
    await openTab({ ...fixture, screened: fixture.screened.filter((r) => r.id === 36) });
    expect(screen.getByText("Nothing was set aside in this window.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox"), "0");
    expect(rows()).toHaveLength(1);
  });
});
