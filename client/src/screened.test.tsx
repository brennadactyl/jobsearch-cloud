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
import { NOW, daysAgo, data as fixture } from "./domain/fixture";
import {
  countsByKind,
  SCREENED_KINDS,
  SCREENED_WINDOW_DEFAULT,
  SCREENED_WINDOWS,
  screenedFrom,
} from "./domain/screened";
import { clearPrefs } from "./ui/prefs";

/**
 * Opens the tab, then widens to 30 days. The page opens on the newest run's
 * day, which holds one of the fixture's rows, so a test about anything else -
 * sorting, the kinds, the captions - asks for the window its rows are in.
 * `showing` of "1" leaves the window where the page itself put it.
 */
async function openTab(data: TrackerData = fixture, showing = "30", path = "/screened") {
  vi.spyOn(client, "getData").mockResolvedValue(data);
  window.history.pushState({}, "", path);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
  const heading = await screen.findByRole("heading", { name: "What your searches set aside" });
  if (showing !== String(SCREENED_WINDOW_DEFAULT)) {
    await userEvent.selectOptions(screen.getByRole("combobox"), showing);
  }
  return heading;
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
    expect(rows()).toHaveLength(4);
    expect(screen.queryByText(/below the floor set for this search/)).toBeNull();
  });

  it("describes the list it is showing", async () => {
    await openTab();
    expect(sumLine()).toHaveTextContent("Showing 4 from the last 30 days, against 8 kept.");

    await userEvent.selectOptions(screen.getByRole("combobox"), "0");
    expect(rows()).toHaveLength(5);
    expect(sumLine()).toHaveTextContent("Showing 5 from everything, against 8 kept");
  });

  it("leaves out a posting someone removed themselves, which no rule of theirs turned away", async () => {
    await openTab();
    // Their own decision is one they already know about; this tab is what their
    // settings cost them without their seeing it.
    expect(screen.queryByText("not for me")).toBeNull();
    expect(screen.queryByText(/You removed it/)).toBeNull();
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
    expect(rows()).toHaveLength(1);
    // The line follows the chip: both halves describe the same search, or the
    // comparison is between two different things.
    expect(sumLine()).toHaveTextContent(
      "Showing 1 from the last 30 days, against 4 kept by Beta roles",
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

    // The tab opens on the newest run's day, where a real run's rows are the
    // ones the stamp just counted. The fixture's sit further back than its own
    // stamp, so this asks for the month to see what the link narrowed to. The
    // search rides in the URL across the change, which is the point of it
    // being there.
    await userEvent.selectOptions(screen.getByRole("combobox"), "30");
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

  it("shows a kind it has never heard of, and counts it where it shows it", () => {
    // A rule someone's settings caused is what they came here to see, and
    // silence is the worse way for this page to be wrong about a new kind. It
    // has to be counted too: a row in the list that the table below it omits
    // makes both numbers untrustworthy.
    const odd = [
      { ...fixture.screened[0], id: 95, kind: "relocation-required" },
      { ...fixture.screened[0], id: 96, url: "https://example.com/96", kind: "out-of-scope" },
    ];
    const shown = screenedFrom(odd, "");
    expect(shown).toHaveLength(2);
    expect(countsByKind(shown).reduce((n, k) => n + k.postings, 0)).toBe(2);
    expect(countsByKind(shown).find((k) => k.kind === "")?.label).toBe("Not grouped");
  });

  it("leaves out the catch-all kind, which the count leaves out too", () => {
    // `other` is a rejection none of the named kinds describes, so nobody can
    // say a setting caused it (SCREENED_NOT_BY_RULES in server/src/validate.js).
    // A list wider than the number above it is how someone stops trusting both.
    const catchAll = [{ ...fixture.screened[0], id: 97, kind: "other", added_by: "run" }];
    expect(screenedFrom(catchAll, "")).toHaveLength(0);
  });

  it("leaves out a lead that was taken down, which no rule rejected", async () => {
    await openTab();
    // The fixture's delisted row is inside the window and would otherwise be
    // the second row down.
    expect(screen.queryByText("posting taken down")).toBeNull();
    expect(screen.queryByRole("link", { name: "Ash" })).toBeNull();
    expect(sumLine()).toHaveTextContent("Showing 4 from the last 30 days");
    expect(screen.queryByText(/Taken down after you saw it/)).toBeNull();
  });

  it("sorts by any column, and says which one it is sorted by", async () => {
    await openTab();
    const header = (name: string) => screen.getByRole("button", { name }).closest("th")!;
    const firstCompany = () => within(rows()[0]).getAllByRole("cell")[1].textContent;
    // It opens newest first, which is the date column descending.
    expect(header("Set aside")).toHaveAttribute("aria-sort", "descending");

    await userEvent.click(screen.getByRole("button", { name: "Posting" }));
    expect(header("Posting")).toHaveAttribute("aria-sort", "ascending");
    expect(header("Set aside")).toHaveAttribute("aria-sort", "none");
    const up = firstCompany();
    expect(window.location.search).toContain("sort=posting");

    // A second click on the same column turns it round.
    await userEvent.click(screen.getByRole("button", { name: "Posting" }));
    expect(header("Posting")).toHaveAttribute("aria-sort", "descending");
    expect(firstCompany()).not.toBe(up);
  });

  it("sorts the Why column in the order the counts above it use, not alphabetically", async () => {
    await openTab();
    await userEvent.click(screen.getByRole("button", { name: "Why" }));
    const whys = rows().map((r) => within(r).getAllByRole("cell")[3].textContent);
    // The order a run decides the kinds in, which is the order the bars are
    // counted in: the two views agreeing beats either being A-to-Z.
    expect(whys).toEqual(["Location", "Level", "Bad fit", "Contract"]);
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
      [...document.querySelectorAll(".screened-kind-pick")].map((b) => b.textContent?.replace(/\s+/g, " ").trim());
    // In the order a run decides between them, so the pay floor's count is what
    // the floor alone cost rather than everything it would also have caught.
    expect(kinds()).toEqual(["1Location", "1Level", "1Bad fit", "1Contract"]);

    await userEvent.click(screen.getByRole("button", { name: /Level/ }));
    expect(rows()).toHaveLength(1);
    expect(screen.getByText(/above target level/)).toBeInTheDocument();
    expect(window.location.search).toContain("kind=wrong-level");

    await userEvent.click(screen.getByRole("button", { name: "Show every reason" }));
    expect(rows()).toHaveLength(4);
  });

  it("leads from a count to the setting that made it", async () => {
    await openTab();
    // A number someone doesn't like is only useful if the rule behind it is one
    // step away, so each kind says where it is set and takes them there.
    const locations = screen.getByRole("link", { name: "where you'd work" });
    expect(locations.getAttribute("href")).toContain("account=locations");

    await userEvent.click(locations);
    const panel = await screen.findByRole("dialog", { name: "My account" });
    expect(within(panel).getByRole("region", { name: "Locations" })).toBeInTheDocument();

    // Closing it leaves the tab as it was, without the section in the URL.
    await userEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(window.location.search).not.toContain("account=");
    expect(rows()).toHaveLength(4);
  });

  it("keeps the view it was read from when a caption leads to a setting", async () => {
    await openTab();
    await userEvent.click(screen.getByRole("button", { name: /Level/ }));
    await userEvent.click(screen.getByRole("button", { name: "Set aside" }));

    // The caption adds the section to the view; it doesn't replace it. Closing
    // the panel only takes `account` back out, so anything the click discarded
    // would be gone for good - and a person reading one search's rejections
    // would come back to all of them.
    const href = screen.getAllByRole("link", { name: "what this search looks for" })[0].getAttribute("href")!;
    const query = new URLSearchParams(href.slice(href.indexOf("?")));
    expect(query.get("account")).toBe("searches");
    expect(query.get("kind")).toBe("wrong-level");
    expect(query.get("sort")).toBe("date");
    expect(query.get("dir")).toBe("asc");
  });

  it("opens the Searches section on the search the captions are about", async () => {
    // Beta is the second search, so opening on it can't be the default.
    const alsoBeta = { ...fixture.screened[3], id: 96, kind: "pay-below-floor" };
    await openTab({ ...fixture, screened: [...fixture.screened, alsoBeta] });
    await userEvent.click(screen.getByRole("button", { name: /^Beta roles/ }));
    await userEvent.click(screen.getByRole("link", { name: "what rules a posting out" }));

    // Arriving at whichever search comes first answers a question nobody asked.
    const panel = await screen.findByRole("dialog", { name: "My account" });
    expect(within(panel).getByRole("tab", { name: "Beta roles", selected: true })).toBeInTheDocument();
  });

  it("heads a narrowed list with the count that was clicked, not its rows", async () => {
    // One job under one url twice: two rows, one posting. The bar says one, so
    // the heading has to as well.
    const twice = [
      { ...fixture.screened[1], id: 90, url: "https://example.com/same" },
      { ...fixture.screened[1], id: 91, url: "https://example.com/same" },
    ];
    await openTab({ ...fixture, screened: [...fixture.screened, ...twice] });
    await userEvent.click(screen.getByRole("button", { name: /Level/ }));

    expect(screen.getByText(/Level . all 2 postings/)).toBeInTheDocument();
    expect(rows()).toHaveLength(3);

    // One is one posting, which is the common case and the one a plural-by-
    // default heading gets wrong.
    await userEvent.click(screen.getByRole("button", { name: "Show every reason" }));
    await userEvent.click(screen.getByRole("button", { name: /Location/ }));
    expect(screen.getByText(/Location . all 1 posting$/)).toBeInTheDocument();
  });

  it("says a rule it can't name is unnamed, not that nobody set it", async () => {
    // A kind newer than this page is shown rather than hidden, because a new
    // rule of theirs is exactly what the tab is for. Saying "nothing you set"
    // beside it would contradict the reason it is on screen at all.
    const unknown = { ...fixture.screened[1], id: 95, kind: "shift-work" };
    await openTab({ ...fixture, screened: [...fixture.screened, unknown] });

    expect(screen.getByText("a rule this page can't name yet")).toBeInTheDocument();
  });

  it("opens on a window the select actually offers", () => {
    // The default and the list are one thing, not two kept in step by hand: a
    // default the list doesn't hold leaves the select on a value no option
    // matches, and the sentence above it reading "from undefined".
    const opens = SCREENED_WINDOWS.filter((w) => w.opensOn);
    expect(opens).toHaveLength(1);
    expect(opens[0].days).toBe(SCREENED_WINDOW_DEFAULT);
  });

  it("opens on today, which is the newest run's work and the usual question", async () => {
    // The tab opens on the shortest window there is: a run stamps its rows with
    // its own local date, so today is that run's work and nobody else's, and
    // every longer window is one choice away.
    const tonight = { ...fixture.screened[1], id: 97, date: daysAgo(0), company: "Cedar" };
    await openTab({ ...fixture, screened: [...fixture.screened, tonight] }, "1");

    // The fixture's own newest rejection is on that day too, so this is what
    // the run did, not what this test added to it.
    expect(screen.getByRole("combobox")).toHaveValue("1");
    expect(sumLine()).toHaveTextContent("Showing 2 from today");
    expect(rows()).toHaveLength(2);
    expect(screen.getByText("Cedar")).toBeInTheDocument();
    expect(rows().every((r) => within(r).queryByText(daysAgo(0)) !== null)).toBe(true);
  });

  it("takes today from the runs' day, not from the clock of whoever is reading", async () => {
    // A row carries the day its run stamped it. Read from east of the runs, the
    // reader's day turns over first, and a window taken from their clock would
    // find today empty with last night's rows sitting a day behind them. Here
    // the newest run is the day before the reader's, which is that same gap.
    const ran = daysAgo(1);
    const tracks = fixture.tracks.map((t) => ({ ...t, last_run: { ...t.last_run, on: ran } }));
    const lastNight = { ...fixture.screened[1], id: 98, date: ran, company: "Cedar" };
    await openTab({ ...fixture, tracks, screened: [...fixture.screened, lastNight] }, "1");

    // Taken from the reader's clock this window starts a day later and misses
    // the run entirely. Taken from the run, it starts on that run's day and
    // nothing older than it gets in.
    expect(screen.getByText("Cedar")).toBeInTheDocument();
    const dates = rows().map((r) => within(r).getByText(/^\d{4}-\d{2}-\d{2}$/).textContent!);
    expect(dates).toContain(ran);
    expect(dates.every((d) => d >= ran)).toBe(true);
  });

  it("falls back to the reader's day when no run has stamped one", async () => {
    // Nothing to take a day from is not a reason to show everything: an empty
    // start would let every row there is through the shortest window there is.
    const tracks = fixture.tracks.map((t) => ({ ...t, last_run: { ...t.last_run, on: "" } }));
    await openTab({ ...fixture, tracks }, "1");

    // The reader's own day, which holds the one row dated there - not every row
    // in the tracker, which is what an empty start would have let through.
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]).getByText(daysAgo(0))).toBeInTheDocument();
  });

  it("opens a stopped search's stamp on that search's own last run", async () => {
    // The searches don't run as one. A task that stops without the search being
    // paused leaves a stamp claiming what its last run set aside, while the
    // others keep running and carry the newest day. Read against theirs, that
    // search's own rows are outside the window its own stamp links to - a link
    // stating a number and opening a view that contradicts it.
    const stopped = daysAgo(3);
    // Alpha's task stopped three nights ago; every other search ran last night,
    // so the newest day across them is theirs and not alpha's.
    const tracks = fixture.tracks.map((t) => ({
      ...t,
      last_run: { ...t.last_run, on: t.key === "alpha" ? stopped : daysAgo(0) },
    }));
    const itsRows = [
      { ...fixture.screened[1], id: 80, search: "alpha", date: stopped, company: "Cedar" },
      { ...fixture.screened[1], id: 81, search: "alpha", date: stopped, company: "Larch", url: "https://example.com/81" },
    ];
    await openTab({ ...fixture, tracks, screened: [...fixture.screened, ...itsRows] }, "1");

    await userEvent.click(screen.getByRole("button", { name: /^Alpha roles/ }));
    expect(screen.getByText("Cedar")).toBeInTheDocument();
    expect(screen.getByText("Larch")).toBeInTheDocument();
  });

  it("keeps the way back to every search when the window holds nothing", async () => {
    // The tab opens on one day and that day can be empty. A chip row built from
    // the window disappears with it, taking "All searches" and leaving someone
    // who arrived from a run stamp narrowed to one search with no way out of it.
    // The newest run turned nothing away, which is a night like any other.
    const screened = fixture.screened.filter((r) => r.date !== daysAgo(0));
    await openTab({ ...fixture, screened }, "1");

    expect(screen.getByText("Nothing was set aside in this window.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^All searches/ })).toBeInTheDocument();
    // Counted by the window, so a search with nothing in it reads zero rather
    // than going missing.
    expect(screen.getByRole("button", { name: "Alpha roles 0" })).toBeInTheDocument();
  });

  it("offers a way to clear a narrowing even when there is only one search", async () => {
    // One search needs no row to choose between. Narrowed to it, though, the
    // row is the only thing on screen that can clear the narrowing, and without
    // it someone has to edit the address to get out of a view a link put them
    // in.
    const one = { ...fixture, screened: fixture.screened.filter((r) => r.search === "alpha") };
    await openTab(one, "1", "/screened?search=alpha");
    expect(screen.getByRole("button", { name: /^All searches/ })).toBeInTheDocument();
  });

  it("offers no way to clear a narrowing nobody made", async () => {
    // One search and no narrowing: a row of one chip chooses between nothing.
    const one = { ...fixture, screened: fixture.screened.filter((r) => r.search === "alpha") };
    await openTab(one, "1");
    expect(screen.queryByRole("button", { name: /^All searches/ })).toBeNull();
  });

  it("says where a kind nobody set comes from, without offering a setting", () => {
    // "Gone before you saw it" is a fact about a posting; there is no rule of
    // theirs behind it, and a link would promise one.
    const facts = SCREENED_KINDS.filter((k) => !k.mine);
    expect(facts.every((k) => k.set === undefined)).toBe(true);
    expect(SCREENED_KINDS.filter((k) => k.mine).every((k) => k.set !== undefined)).toBe(true);
  });

  it("counts postings rather than rows, since one job re-listed is two rows", async () => {
    const twice = [
      { ...fixture.screened[0], id: 90, url: "https://example.com/same", kind: "wrong-level" },
      { ...fixture.screened[0], id: 91, url: "https://example.com/same", kind: "wrong-level" },
      { ...fixture.screened[0], id: 92, url: "https://example.com/other", kind: "wrong-level" },
    ];
    expect(countsByKind(twice)).toEqual([{ kind: "wrong-level", label: "Level", postings: 2 }]);
    // A row with no url is its own posting: there is nothing to match it on.
    const blank = [
      { ...fixture.screened[0], id: 93, url: "", kind: "dead" },
      { ...fixture.screened[0], id: 94, url: "", kind: "dead" },
    ];
    expect(countsByKind(blank)[0].postings).toBe(2);
  });

  it("names the rule that turned a posting away, beside the sentence about it", async () => {
    await openTab();
    const byRule = screen.getByText(/outside the US/).closest("tr")!;
    expect(within(byRule).getByText("Location")).toBeInTheDocument();
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
