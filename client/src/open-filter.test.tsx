/**
 * Leads tabs open on Open (New and Reviewing): the default chip, the Overview
 * figure that links to it, what happens to a row that leaves it, and the file an
 * export writes from it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import type { Lead, TrackerData } from "./api/schema";
import { NOW, data as fixture } from "./domain/fixture";
import { clearPrefs, setPrefs } from "./ui/prefs";
import * as download from "./ui/download";

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

const listed = () => [...document.querySelectorAll(".md-row .co")].map((e) => e.textContent);
const selected = () => document.querySelector(".md-row.sel .co")?.textContent;
const chip = (name: string) => within(document.querySelector(".toolbar .chips") as HTMLElement).getByRole("button", { name });
const lead = (company: string) => fixture.leads.find((l) => l.company === company)!;

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

describe("a leads tab's chips", () => {
  it("offer Open, each status, then All", async () => {
    await renderAt("/all-leads");
    const names = [...document.querySelectorAll(".toolbar .chips .chip")].map((c) => c.textContent);
    expect(names).toEqual(["Open", "New", "Reviewing", "Not a fit", "All"]);
  });

  it("open on Open with no filter in the URL, which leaves out Not a fit", async () => {
    setPrefs({ leadSort: "company-asc" });
    await renderAt("/all-leads");
    expect(chip("Open")).toHaveAttribute("aria-pressed", "true");
    expect(listed()).toEqual(["Acme", "Bolt", "Echo", "Fox", "Gil"]);
    // M is still every row the tab holds, so the hidden one shows in the gap.
    expect(document.querySelector(".note")).toHaveTextContent("5 of 6 shown");
  });

  it("show every status under All, which is its own URL, and go back to no filter for Open", async () => {
    await renderAt("/all-leads");
    await userEvent.click(chip("All"));
    await waitFor(() => expect(window.location.search).toBe("?filter=All"));
    expect(listed()).toContain("Dyn");
    expect(listed()).toHaveLength(6);

    await userEvent.click(chip("Open"));
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(listed()).not.toContain("Dyn");
  });
});

describe("the Overview's Open leads tile", () => {
  it("counts the rows the tab opens on", async () => {
    await renderAt("/");
    const tile = screen.getAllByRole("link").find((el) => /Open leads/.test(el.textContent ?? ""))!;
    const counted = Number(tile.querySelector(".v")!.textContent);
    await userEvent.click(tile);
    await waitFor(() => expect(window.location.pathname).toBe("/all-leads"));
    expect(document.querySelectorAll(".md-row")).toHaveLength(counted);
    expect(counted).toBe(5);
  });
});

describe("marking a lead so it leaves the chip on screen", () => {
  it("takes it out of Open, selects the row that followed it, and says where it went", async () => {
    // A middle row, so "the row that followed it" and "the first row" differ.
    setPrefs({ leadSort: "company-asc", selected: { allleads: String(lead("Echo").id) } });
    await renderAt("/all-leads");
    expect(listed()).toEqual(["Acme", "Bolt", "Echo", "Fox", "Gil"]);
    vi.spyOn(client, "setLeadStatus").mockResolvedValue({ lead: { ...lead("Echo"), status: "Not a fit" }, application: null });

    await userEvent.selectOptions(within(document.querySelector(".md-detail") as HTMLElement).getByLabelText("Status"), "Not a fit");

    await waitFor(() => expect(listed()).toEqual(["Acme", "Bolt", "Fox", "Gil"]));
    expect(selected()).toBe("Fox");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Marked Not a fit — hidden from Open"));
  });

  it("selects the row before it when the last row leaves", async () => {
    setPrefs({ leadSort: "company-asc", selected: { allleads: String(lead("Gil").id) } });
    await renderAt("/all-leads");
    vi.spyOn(client, "setLeadStatus").mockResolvedValue({ lead: { ...lead("Gil"), status: "Not a fit" }, application: null });

    await userEvent.selectOptions(within(document.querySelector(".md-detail") as HTMLElement).getByLabelText("Status"), "Not a fit");

    await waitFor(() => expect(listed()).not.toContain("Gil"));
    expect(selected()).toBe("Fox");
  });

  it("puts the row and the selection back when the save fails", async () => {
    setPrefs({ leadSort: "company-asc", selected: { allleads: String(lead("Echo").id) } });
    await renderAt("/all-leads");
    vi.spyOn(client, "setLeadStatus").mockRejectedValue(new Error("boom"));

    await userEvent.selectOptions(within(document.querySelector(".md-detail") as HTMLElement).getByLabelText("Status"), "Not a fit");

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Couldn't save — try again"));
    expect(listed()).toEqual(["Acme", "Bolt", "Echo", "Fox", "Gil"]);
    expect(selected()).toBe("Echo");
  });

  it("says the tab a lead set to Applied went to", async () => {
    setPrefs({ leadSort: "company-asc", selected: { allleads: String(lead("Echo").id) } });
    await renderAt("/all-leads?filter=All");
    const applied = { ...lead("Echo"), status: "Applied" };
    vi.spyOn(client, "setLeadStatus").mockResolvedValue({
      lead: applied,
      application: { ...fixture.applications[0], id: 9200, leadId: String(applied.id), company: "Echo" },
    });

    await userEvent.selectOptions(within(document.querySelector(".md-detail") as HTMLElement).getByLabelText("Status"), "Applied");

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Moved to Applications"));
    expect(listed()).not.toContain("Echo");
    expect(selected()).toBe("Fox");
  });

  it("keeps the row, and just saves, under All", async () => {
    setPrefs({ selected: { alpha: String(lead("Acme").id) } });
    await renderAt("/t/alpha?filter=All");
    vi.spyOn(client, "setLeadStatus").mockResolvedValue({ lead: { ...lead("Acme"), status: "Not a fit" }, application: null });

    await userEvent.selectOptions(within(document.querySelector(".md-detail") as HTMLElement).getByLabelText("Status"), "Not a fit");

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"));
    expect(listed()).toContain("Acme");
    expect(selected()).toBe("Acme");
  });

  it("leaves the highlight alone in Grid when the row marked isn't the highlighted one", async () => {
    setPrefs({ view: "grid", leadSort: "company-asc", selected: { alpha: String(lead("Acme").id) } });
    await renderAt("/t/alpha");
    vi.spyOn(client, "setLeadStatus").mockResolvedValue({ lead: { ...lead("Bolt"), status: "Not a fit" }, application: null });
    const boltRow = [...document.querySelectorAll<HTMLElement>("tr[data-expand]")].find((r) => r.textContent?.includes("Bolt"))!;

    await userEvent.selectOptions(within(boltRow).getByLabelText("Status"), "Not a fit");

    await waitFor(() => expect(document.querySelectorAll("tr[data-expand]")).toHaveLength(1));
    expect(document.querySelector("tr.gr-sel")).toHaveTextContent("Acme");
  });
});

describe("an Open list with nothing open", () => {
  const allTriaged: TrackerData = {
    ...fixture,
    leads: fixture.leads.map((l): Lead => (l.search === "alpha" && l.status !== "Applied" ? { ...l, status: "Not a fit" } : l)),
  };

  it("says nothing is open and links to what was marked Not a fit", async () => {
    await renderAt("/t/alpha", allTriaged);
    const empty = document.querySelector(".card.empty") as HTMLElement;
    expect(empty).toHaveTextContent("Nothing open");
    const link = within(empty).getByRole("link", { name: "3 marked Not a fit" });

    await userEvent.click(link);

    await waitFor(() => expect(new URLSearchParams(window.location.search).get("filter")).toBe("Not a fit"));
    expect(document.querySelectorAll(".md-row")).toHaveLength(3);
  });

  it("still says nothing matches when a search is what emptied it", async () => {
    await renderAt("/t/alpha?q=no-such-company");
    expect(document.querySelector(".card.empty")).toHaveTextContent("Nothing matches");
  });
});

describe("exporting from a leads tab", () => {
  async function exported(path: string) {
    const save = vi.spyOn(download, "downloadFile").mockImplementation(() => {});
    await renderAt(path);
    // What the list shows: the button itself, or its menu's first choice.
    const button = screen.getByRole("button", { name: "Export" });
    await userEvent.click(button);
    if (button.getAttribute("aria-haspopup")) await userEvent.click(screen.getByRole("menuitem", { name: /^Export \d+ shown$/ }));
    return save.mock.calls[0][1];
  }

  it("leaves Not a fit out of an Open export", async () => {
    const csv = await exported("/all-leads");
    expect(csv).not.toContain('"Dyn"');
    expect(csv).toContain('"Acme"');
  });

  it("includes Not a fit in an All export", async () => {
    expect(await exported("/all-leads?filter=All")).toContain('"Dyn"');
  });
});
