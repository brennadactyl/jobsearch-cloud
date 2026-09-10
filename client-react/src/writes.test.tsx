/**
 * The write paths.
 *
 * What these are really testing is the optimistic layer, because that is the
 * part with a failure mode the old page did not have. There, a write either
 * happened or the row stayed as it was. Here the row changes *first* and the
 * server's answer decides whether it stays changed - so "does a failure put it
 * back" is a question worth asking of every mutation, and "does the indicator
 * say which of the two happened" is the thing that makes a rollback legible
 * rather than a mystery.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import { NOW, data as fixture } from "./domain/fixture";
import { clearPrefs, setPrefs } from "./ui/prefs";

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  clearPrefs();
  localStorage.setItem("tracker_token", "a-token");
  vi.spyOn(client, "getData").mockResolvedValue(fixture);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The lead the fixture puts first under the default priority sort. */
const FIRST_LEAD = fixture.leads.find((l) => l.company === "Acme")!;

async function openLeads() {
  window.history.pushState({}, "", "/all-leads");
  renderApp();
  await screen.findByRole("heading", { name: "Fixture Search" });
}

describe("editing a field", () => {
  it("saves on blur, not on every keystroke", async () => {
    const update = vi.spyOn(client, "updateLeadField").mockResolvedValue({ ...FIRST_LEAD, comp: "£100k" });
    await openLeads();

    const comp = screen.getByLabelText("Comp range");
    await userEvent.type(comp, "£100k");
    // Five keystrokes, no request yet.
    expect(update).not.toHaveBeenCalled();

    await userEvent.tab();
    await waitFor(() => expect(update).toHaveBeenCalledWith(FIRST_LEAD.id, "comp", "£100k"));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
  });

  it("makes no request when the value came back unchanged", async () => {
    const update = vi.spyOn(client, "updateLeadField");
    await openLeads();
    await userEvent.click(screen.getByLabelText("Comp range"));
    await userEvent.tab();
    expect(update).not.toHaveBeenCalled();
  });

  it("puts the old value back when the save fails, and says so", async () => {
    vi.spyOn(client, "updateLeadField").mockRejectedValue(new Error("network"));
    await openLeads();

    const comp = screen.getByLabelText("Comp range");
    await userEvent.type(comp, "£100k");
    await userEvent.tab();

    expect(await screen.findByRole("status")).toHaveTextContent("Couldn't save");
    // Rolled back, not left showing an edit that did not land.
    await waitFor(() => expect(screen.getByLabelText("Comp range")).toHaveValue(""));
  });
});

describe("lead status", () => {
  it("goes through its own endpoint, not the generic field write", async () => {
    // The server owns side effects a plain field patch cannot do.
    const setStatus = vi
      .spyOn(client, "setLeadStatus")
      .mockResolvedValue({ lead: { ...FIRST_LEAD, status: "Reviewing" }, application: null });
    const update = vi.spyOn(client, "updateLeadField");
    await openLeads();

    const list = document.querySelector(".md-detail")!;
    await userEvent.selectOptions(within(list as HTMLElement).getByLabelText("Status"), "Reviewing");

    await waitFor(() => expect(setStatus).toHaveBeenCalledWith(FIRST_LEAD.id, "Reviewing"));
    expect(update).not.toHaveBeenCalled();
  });

  it("takes the application the server creates when a lead is marked Applied", async () => {
    // Not guessed optimistically - it has no id until the server assigns one.
    const created = { ...fixture.applications[0], id: 9001, company: "Acme", leadId: String(FIRST_LEAD.id) };
    vi.spyOn(client, "setLeadStatus").mockResolvedValue({
      lead: { ...FIRST_LEAD, status: "Applied" },
      application: created,
    });
    await openLeads();

    const detail = document.querySelector(".md-detail")!;
    await userEvent.selectOptions(within(detail as HTMLElement).getByLabelText("Status"), "Applied");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"));

    // The Applications tab badge counts the new row.
    const tab = screen.getAllByRole("tab").find((t) => t.textContent?.startsWith("Applications"))!;
    await waitFor(() => expect(tab.textContent).toContain(String(fixture.applications.length + 1)));
  });
});

describe("moving a lead to another tab", () => {
  it("reports the reason it was refused, rather than a generic failure", async () => {
    // Both of this call's failures are worth reading: an unknown track key, and
    // a destination that already holds the posting.
    vi.spyOn(client, "moveLead").mockRejectedValue(new Error('"beta" already has a lead for that url'));
    await openLeads();

    await userEvent.selectOptions(screen.getByLabelText("Tab"), "beta");
    expect(await screen.findByRole("status")).toHaveTextContent("already has a lead for that url");
  });
});

