/**
 * My account's sidebar: one section on screen at a time, and the marks that
 * keep an unsaved change in another section from going unseen.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import { NOW, data as fixture } from "./domain/fixture";
import { clearPrefs } from "./ui/prefs";

async function openPanel() {
  vi.spyOn(client, "getData").mockResolvedValue(fixture);
  vi.spyOn(client, "listDocuments").mockResolvedValue([]);
  window.history.pushState({}, "", "/");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "Fixture Search" });
  await userEvent.click(screen.getByRole("button", { name: "My account" }));
  return screen.getByRole("dialog", { name: "My account" });
}

const nav = (panel: HTMLElement) => within(panel).getByRole("navigation", { name: "Account sections" });

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

describe("the account panel's sections", () => {
  it("opens on General, with one section on screen at a time", async () => {
    const panel = await openPanel();
    expect([...within(nav(panel)).getAllByRole("button")].map((b) => b.textContent)).toEqual([
      "General",
      "Locations",
      "Resumes",
    ]);
    expect(within(panel).getByRole("heading", { name: "Password" })).toBeInTheDocument();
    expect(within(panel).queryByRole("region", { name: "Locations" })).toBeNull();

    await userEvent.click(within(nav(panel)).getByRole("button", { name: "Locations" }));
    expect(within(panel).getByRole("region", { name: "Locations" })).toBeInTheDocument();
    expect(within(panel).queryByRole("heading", { name: "Password" })).toBeNull();
  });

  it("says which section a change is in, so an edit off screen isn't lost sight of", async () => {
    const panel = await openPanel();
    await userEvent.click(within(nav(panel)).getByRole("button", { name: "Locations" }));
    await userEvent.type(screen.getByLabelText(/Anywhere you can't take a job/), "Ogdenville{Enter}");

    const locations = within(nav(panel)).getByRole("button", { name: /Locations/ });
    expect(within(locations).getByRole("img", { name: "Unsaved changes" })).toBeInTheDocument();
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();

    // Reading another section changes nothing about the edit or its mark.
    await userEvent.click(within(nav(panel)).getByRole("button", { name: "General" }));
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
    expect(within(within(nav(panel)).getByRole("button", { name: /Locations/ })).getByRole("img")).toBeInTheDocument();
  });

  it("keeps the password out of the one Save, since it needs the current one", async () => {
    const panel = await openPanel();
    await userEvent.click(within(panel).getByRole("button", { name: "Change password" }));
    expect(within(panel).getByLabelText("Current password")).toBeInTheDocument();
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });
});
