/**
 * Detail-pane, grid, add-row and empty-track behaviour that nothing else in the
 * suite would notice going missing.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import type { Application, TrackerData } from "./api/schema";
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

/** The fixture with one application patched. */
function withApp(id: number, patch: Partial<Application>): TrackerData {
  return { ...fixture, applications: fixture.applications.map((a) => (a.id === id ? { ...a, ...patch } : a)) };
}

const app = (id: number) => fixture.applications.find((a) => a.id === id)!;
const detail = () => document.querySelector(".md-detail") as HTMLElement;

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

describe("an application's detail pane", () => {
  it("edits the company, role and location in the header itself", async () => {
    // For a row added as nothing but a URL, this is where they get typed in.
    setPrefs({ selected: { applications: "13" } });
    await renderAt("/applications");

    const company = within(detail()).getByLabelText("Company");
    expect(company).toHaveValue("Kit");
    expect(company).toHaveClass("dh-in", "dh-h1");
    expect(within(detail()).getByLabelText("Role")).toHaveClass("dh-in", "dh-sub-in");
    expect(within(detail()).getByLabelText("Location")).toHaveClass("dh-in", "dh-loc-in");

    const update = vi.spyOn(client, "updateApplicationField").mockResolvedValue({ ...app(13), company: "Kit Labs" });
    await userEvent.clear(company);
    await userEvent.type(company, "Kit Labs");
    await userEvent.tab();
    await waitFor(() => expect(update).toHaveBeenCalledWith(13, "company", "Kit Labs"));
  });

  it("edits the applied date, and every stage date - blank ones included, so a skipped stage can be backfilled", async () => {
    setPrefs({ selected: { applications: "17" } });
    await renderAt("/applications");
    const d = detail();

    expect(within(d).getByLabelText("Date applied")).toHaveAttribute("type", "date");
    for (const stage of ["Recruiter Screen", "Tech Screen", "Onsite / Loop", "Offer", "Rejected", "Withdrawn"]) {
      expect(within(d).getByLabelText(stage)).toHaveAttribute("type", "date");
    }
    expect(within(d).getByLabelText("Tech Screen")).toHaveValue(app(17).dateTechScreen);
    expect(within(d).getByLabelText("Offer")).toHaveValue("");
  });

  it("draws role details and stage history as headed cards, and notes as their own block", async () => {
    setPrefs({ selected: { applications: "17" } });
    await renderAt("/applications");
    const headings = [...detail().querySelectorAll(".facts-card > .mf-label")].map((e) => e.textContent);
    expect(headings).toEqual(["Role details", "Stage history"]);
    expect(detail().querySelector(".facts-card .more-grid .mf")).not.toBeNull();
    expect(detail().querySelector(".stage-hist table")).not.toBeNull();
    // An application's notes box has no placeholder; a lead's does.
    expect(detail().querySelector(".dh-notes textarea")).not.toHaveAttribute("placeholder");
  });

  it("says which track the application came from, when it came from a lead", async () => {
    setPrefs({ selected: { applications: "13" } });
    await renderAt("/applications", withApp(13, { leadId: "1" }));
    expect(within(detail()).getByText("Alpha roles")).toHaveClass("dh-track");
  });

  it("puts an Open link beside the Link field rather than turning the field into a link", async () => {
    setPrefs({ selected: { applications: "11" } });
    await renderAt("/applications");
    const open = within(detail()).getByRole("link", { name: "Open ↗" });
    expect(open).toHaveAttribute("href", "https://example.com/11");
    expect(within(detail()).getByLabelText("Link")).toHaveValue("https://example.com/11");
  });
});