describe("application status and the stage-date dialog", () => {
  async function openApps() {
    window.history.pushState({}, "", "/applications");
    renderApp();
    await screen.findByRole("heading", { name: "Fixture Search" });
  }

  it("asks when a stage happened, instead of silently stamping today", async () => {
    const setStatus = vi.spyOn(client, "setApplicationStatus");
    setPrefs({ selected: { applications: String(fixture.applications[2].id) } });
    await openApps();

    const detail = document.querySelector(".md-detail")!;
    await userEvent.selectOptions(within(detail as HTMLElement).getByLabelText("Status"), "Tech Screen");

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("When is this scheduled?");
    // Nothing written until the date is confirmed.
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("writes the confirmed date with the status", async () => {
    const setStatus = vi
      .spyOn(client, "setApplicationStatus")
      .mockResolvedValue({ ...fixture.applications[2], status: "Tech Screen" });
    setPrefs({ selected: { applications: String(fixture.applications[2].id) } });
    await openApps();

    const detail = document.querySelector(".md-detail")!;
    await userEvent.selectOptions(within(detail as HTMLElement).getByLabelText("Status"), "Tech Screen");
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(setStatus).toHaveBeenCalledWith(fixture.applications[2].id, "Tech Screen", "2026-09-10"),
    );
  });

  it("writes nothing at all when the dialog is cancelled", async () => {
    const setStatus = vi.spyOn(client, "setApplicationStatus");
    setPrefs({ selected: { applications: String(fixture.applications[2].id) } });
    await openApps();

    const detail = document.querySelector(".md-detail")!;
    const select = within(detail as HTMLElement).getByLabelText("Status");
    await userEvent.selectOptions(select, "Tech Screen");
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(setStatus).not.toHaveBeenCalled();
    // The select is controlled, so it shows the row's real status again with no
    // reverting needed - the old page had to reset the element by hand.
    await waitFor(() => expect(select).toHaveValue(fixture.applications[2].status));
  });

  it("skips the dialog for a stage already reached", async () => {
    const setStatus = vi
      .spyOn(client, "setApplicationStatus")
      .mockResolvedValue({ ...fixture.applications[8], status: "Recruiter Screen" });
    // Qed has every stage date stamped.
    const qed = fixture.applications.find((a) => a.company === "Qed")!;
    setPrefs({ selected: { applications: String(qed.id) } });
    await openApps();

    const detail = document.querySelector(".md-detail")!;
    await userEvent.selectOptions(within(detail as HTMLElement).getByLabelText("Status"), "Recruiter Screen");

    await waitFor(() => expect(setStatus).toHaveBeenCalledWith(qed.id, "Recruiter Screen", undefined));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("removing a posting", () => {
  it("asks for a reason and sends it, because that is what stops it coming back", async () => {
    const del = vi.spyOn(client, "deleteLead").mockResolvedValue({ kept: [] });
    vi.spyOn(window, "prompt").mockReturnValue("outside target locations");
    await openLeads();

    await userEvent.click(screen.getByRole("button", { name: /^Remove Acme/ }));
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(FIRST_LEAD.id, "outside target locations"),
    );
  });

  it("writes nothing when the reason is dismissed", async () => {
    const del = vi.spyOn(client, "deleteLead");
    vi.spyOn(window, "prompt").mockReturnValue(null);
    await openLeads();
    await userEvent.click(screen.getByRole("button", { name: /^Remove Acme/ }));
    expect(del).not.toHaveBeenCalled();
  });

  it("puts the row back when the server kept it", async () => {
    // `kept` non-empty means an application still points at the lead and
    // nothing was deleted - so the optimistic removal has to be undone on a
    // *successful* response, not only on an error.
    vi.spyOn(client, "deleteLead").mockResolvedValue({ kept: [{ id: FIRST_LEAD.id }] });
    vi.spyOn(window, "prompt").mockReturnValue("changed my mind");
    await openLeads();

    await userEvent.click(screen.getByRole("button", { name: /^Remove Acme/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("an application points at it");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Remove Acme/ })).toBeInTheDocument());
  });
});

describe("adding an application", () => {
  it("sends the pasted link and clears the box", async () => {
    const add = vi
      .spyOn(client, "addApplication")
      .mockResolvedValue({ ...fixture.applications[0], id: 9002, link: "https://example.com/new" });
    window.history.pushState({}, "", "/applications");
    renderApp();
    await screen.findByRole("heading", { name: "Fixture Search" });

    const box = screen.getByLabelText("Link to a job posting");
    await userEvent.type(box, "https://example.com/new{Enter}");

    await waitFor(() => expect(add).toHaveBeenCalledWith("https://example.com/new"));
    expect(box).toHaveValue("");
  });

  it("says which of its two jobs the button is about to do", async () => {
    window.history.pushState({}, "", "/applications");
    renderApp();
    await screen.findByRole("heading", { name: "Fixture Search" });

    expect(screen.getByRole("button", { name: "Add empty row" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Link to a job posting"), "https://example.com/x");
    expect(await screen.findByRole("button", { name: "Add from link" })).toBeInTheDocument();
  });
});
