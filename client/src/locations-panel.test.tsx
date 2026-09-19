/**
 * The account panel's Locations section, and the one Save and Discard it
 * shares with the resume section, against the settings route as the server
 * answers it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import type { Settings, StoredResume, TrackerData } from "./api/schema";
import { NOW, data as fixture } from "./domain/fixture";
import { changedPlaces, listEntries, unsavedPlacesSentence } from "./domain/places";
import { clearPrefs } from "./ui/prefs";

const ENG = "resumes/Engineering.pdf";
const AI = "resumes/AI_Roles.pdf";

const doc = (path: string, used_by: StoredResume["used_by"] = []): StoredResume => ({
  path,
  bytes: 1000,
  uploaded: "2026-08-28T17:00:00.000Z",
  readable: true,
  words: null,
  used_by,
});

async function openPanel(settings: Partial<Settings> = {}) {
  const data: TrackerData = {
    ...fixture,
    settings: { ...fixture.settings, ...settings },
    tracks: [{ ...fixture.tracks[0], key: "ai", label: "Eng - AI" }],
  };
  vi.spyOn(client, "getData").mockResolvedValue(data);
  vi.spyOn(client, "listDocuments").mockResolvedValue([doc(ENG, [{ search: "ai", tabs: ["ai"], state: "reads" }]), doc(AI)]);
  window.history.pushState({}, "", "/");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "Fixture Search" });
  await userEvent.click(screen.getByRole("button", { name: "My account" }));
  const panel = screen.getByRole("dialog", { name: "My account" });
  await within(panel).findByText("Engineering.pdf", { selector: ".resume-name" });
  return within(panel).getByRole("region", { name: "Locations" });
}

const ranked = () => screen.getByLabelText(/Which locations should come first/);

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

describe("the Locations section", () => {
  it("asks where to search, then what comes first, then what's ruled out, then the note", async () => {
    const section = await openPanel();
    const labels = [...section.querySelectorAll(".loc-field > label")].map((l) => l.firstChild?.textContent);
    expect(labels).toEqual([
      "What locations should be searched?",
      "Which locations should come first?",
      "Anywhere you can't take a job?",
      "Anything else about where you'd work?",
    ]);
  });

  it("shows each list as stored, and how the commas split it", async () => {
    const section = await openPanel({ excluded_locations: "Ogdenville" });
    expect(within(section).getByLabelText(/What locations should be searched/)).toHaveValue("Springfield, Shelbyville, Remote US");
    expect(within(section).getByText("Searched:").parentElement).toHaveTextContent("Searched:SpringfieldShelbyvilleRemote US");
    expect(within(section).getByText("Ruled out:").parentElement).toHaveTextContent("Ruled out:Ogdenville");
    expect(within(section).getByText("1. Metro core")).toBeInTheDocument();
    expect(within(section).getByText("2. Wider region")).toBeInTheDocument();
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it("reads an empty searched list as only the ranked places, not anywhere", async () => {
    const section = await openPanel({ search_locations: "" });
    expect(within(section).getByText("Searched:").parentElement).toHaveTextContent("Searched:Only the ranked places");
  });

  it("won't save both lists empty, and says so beside the searched list without sending", async () => {
    const save = vi.spyOn(client, "saveSettings");
    const section = await openPanel({ search_locations: "" });
    await userEvent.clear(ranked());
    expect(within(section).queryByText("Searched:")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = within(section).getByRole("alert");
    expect(alert).toHaveTextContent("Say what locations should be searched, or rank some places first");
    expect(alert.closest(".loc-field")).toContainElement(within(section).getByLabelText(/What locations should be searched/));
    expect(save).not.toHaveBeenCalled();
  });

  it("flags nothing a person types", async () => {
    const section = await openPanel();
    await userEvent.clear(ranked());
    await userEvent.type(ranked(), "WA, Portland, Portland, OR");
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(within(section).getByText("4. OR")).toBeInTheDocument();
  });
});

describe("one Save and Discard for the whole panel", () => {
  it("counts a resume choice and a changed list together, and saves both in one request", async () => {
    const save = vi.spyOn(client, "saveSettings").mockResolvedValue({
      resumes: {},
      locations: { priority_locations: "Wider region, Metro core" },
    });
    const section = await openPanel();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Resume for Eng - AI" }), AI);
    await userEvent.clear(ranked());
    await userEvent.type(ranked(), "Wider region, Metro core");

    expect(within(section).getByText(/Changed/)).toBeInTheDocument();
    expect(screen.getByText("2 unsaved changes")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ resumes: { ai: AI }, priority_locations: "Wider region, Metro core" });
    expect(await within(section).findByText("Saved. Your next run uses these places.")).toBeInTheDocument();
    expect(ranked()).toHaveValue("Wider region, Metro core");
    expect(within(section).getByText("1. Wider region")).toBeInTheDocument();
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it("doesn't count an edit that only adds spaces at the ends, since it saves the same", async () => {
    await openPanel();
    await userEvent.type(ranked(), "  ");
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it("shows a refusal beside the list it names, and keeps the edit", async () => {
    vi.spyOn(client, "saveSettings").mockRejectedValue(
      Object.assign(new Error("priority_locations can list at most 50 places"), { status: 400, field: "priority_locations" }),
    );
    const section = await openPanel();
    await userEvent.type(ranked(), ", Ogdenville");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await within(section).findByRole("alert")).toHaveTextContent("priority_locations can list at most 50 places");
    expect(ranked()).toHaveValue("Metro core, Wider region, Ogdenville");
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
  });

  it("Discard puts every section back", async () => {
    await openPanel();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Resume for Eng - AI" }), AI);
    await userEvent.type(ranked(), ", Ogdenville");
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(ranked()).toHaveValue("Metro core, Wider region");
    expect(screen.getByRole("combobox", { name: "Resume for Eng - AI" })).toHaveValue(ENG);
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it("asks before closing on a changed list, saying what would be lost", async () => {
    await openPanel();
    await userEvent.type(ranked(), ", Ogdenville");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    const ask = screen.getByRole("alertdialog", { name: "Leave without saving?" });
    expect(ask).toHaveTextContent("You changed the places ranked first but didn't save, so your searches keep the ones they use now.");
  });
});

describe("place settings", () => {
  it("split a list on commas, trimmed, dropping empty entries", () => {
    expect(listEntries(" Seattle area ,, Portland, OR ,")).toEqual(["Seattle area", "Portland", "OR"]);
  });

  it("count as changed only when they'd store differently", () => {
    const stored = { search_locations: "US", excluded_locations: "", priority_locations: "Seattle", location_note: "" };
    expect(changedPlaces(stored, { search_locations: " US ", priority_locations: "Seattle, Remote US" })).toEqual({
      priority_locations: "Seattle, Remote US",
    });
  });

  it("name every changed setting when leaving would lose them", () => {
    expect(unsavedPlacesSentence({ search_locations: "US", location_note: "x" })).toBe(
      "You changed the places searched and your note about where you'd work but didn't save, so your searches keep the ones they use now.",
    );
    expect(unsavedPlacesSentence({})).toBe("");
  });
});
