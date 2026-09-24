/**
 * My account's sidebar: one section on screen at a time, and the marks that
 * keep an unsaved change in another section from going unseen.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import { NOW, data as fixture } from "./domain/fixture";
import { clearPrefs } from "./ui/prefs";

const reply = (over: Partial<Awaited<ReturnType<typeof client.saveSettings>>> = {}) => ({
  resumes: {},
  locations: {},
  settings: {},
  searches: {},
  ...over,
});

async function openPanel(data = fixture) {
  vi.spyOn(client, "getData").mockResolvedValue(data);
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

/** Opens Searches, then the one search whose questions should be on screen. */
async function openSearch(panel: HTMLElement, name: string) {
  // The sidebar's own name gains "Unsaved changes" once a search is edited.
  await userEvent.click(within(nav(panel)).getByRole("button", { name: /Searches/ }));
  const strip = within(panel).queryByRole("tablist", { name: "Your searches" });
  if (strip) await userEvent.click(within(strip).getByRole("tab", { name }));
  return screen.getByRole("group", { name });
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

describe("the account panel's sections", () => {
  it("opens on General, with one section on screen at a time", async () => {
    const panel = await openPanel();
    expect([...within(nav(panel)).getAllByRole("button")].map((b) => b.textContent)).toEqual([
      "General",
      "Locations",
      "Resumes",
      "Searches",
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

  it("saves the page's name, pronouns, ruled-out companies and a search's name in one request", async () => {
    const save = vi.spyOn(client, "saveSettings").mockResolvedValue(
      reply({
        settings: { display_title: "Brenna's 2026 Search", pronouns: "they/them", excluded_companies: ["Initech"] },
        searches: { alpha: { label: "Eng - Platform" }, beta: { label: "Beta roles" } },
      }),
    );
    const panel = await openPanel();
    await userEvent.clear(screen.getByLabelText(/What should this page be called/));
    await userEvent.type(screen.getByLabelText(/What should this page be called/), "Brenna's 2026 Search");
    await userEvent.click(within(panel).getByRole("button", { name: "they/them" }));
    await userEvent.type(screen.getByLabelText(/Companies you'd never work for/), "Initech{Enter}");

    const alpha = await openSearch(panel, "Alpha roles");
    await userEvent.clear(within(alpha).getByLabelText("What this search is called"));
    await userEvent.type(within(alpha).getByLabelText("What this search is called"), "Eng - Platform");
    expect(screen.getByText("4 unsaved changes across 2 sections")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      display_title: "Brenna's 2026 Search",
      pronouns: "they/them",
      excluded_companies: ["Initech"],
      searches: { alpha: { label: "Eng - Platform" } },
    });
    // The reply is what the page then shows, without waiting for a refetch:
    // the tracker's own tab behind the panel, not only the strip inside it.
    await waitFor(() =>
      expect(
        screen.getAllByRole("tab", { name: /Eng - Platform/ }).some((t) => !t.closest(".account-panel")),
      ).toBe(true),
    );
    expect(screen.getByRole("heading", { name: "Brenna's 2026 Search" })).toBeInTheDocument();
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it("won't save a page or search with no name, and says so beside it", async () => {
    const save = vi.spyOn(client, "saveSettings");
    const panel = await openPanel();
    await userEvent.clear(screen.getByLabelText(/What should this page be called/));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(within(panel).getByRole("alert")).toHaveTextContent("Give the page a name.");
    expect(save).not.toHaveBeenCalled();
  });

  it("shows a refused rename beside the search it names", async () => {
    vi.spyOn(client, "saveSettings").mockRejectedValue(
      Object.assign(new Error("a search's name can be at most 60 characters"), {
        status: 400,
        field: "label",
        search: "beta",
      }),
    );
    const panel = await openPanel();
    const beta = await openSearch(panel, "Beta roles");
    const name = within(beta).getByLabelText("What this search is called");
    await userEvent.type(name, " and more");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("a search's name can be at most 60 characters");
    expect(alert.closest(".loc-field")).toContainElement(name);
    expect(name).toHaveValue("Beta roles and more");
  });

  it("saves what a search looks for, counting each field it changed", async () => {
    const save = vi.spyOn(client, "saveSettings").mockResolvedValue(
      reply({
        searches: {
          alpha: {
            label: "Alpha roles",
            role_search_line: "Staff platform engineer roles",
            fit_clause: "which names alpha work in the posting itself",
            fit_disqualifier: "the role is contract-only",
          },
        },
      }),
    );
    const panel = await openPanel();
    const alpha = await openSearch(panel, "Alpha roles");
    const roles = within(alpha).getByLabelText("What roles should this search look for?");
    await userEvent.clear(roles);
    await userEvent.type(roles, "Staff platform engineer roles");

    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith({ searches: { alpha: { role_search_line: "Staff platform engineer roles" } } });
    await waitFor(() => expect(screen.queryByText(/unsaved change/)).toBeNull());
    expect(within(screen.getByRole("group", { name: "Alpha roles" })).getByLabelText("What roles should this search look for?")).toHaveValue(
      "Staff platform engineer roles",
    );
  });

  it("asks what a search looks for only of searches that run, not of the tabs they fill", async () => {
    const fed = {
      ...fixture,
      tracks: [fixture.tracks[0], { ...fixture.tracks[1], fed_by: "alpha" }],
    };
    const panel = await openPanel(fed);
    const alpha = await openSearch(panel, "Alpha roles");
    expect(within(alpha).getByLabelText("What roles should this search look for?")).toBeInTheDocument();

    // The fed tab keeps its own name and nothing else.
    const beta = await openSearch(panel, "Beta roles");
    expect(within(beta).getByLabelText("What this search is called")).toBeInTheDocument();
    expect(within(beta).queryByLabelText("What roles should this search look for?")).toBeNull();
    expect(within(beta).getByText(/Alpha roles search fills this tab, so what it looks for is set there/)).toBeInTheDocument();
  });

  it("saves a pay floor as typed, and reads no number out of it", async () => {
    const save = vi.spyOn(client, "saveSettings").mockResolvedValue(
      reply({ searches: { beta: { label: "Beta roles", pay_floor: "95/hr, flexible", pay_floor_unit: "hour" } } }),
    );
    const panel = await openPanel();
    const beta = await openSearch(panel, "Beta roles");
    await userEvent.type(within(beta).getByLabelText("Lowest acceptable pay"), "95/hr, flexible");
    await userEvent.selectOptions(within(beta).getByLabelText("Is that a year or an hour?"), "hour");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    // As typed: the comma, the slash and the word all survive the round trip.
    expect(save).toHaveBeenCalledWith({ searches: { beta: { pay_floor: "95/hr, flexible", pay_floor_unit: "hour" } } });
    await waitFor(() => expect(screen.queryByText(/unsaved change/)).toBeNull());
    expect(within(screen.getByRole("group", { name: "Beta roles" })).getByLabelText("Lowest acceptable pay")).toHaveValue(
      "95/hr, flexible",
    );
  });

  it("stores a year with an amount typed against the unit it shows, which no one had to choose", async () => {
    const save = vi.spyOn(client, "saveSettings").mockResolvedValue(reply());
    const panel = await openPanel();
    const beta = await openSearch(panel, "Beta roles");
    // Beta has no floor at all, so the unit shows the one almost every salary is.
    expect(within(beta).getByLabelText("Is that a year or an hour?")).toHaveValue("year");
    await userEvent.type(within(beta).getByLabelText("Lowest acceptable pay"), "$180k base");
    // One answer, however many fields it takes to store.
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith({ searches: { beta: { pay_floor: "$180k base", pay_floor_unit: "year" } } });
  });

  it("takes the unit away with the amount, since a unit alone says nothing", async () => {
    const save = vi.spyOn(client, "saveSettings").mockResolvedValue(
      reply({ searches: { alpha: { label: "Alpha roles", pay_floor: "", pay_floor_unit: "" } } }),
    );
    const panel = await openPanel();
    const alpha = await openSearch(panel, "Alpha roles");
    await userEvent.clear(within(alpha).getByLabelText("Lowest acceptable pay"));

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith({ searches: { alpha: { pay_floor: "", pay_floor_unit: "" } } });
  });

  it("pauses a search from the panel, and shows it paused once the save lands", async () => {
    const save = vi.spyOn(client, "saveSettings").mockResolvedValue(
      reply({ searches: { alpha: { label: "Alpha roles", paused: "2026-09-10T12:00:00.000Z" }, beta: { label: "Beta roles", paused: "" } } }),
    );
    const panel = await openPanel();
    const alpha = await openSearch(panel, "Alpha roles");
    expect(within(alpha).getByText("Running")).toBeInTheDocument();

    // Pausing asks first, naming what stops and saying the leads stay.
    await userEvent.click(within(alpha).getByRole("button", { name: "Pause this search" }));
    const ask = screen.getByRole("alertdialog", { name: "Pause Alpha roles?" });
    expect(ask).toHaveTextContent(/nothing new found or screened/);
    expect(ask).toHaveTextContent(/stays in its tab/);
    await userEvent.click(within(ask).getByRole("button", { name: "Pause it" }));

    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
    // Nothing is sent until Save, and no time is ever sent: the server stamps it.
    expect(save).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith({ searches: { alpha: { paused: true } } });
    await waitFor(() => expect(screen.queryByText(/unsaved change/)).toBeNull());
    // The tab behind the panel takes the reply too, so its stamp says Paused.
    const stamp = [...document.querySelectorAll(".runstamp")].find((s) => !s.closest(".account-panel"));
    expect(stamp).toHaveTextContent(/^Paused/);
    expect(within(screen.getByRole("group", { name: "Alpha roles" })).getByText(/^Paused since/)).toBeInTheDocument();
  });

  it("names a pause on the way out, where 'what a search looks for' wouldn't say what is being lost", async () => {
    const panel = await openPanel();
    const alpha = await openSearch(panel, "Alpha roles");
    await userEvent.click(within(alpha).getByRole("button", { name: "Pause this search" }));
    await userEvent.click(screen.getByRole("button", { name: "Pause it" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Close" }));

    const ask = screen.getByRole("alertdialog", { name: "Leave without saving?" });
    expect(ask).toHaveTextContent("You changed whether a search runs but didn't save, so they stay as they are.");
  });

  it("offers a paused search a way back, and sends no time to resume it", async () => {
    const save = vi.spyOn(client, "saveSettings").mockResolvedValue(reply());
    const paused = { ...fixture, tracks: fixture.tracks.map((t) => (t.key === "alpha" ? { ...t, paused: "2026-09-02T17:30:00.000Z" } : t)) };
    const panel = await openPanel(paused);
    const alpha = await openSearch(panel, "Alpha roles");
    expect(within(alpha).getByText(/^Paused since/)).toBeInTheDocument();
    expect(within(alpha).getByText("2026-09-02")).toBeInTheDocument();

    // Only a pause asks: letting a search run again costs nothing.
    await userEvent.click(within(alpha).getByRole("button", { name: "Let it run again" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(within(alpha).getByText("Running")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith({ searches: { alpha: { paused: false } } });
  });

  it("gives a tab another search fills no switch of its own, since it pauses with that search", async () => {
    const fed = {
      ...fixture,
      tracks: [
        { ...fixture.tracks[0], paused: "2026-09-02T17:30:00.000Z" },
        { ...fixture.tracks[1], fed_by: "alpha", paused: "2026-09-02T17:30:00.000Z" },
      ],
    };
    const panel = await openPanel(fed);
    const beta = await openSearch(panel, "Beta roles");
    expect(within(beta).getByText(/^Paused since/)).toBeInTheDocument();
    expect(within(beta).queryByRole("button", { name: /Pause|run again/ })).toBeNull();
    expect(within(beta).getByText(/runs and pauses with that search/)).toBeInTheDocument();
  });

  it("shows one search at a time, and marks one holding an unsaved edit", async () => {
    const panel = await openPanel();
    const alpha = await openSearch(panel, "Alpha roles");
    expect(screen.queryByRole("group", { name: "Beta roles" })).toBeNull();

    await userEvent.type(within(alpha).getByLabelText("What roles should this search look for?"), " and more");
    const strip = within(panel).getByRole("tablist", { name: "Your searches" });
    expect(within(within(strip).getByRole("tab", { name: /Alpha roles/ })).getByRole("img", { name: "Unsaved changes" })).toBeInTheDocument();

    // Reading another search keeps the edit and its mark.
    await userEvent.click(within(strip).getByRole("tab", { name: /Beta roles/ }));
    expect(screen.getByRole("group", { name: "Beta roles" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Alpha roles" })).toBeNull();
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
  });

  it("brings up the search a refusal names, whichever one is on screen", async () => {
    vi.spyOn(client, "saveSettings").mockRejectedValue(
      Object.assign(new Error("beta's roles line is longer than 300 characters"), {
        status: 400,
        field: "role_search_line",
        search: "beta",
      }),
    );
    const panel = await openPanel();
    const beta = await openSearch(panel, "Beta roles");
    await userEvent.type(within(beta).getByLabelText("What roles should this search look for?"), "Beta engineer roles");
    await openSearch(panel, "Alpha roles");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const shown = await screen.findByRole("group", { name: "Beta roles" });
    expect(within(shown).getByRole("alert")).toHaveTextContent("longer than 300 characters");
  });

  it("takes what a person writes as written, and refuses only an emptied roles line", async () => {
    const save = vi.spyOn(client, "saveSettings");
    const panel = await openPanel();
    const alpha = await openSearch(panel, "Alpha roles");

    // Nothing reads what was typed to judge it.
    await userEvent.type(within(alpha).getByLabelText("What makes a posting worth keeping?"), "prefer a strong design culture");
    expect(within(alpha).queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

    // The one field the route refuses empty is refused here first.
    await userEvent.clear(within(alpha).getByLabelText("What roles should this search look for?"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(within(alpha).getByRole("alert")).toHaveTextContent("Say what roles this search looks for");
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps the password out of the one Save, since it needs the current one", async () => {
    const panel = await openPanel();
    await userEvent.click(within(panel).getByRole("button", { name: "Change password" }));
    expect(within(panel).getByLabelText("Current password")).toBeInTheDocument();
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });
});
