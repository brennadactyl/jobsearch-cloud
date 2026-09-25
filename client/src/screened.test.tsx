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
import { NOW, data as fixture } from "./domain/fixture";
import { countsByKind, screenedWithin } from "./domain/screened";
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
/** The sentence describing the list, which the window select's own label would otherwise match. */
const sumLine = () => document.querySelector(".screened-sum")!;

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

  it("describes the list it is showing, and names what is in it beyond the rules", async () => {
    await openTab();
    // The list carries a posting she removed herself, so the sentence says so:
    // nobody should have to count rows to see why two numbers differ.
    expect(sumLine()).toHaveTextContent(
      "Showing 5 from the last 30 days, against 8 kept, including 1 you removed yourself.",
    );

    await userEvent.selectOptions(screen.getByRole("combobox"), "0");
    expect(rows()).toHaveLength(6);
    expect(sumLine()).toHaveTextContent("Showing 6 from everything, against 8 kept");
  });

  it("takes what the settings cost from the server's count, never from the rows it holds", async () => {
    await openTab();
    await userEvent.click(screen.getByRole("button", { name: /Alpha roles/ }));
    // Three of alpha's rows are inside the window; the claim is its whole
    // record, and the page never adds up rows to make it.
    expect(rows()).toHaveLength(3);
    expect(screen.getByText(/settings have turned away/)).toHaveTextContent(
      "Alpha roles’s settings have turned away 4 postings in all.",
    );
  });

  it("narrows to one search, counting each search's own rows", async () => {
    await openTab();
    await userEvent.click(screen.getByRole("button", { name: /Beta roles/ }));
    expect(rows()).toHaveLength(2);
    // The line follows the chip: both halves describe the same search, or the
    // comparison is between two different things.
    expect(sumLine()).toHaveTextContent(
      "Showing 2 from the last 30 days, against 4 kept by Beta roles",
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
    const alpha = screen.getAllByRole("link", { name: "3 screened out" })[0];
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

  it("leaves out a posting that was hers and went away, whatever ended it", async () => {
    await openTab();
    // A dead posting and a duplicate arrive because they record postings she
    // once had; neither is something her settings rejected, so neither belongs
    // on a tab about what her rules cost.
    expect(screen.queryByRole("link", { name: "Birch" })).toBeNull();
    expect(screen.queryByText(/Gone before you saw it/)).toBeNull();
    expect(screen.queryByText(/Already seen/)).toBeNull();
  });

  it("shows a kind it has never heard of rather than hiding it", () => {
    // A rule someone's settings caused is what they came here to see, and
    // silence is the worse way for this page to be wrong about a new kind.
    const odd = [{ ...fixture.screened[0], id: 95, kind: "relocation-required" }];
    expect(screenedWithin(odd, 0, NOW)).toHaveLength(1);
  });

  it("leaves out a lead that was taken down, which no rule rejected", async () => {
    await openTab();
    // The fixture's delisted row is inside the window and would otherwise be
    // the second row down.
    expect(screen.queryByText("posting taken down")).toBeNull();
    expect(screen.queryByRole("link", { name: "Ash" })).toBeNull();
    expect(sumLine()).toHaveTextContent("Showing 5 from the last 30 days");
    expect(screen.queryByText(/Taken down after you saw it/)).toBeNull();
  });

  it("offers no export, since what a run passed over is not a record of your own search", async () => {
    await openTab();
    expect(screen.queryByRole("button", { name: /Export/ })).toBeNull();
  });

  it("says how many postings are kept outside the window, since nothing is deleted", async () => {
    await openTab({ ...fixture, screened_window: { days: 90, older: 412 } });
    expect(screen.getByText(/412 older postings aren't shown here/)).toBeInTheDocument();
    // What those rows are still doing, which is the reassurance that matters.
    expect(screen.getByText(/still stop a search finding them again/)).toBeInTheDocument();

    // A server with no window sends nothing older, and the line stays away.
    cleanup();
    await openTab();
    expect(screen.queryByText(/older postings aren't shown/)).toBeNull();
  });

  it("counts what each kind of rule set aside, and narrows to one", async () => {
    await openTab();
    const kinds = () =>
      [...document.querySelectorAll(".screened-kind")].map((b) => b.textContent?.replace(/\s+/g, " ").trim());
    // In the order a run decides between them, so the pay floor's count is what
    // the floor alone cost rather than everything it would also have caught.
    expect(kinds()).toEqual([
      "1Outside your locations",
      "1Not your level",
      "1Different kind of work",
      "1Contract or temporary",
      // The person's own removal is its own group, not an unclassified one.
      "1You removed it",
    ]);

    await userEvent.click(screen.getByRole("button", { name: /Not your level/ }));
    expect(rows()).toHaveLength(1);
    expect(screen.getByText(/above target level/)).toBeInTheDocument();
    expect(window.location.search).toContain("kind=wrong-level");

    await userEvent.click(screen.getByRole("button", { name: "Show every reason" }));
    expect(rows()).toHaveLength(5);

    // What she took off her own board is reachable as its own group.
    await userEvent.click(screen.getByRole("button", { name: /You removed it/ }));
    expect(rows()).toHaveLength(1);
    expect(screen.getByText("you removed this")).toBeInTheDocument();
  });

  it("counts postings rather than rows, since one job re-listed is two rows", async () => {
    const twice = [
      { ...fixture.screened[0], id: 90, url: "https://example.com/same", kind: "wrong-level" },
      { ...fixture.screened[0], id: 91, url: "https://example.com/same", kind: "wrong-level" },
      { ...fixture.screened[0], id: 92, url: "https://example.com/other", kind: "wrong-level" },
    ];
    expect(countsByKind(twice)).toEqual([{ kind: "wrong-level", label: "Not your level", postings: 2 }]);
    // A row with no url is its own posting: there is nothing to match it on.
    const blank = [
      { ...fixture.screened[0], id: 93, url: "", kind: "dead" },
      { ...fixture.screened[0], id: 94, url: "", kind: "dead" },
    ];
    expect(countsByKind(blank)[0].postings).toBe(2);
  });

  it("marks a posting the person removed themselves, which no run decided", async () => {
    await openTab();
    const mine = screen.getByText("not for me").closest("tr")!;
    expect(within(mine).getByText("you removed this")).toBeInTheDocument();
    // A run's row carries no such mark.
    expect(within(screen.getByText(/outside the US/).closest("tr")!).queryByText("you removed this")).toBeNull();
  });

  it("won't say a search turned nothing away when its record predates the kinds", async () => {
    // Beta has no count of its own: its rejections were written before a run
    // said which rule caused each one, so "nothing" would be a claim about
    // months nobody can speak for.
    const noCount: TrackerData = { ...fixture, screened_counts: { alpha: 4 }, screened: [] };
    vi.spyOn(client, "getData").mockResolvedValue(noCount);
    window.history.pushState({}, "", "/screened?search=beta");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: "What your searches set aside" });
    expect(screen.getByText(/No record of what this search turned away/)).toBeInTheDocument();
  });

  it("says nothing about screening on a night that recorded no such count", async () => {
    const older: TrackerData = {
      ...fixture,
      tracks: fixture.tracks.map((t) =>
        t.key === "alpha" ? { ...t, last_run: { ...t.last_run, screened_by_rules: null } } : t,
      ),
    };
    vi.spyOn(client, "getData").mockResolvedValue(older);
    window.history.pushState({}, "", "/t/alpha");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: "Fixture Search" });
    const stamp = document.querySelector(".runstamp")!;
    expect(stamp).toHaveTextContent(/3 new/);
    expect(stamp).not.toHaveTextContent(/screened out/);
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