describe("the overnight fill's note", () => {
  it.each([
    ["failed", "could not read this posting", true],
    ["filled", "read part of this posting", false],
  ])("autofill=%s with a note says it %s", async (autofill, text, bad) => {
    setPrefs({ selected: { applications: "13" } });
    await renderAt("/applications", withApp(13, { autofill, autofill_note: "no salary on the page" }));
    const note = detail().querySelector(".af")!;
    expect(note).toHaveTextContent(text);
    expect(note).toHaveTextContent("no salary on the page");
    expect(note.classList.contains("bad")).toBe(bad);
  });

  it("says nothing for a row the run left no note on", async () => {
    setPrefs({ selected: { applications: "13" } });
    await renderAt("/applications");
    expect(detail().querySelector(".af")).toBeNull();
  });
});

describe("adding an application", () => {
  it("selects the existing row instead of adding a pasted link twice", async () => {
    const add = vi.spyOn(client, "addApplication");
    await renderAt("/applications");

    // Case-insensitive, and otherwise exact: the mistake a one-box form invites.
    await userEvent.type(screen.getByLabelText("Link to a job posting"), "HTTPS://example.com/11{Enter}");

    expect(await screen.findByRole("status")).toHaveTextContent("Already in your applications");
    expect(add).not.toHaveBeenCalled();
    await waitFor(() => expect(within(detail()).getByLabelText("Company")).toHaveValue("Ida"));
  });

  it("selects the new row, and says what happens to a link-only row", async () => {
    const created: Application = {
      ...app(13),
      id: 9100,
      company: "",
      title: "",
      location: "",
      link: "https://example.com/new",
      autofill: "",
      autofill_note: "",
    };
    vi.spyOn(client, "addApplication").mockResolvedValue(created);
    await renderAt("/applications");

    await userEvent.type(screen.getByLabelText("Link to a job posting"), "https://example.com/new{Enter}");

    expect(await screen.findByRole("status")).toHaveTextContent("Added — it fills in overnight");
    await waitFor(() => expect(within(detail()).getByLabelText("Link")).toHaveValue("https://example.com/new"));
  });
});

describe("a lead's detail pane", () => {
  it("draws role details as an unheaded card and notes as their own block", async () => {
    await renderAt("/all-leads");
    const d = detail();
    expect(d.querySelector(".facts-card .more-grid .mf")).not.toBeNull();
    expect(d.querySelector(".facts-card .mf-label")).toBeNull();
    expect(d.querySelector(".dh-notes textarea")).toHaveAttribute("placeholder", "Add a note");
  });
});

describe("grid rows", () => {
  it("expand on a click anywhere on the row", async () => {
    setPrefs({ view: "grid" });
    await renderAt("/all-leads");
    expect(document.querySelector("tr.more-row")).toBeNull();

    await userEvent.click(screen.getByText("Acme"));

    expect(document.querySelector("tr.more-row .facts-card .more-grid")).not.toBeNull();
  });

  it("leave a click on a control to the control", async () => {
    setPrefs({ view: "grid" });
    await renderAt("/all-leads");
    await userEvent.click(screen.getAllByLabelText("Comp range")[0]);
    expect(document.querySelector("tr.more-row")).toBeNull();
  });

  it("keep a real button for the same toggle, so it works from the keyboard", async () => {
    setPrefs({ view: "grid" });
    await renderAt("/all-leads");
    const details = screen.getAllByRole("button", { name: "Details" })[0];
    expect(details).toHaveAttribute("aria-expanded", "false");
    details.focus();
    await userEvent.keyboard("{Enter}");
    expect(document.querySelector("tr.more-row")).not.toBeNull();
  });
});

describe("an empty track", () => {
  it("warns when its search has gone stale, not only when it errored", async () => {
    const staleBeta: TrackerData = {
      ...fixture,
      leads: fixture.leads.filter((l) => l.search !== "beta"),
      tracks: fixture.tracks.map((t) => (t.key === "beta" ? { ...t, last_run: { ...t.last_run, status: "ok" } } : t)),
    };
    await renderAt("/t/beta", staleBeta);
    expect(document.querySelector(".empty-warn")).not.toBeNull();
  });
});
