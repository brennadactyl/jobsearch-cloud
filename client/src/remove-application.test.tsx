/**
 * Removing an application puts its lead back on the board, and the page has to
 * show that without being reloaded.
 *
 * The lead is the thing someone goes looking for afterwards, and until the
 * reply's row is patched in the cache keeps it reading Applied - which
 * `leadRows` drops from every leads tab, so the posting is nowhere.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import type { TrackerData } from "./api/schema";
import { NOW, data as fixture } from "./domain/fixture";
import { clearPrefs } from "./ui/prefs";

/** An application made from a lead that is still sitting at Applied. */
const LEAD = fixture.leads.find((l) => l.status === "Applied")!;
const APP = { ...fixture.applications[0], id: 9400, company: LEAD.company, leadId: String(LEAD.id) };
const data: TrackerData = { ...fixture, applications: [APP, ...fixture.applications] };

function renderAt(path: string) {
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
const REMOVE = new RegExp(`^Remove ${LEAD.company}`);

beforeEach(() => {
  localStorage.clear();
  clearPrefs();
  localStorage.setItem("tracker_token", "a-token");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function removeIt() {
  await renderAt("/applications?filter=All");
  // The remove control lives in the detail pane, so the row is selected first.
  const row = [...document.querySelectorAll<HTMLElement>(".md-row")].find((r) => r.textContent?.includes(LEAD.company));
  await userEvent.click(row!);
  await userEvent.click(screen.getByRole("button", { name: REMOVE }));
}

describe("removing an application whose lead comes back", () => {
  it("shows the lead on its search's board, without a reload", async () => {
    vi.spyOn(client, "deleteApplication").mockResolvedValue({ ok: true, lead: { ...LEAD, status: "Reviewing" } });

    await removeIt();

    await waitFor(() => expect(listed()).not.toContain(LEAD.company));

    // Reached the way a person reaches it, by clicking the tab - which is also
    // the thing that doesn't refetch, so what shows is what the patch left.
    await userEvent.click(screen.getByRole("tab", { name: /^Alpha roles/ }));

    // Reviewing, so it lands under Open, which is where someone goes looking.
    await waitFor(() => expect(listed()).toContain(LEAD.company));
  });

  it("leaves the leads alone where nothing was restored", async () => {
    // Null covers an application added by hand, and one whose lead was judged
    // something else after applying - the server leaves that status alone
    // rather than overruling a decision someone made.
    vi.spyOn(client, "deleteApplication").mockResolvedValue({ ok: true, lead: null });

    await removeIt();

    await waitFor(() => expect(listed()).not.toContain(LEAD.company));
    await userEvent.click(screen.getByRole("tab", { name: /^Alpha roles/ }));

    // Still Applied, so still off every leads tab: unchanged, not restored.
    expect(listed()).not.toContain(LEAD.company);
  });
});
