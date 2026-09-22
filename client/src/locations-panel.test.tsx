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
  // The panel opens on General; each section is chosen from its sidebar.
  await userEvent.click(within(panel).getByRole("button", { name: "Locations" }));
  return within(panel).getByRole("region", { name: "Locations" });
}

/** The box that adds a place to the ranked list. */
const ranked = () => screen.getByLabelText(/What locations should the search prioritize/);
/** Every chip of one list, in order, as a person reads them. */
const chipsOf = (field: HTMLElement) =>
  [...field.querySelectorAll(".place-chip-text")].map((c) => c.textContent);
const fieldOf = (section: HTMLElement, label: RegExp) =>
  within(section).getByLabelText(label).closest(".loc-field") as HTMLElement;
/** The Locations section as it stands now: switching sections replaces the node. */
const locations = () => screen.getByRole("region", { name: "Locations" });
/** Opens Locations again after another section has been on screen. */
async function backToLocations() {
  await userEvent.click(screen.getByRole("button", { name: "Locations" }));
  return locations();
}
/** Changes the resume one section over, which the panel's one Save carries too. */
async function pickResume() {
  await userEvent.click(screen.getByRole("button", { name: "Resumes" }));
  await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Resume for Eng - AI" }), AI);
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

describe("the Locations section", () => {
  it("asks where to search, then what comes first, then what's ruled out, then the note", async () => {
    const section = await openPanel();
    const labels = [...section.querySelectorAll(".loc-field label")].map((l) => l.textContent);
    expect(labels).toEqual([
      "What locations should be searched?",
      "What locations should the search prioritize?",
      "Anywhere you can't take a job?",
      "Anything else about where you'd work?",
    ]);
  });

  it("shows each list as stored, one chip per place", async () => {
    const section = await openPanel({ excluded_locations: "Ogdenville" });
    expect(chipsOf(fieldOf(section, /What locations should be searched/))).toEqual([
      "Springfield",
      "Shelbyville",
      "Remote US",
    ]);
    expect(chipsOf(fieldOf(section, /What locations should the search prioritize/))).toEqual(["Metro core", "Wider region"]);
    expect(chipsOf(fieldOf(section, /Anywhere you can't take a job/))).toEqual(["Ogdenville"]);
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it("reads an empty searched list as only the ranked places, not anywhere", async () => {
    const section = await openPanel({ search_locations: "" });
    expect(within(section).getByText("Only the ranked places")).toBeInTheDocument();
  });

  it("adds a place on Enter, and drops one with its ×", async () => {
    const section = await openPanel();
    const field = fieldOf(section, /What locations should the search prioritize/);

    await userEvent.type(ranked(), "Ogdenville{Enter}");
    expect(chipsOf(field)).toEqual(["Metro core", "Wider region", "Ogdenville"]);
    expect(ranked()).toHaveValue("");
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();

    await userEvent.click(within(field).getByRole("button", { name: "Remove Wider region" }));
    expect(chipsOf(field)).toEqual(["Metro core", "Ogdenville"]);
  });

  it("moves a ranked place with its arrows, which is what its tier follows", async () => {
    const section = await openPanel();
    const field = fieldOf(section, /What locations should the search prioritize/);
    await userEvent.click(within(field).getByRole("button", { name: "Move Wider region up" }));
    expect(chipsOf(field)).toEqual(["Wider region", "Metro core"]);
    expect(within(field).getByRole("button", { name: "Move Wider region up" })).toBeDisabled();
  });

  it("takes a pasted comma list as one place each, and flags nothing", async () => {
    const section = await openPanel();
    const field = fieldOf(section, /What locations should the search prioritize/);
    await userEvent.type(field.querySelector("input") as HTMLInputElement, "WA, Portland, OR{Enter}");
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(chipsOf(field)).toEqual(["Metro core", "Wider region", "WA", "Portland", "OR"]);
  });

  it("won't save both lists empty, and says so beside the searched list without sending", async () => {
    const save = vi.spyOn(client, "saveSettings");
    const section = await openPanel({ search_locations: "" });
    const field = fieldOf(section, /What locations should the search prioritize/);
    for (const place of ["Metro core", "Wider region"]) {
      await userEvent.click(within(field).getByRole("button", { name: `Remove ${place}` }));
    }
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = within(section).getByRole("alert");
    expect(alert).toHaveTextContent("Say what locations should be searched, or rank some places first");
    expect(alert.closest(".loc-field")).toContainElement(within(section).getByLabelText(/What locations should be searched/));
    expect(save).not.toHaveBeenCalled();
  });
});

describe("one Save and Discard for the whole panel", () => {
  it("counts a resume choice and a changed list together, and saves both in one request", async () => {
    const save = vi.spyOn(client, "saveSettings").mockResolvedValue({
      resumes: {},
      locations: { priority_locations: "Wider region, Metro core" },
      settings: {},
      searches: {},
    });
    const section = await openPanel();
    const field = fieldOf(section, /What locations should the search prioritize/);
    await userEvent.click(within(field).getByRole("button", { name: "Move Wider region up" }));
    await pickResume();

    expect(screen.getByText("2 unsaved changes across 2 sections")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ resumes: { ai: AI }, priority_locations: "Wider region, Metro core" });
    expect(screen.queryByText(/unsaved change/)).toBeNull();

    const saved = await backToLocations();
    expect(within(saved).getByText("Saved. Your next run uses these places.")).toBeInTheDocument();
    expect(chipsOf(fieldOf(saved, /What locations should the search prioritize/))).toEqual(["Wider region", "Metro core"]);
  });

  it("doesn't count a place typed but never added, since it wouldn't be saved either", async () => {
    await openPanel();
    await userEvent.type(ranked(), "  ");
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it("shows a refusal beside the list it names, and keeps the edit", async () => {
    vi.spyOn(client, "saveSettings").mockRejectedValue(
      Object.assign(new Error("priority_locations can list at most 50 places"), { status: 400, field: "priority_locations" }),
    );
    const section = await openPanel();
    const field = fieldOf(section, /What locations should the search prioritize/);
    await userEvent.type(ranked(), "Ogdenville{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await within(section).findByRole("alert")).toHaveTextContent("priority_locations can list at most 50 places");
    expect(chipsOf(field)).toEqual(["Metro core", "Wider region", "Ogdenville"]);
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
  });

  it("Discard puts every section back, the one on screen and the one that isn't", async () => {
    await openPanel();
    await userEvent.type(ranked(), "Ogdenville{Enter}");
    await pickResume();
    expect(screen.getByRole("button", { name: /Locations/ })).toContainElement(
      screen.getAllByRole("img", { name: "Unsaved changes" })[0],
    );

    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("combobox", { name: "Resume for Eng - AI" })).toHaveValue(ENG);
    const back = await backToLocations();
    expect(chipsOf(fieldOf(back, /What locations should the search prioritize/))).toEqual(["Metro core", "Wider region"]);
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it("asks before closing on a changed list, saying what would be lost", async () => {
    await openPanel();
    await userEvent.type(ranked(), "Ogdenville{Enter}");
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
