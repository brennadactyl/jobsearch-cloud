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

    await userEvent.click(within(nav(panel)).getByRole("button", { name: "Searches" }));
    const alpha = screen.getByRole("group", { name: "Alpha roles" });
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
    // The reply is what the page then shows, without waiting for a refetch.
    expect(await screen.findByRole("tab", { name: /Eng - Platform/ })).toBeInTheDocument();
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
    await userEvent.click(within(nav(panel)).getByRole("button", { name: "Searches" }));
    const beta = screen.getByRole("group", { name: "Beta roles" });
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
    await userEvent.click(within(nav(panel)).getByRole("button", { name: "Searches" }));
    const alpha = screen.getByRole("group", { name: "Alpha roles" });
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

  it("takes what a person writes as written, and refuses only an emptied roles line", async () => {
    const save = vi.spyOn(client, "saveSettings");
    const panel = await openPanel();
    await userEvent.click(within(nav(panel)).getByRole("button", { name: "Searches" }));
    const alpha = screen.getByRole("group", { name: "Alpha roles" });

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
