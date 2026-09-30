/**
 * The grid's status buttons: one tap per verdict while scanning, the pressed
 * one saying what the row carries, and the way back from a tap that hid a row.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import type { TrackerData } from "./api/schema";
import { LEAD_NEW, LEAD_STATUS, LEAD_TRIAGE } from "./domain/constants";
import { NOW, data as fixture } from "./domain/fixture";
import { clearPrefs, setPrefs } from "./ui/prefs";

function renderAt(path: string, data: TrackerData = fixture) {
  vi.spyOn(client, "getData").mockResolvedValue(data);
  window.history.pushState({}, "", path);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
  return screen.findByRole("heading", { name: "Fixture Search" });
}

const lead = (company: string) => fixture.leads.find((l) => l.company === company)!;
const row = (company: string) =>
  [...document.querySelectorAll<HTMLElement>("tr[data-expand]")].find((r) => r.textContent?.includes(company))!;
const listed = () => [...document.querySelectorAll("tr[data-expand] .co")].map((e) => e.textContent);

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

describe("a search that found something today", () => {
  const today = fixture.tracks[0].last_run.on;
  const withFresh: TrackerData = {
    ...fixture,
    leads: [...fixture.leads, { ...fixture.leads[0], id: 905, company: "Fresh", found: today }],
  };
  const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });

  it("says so on its tab, and says how much", async () => {
    await renderAt("/all-leads", withFresh);

    expect(within(tab("Alpha roles")).getByRole("img", { name: "1 found today" })).toBeInTheDocument();
    // Beta ran eight days ago. It carries a dot, but the one saying its run
    // errored - not this one.
    expect(within(tab("Beta roles")).queryByRole("img", { name: /found today/ })).toBeNull();
    expect(within(tab("Beta roles")).getByRole("img", { name: /reported an error/ })).toBeInTheDocument();
    // The pooled tab holds the same lead and stays quiet: it would light on
    // any morning any search ran.
    expect(within(tab("All leads")).queryByRole("img")).toBeNull();
  });

  it("stays quiet for a search whose last run was days ago", async () => {
    // Beta ran eight days ago. What it found then is still the newest it has,
    // and none of it is news this morning - so no dot, and the label can't
    // claim a day it doesn't mean.
    const stale: TrackerData = {
      ...fixture,
      leads: [...fixture.leads, { ...fixture.leads[0], id: 906, search: "beta", found: fixture.tracks[1].last_run.on }],
    };
    await renderAt("/all-leads", stale);

    expect(within(tab("Beta roles")).queryByRole("img", { name: /found today/ })).toBeNull();
  });

  it("stays quiet where the run found nothing", async () => {
    await renderAt("/all-leads");

    expect(screen.queryByRole("img", { name: /found today/ })).toBeNull();
  });
});

describe("triage-covers-status", () => {
  it("offers every status a person sets, and only New is left out", () => {
    expect([...LEAD_TRIAGE].sort()).toEqual(LEAD_STATUS.filter((s) => s !== LEAD_NEW).sort());
  });
});

describe("a grid row's status buttons", () => {
  it("offer the three verdicts, with the row's own pressed", async () => {
    setPrefs({ view: "grid", leadSort: "company-asc" });
    await renderAt("/t/alpha?filter=All");

    const names = [...row("Bolt").querySelectorAll(".triage button")].map((b) => b.textContent);
    expect(names).toEqual(["Reviewing", "Not a fit", "Applied"]);
    // Bolt is Reviewing in the fixture; nothing else on the row claims to be.
    expect(within(row("Bolt")).getByRole("button", { name: "Reviewing", pressed: true })).toBeInTheDocument();
    expect(within(row("Bolt")).getByRole("button", { name: "Not a fit", pressed: false })).toBeInTheDocument();
  });

  it("never draw Applied pressed, because the row leaves before it could", async () => {
    setPrefs({ view: "grid", leadSort: "company-asc" });
    await renderAt("/t/alpha?filter=All");

    // Cog is Applied in the fixture, and leadRows drops it from every leads tab.
    expect(listed()).not.toContain("Cog");
    for (const company of listed()) {
      expect(within(row(company!)).getByRole("button", { name: "Applied" })).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("mark a row with one tap", async () => {
    setPrefs({ view: "grid", leadSort: "company-asc" });
    await renderAt("/t/alpha?filter=All");
    const set = vi
      .spyOn(client, "setLeadStatus")
      .mockResolvedValue({ lead: { ...lead("Acme"), status: "Reviewing" }, application: null });

    await userEvent.click(within(row("Acme")).getByRole("button", { name: "Reviewing" }));

    expect(set).toHaveBeenCalledWith(lead("Acme").id, "Reviewing");
    await waitFor(() =>
      expect(within(row("Acme")).getByRole("button", { name: "Reviewing" })).toHaveAttribute("aria-pressed", "true"),
    );
  });

  it("take a row back to New when its own verdict is tapped again", async () => {
    setPrefs({ view: "grid", leadSort: "company-asc" });
    await renderAt("/t/alpha?filter=All");
    const set = vi
      .spyOn(client, "setLeadStatus")
      .mockResolvedValue({ lead: { ...lead("Bolt"), status: LEAD_NEW }, application: null });

    await userEvent.click(within(row("Bolt")).getByRole("button", { name: "Reviewing", pressed: true }));

    expect(set).toHaveBeenCalledWith(lead("Bolt").id, LEAD_NEW);
    await waitFor(() =>
      expect(within(row("Bolt")).getByRole("button", { name: "Reviewing" })).toHaveAttribute("aria-pressed", "false"),
    );
  });

  it("un-click a verdict that is wrong, without a second control to find", async () => {
    // The way back from a mis-tap, and the whole of it: the button that made
    // the change is the button that takes it back.
    setPrefs({ view: "grid", leadSort: "company-asc" });
    await renderAt("/t/alpha?filter=All");
    const set = vi
      .spyOn(client, "setLeadStatus")
      .mockResolvedValue({ lead: { ...lead("Acme"), status: "Not a fit" }, application: null });

    await userEvent.click(within(row("Acme")).getByRole("button", { name: "Not a fit" }));
    await waitFor(() =>
      expect(within(row("Acme")).getByRole("button", { name: "Not a fit" })).toHaveAttribute("aria-pressed", "true"),
    );

    set.mockResolvedValue({ lead: { ...lead("Acme"), status: LEAD_NEW }, application: null });
    await userEvent.click(within(row("Acme")).getByRole("button", { name: "Not a fit" }));

    expect(set).toHaveBeenLastCalledWith(lead("Acme").id, LEAD_NEW);
  });

  it("leave nothing for a person to save or dismiss after a verdict", async () => {
    setPrefs({ view: "grid", leadSort: "company-asc" });
    await renderAt("/t/alpha?filter=All");
    vi.spyOn(client, "setLeadStatus").mockResolvedValue({ lead: { ...lead("Acme"), status: "Not a fit" }, application: null });

    await userEvent.click(within(row("Acme")).getByRole("button", { name: "Not a fit" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("a verdict that takes the row out of the list", () => {
  it("says where it went, since the buttons go with it", async () => {
    // Un-clicking needs the row still on screen, and two cases take it away:
    // Not a fit under a chip that excludes it, and Applied under any chip at
    // all, since leadRows drops Applied from every leads tab. Applied also
    // creates the application row, which setting the lead back would not
    // remove - that one is undone from Applications, not from here. The
    // sentence is what is left saying anything happened.
    setPrefs({ view: "grid", leadSort: "company-asc" });
    await renderAt("/t/alpha");
    vi.spyOn(client, "setLeadStatus").mockResolvedValue({ lead: { ...lead("Bolt"), status: "Not a fit" }, application: null });

    await userEvent.click(within(row("Bolt")).getByRole("button", { name: "Not a fit" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Marked Not a fit — hidden from Open"));
    expect(listed()).not.toContain("Bolt");
  });

  it("names the tab a row set to Applied moved to", async () => {
    setPrefs({ view: "grid", leadSort: "company-asc" });
    await renderAt("/t/alpha");
    const applied = { ...lead("Acme"), status: "Applied" };
    vi.spyOn(client, "setLeadStatus").mockResolvedValue({
      lead: applied,
      application: { ...fixture.applications[0], id: 9300, leadId: String(applied.id), company: "Acme" },
    });

    await userEvent.click(within(row("Acme")).getByRole("button", { name: "Applied" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Moved to Applications"));
    expect(listed()).not.toContain("Acme");
  });
});
