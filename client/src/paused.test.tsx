/**
 * A paused search on the page: its tab and leads stay, its run stamp says
 * Paused with the date, nothing about it reads as stale, and the Overview's
 * "reporting on schedule" line counts only the searches that still run.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import type { TrackerData } from "./api/schema";
import { NOW, data as fixture } from "./domain/fixture";
import { runState, trackWarn } from "./domain/runs";
import { clearPrefs } from "./ui/prefs";

// Beta's last run is eight days old and reported an error: left running, it
// would warn. Paused, none of that should show.
const PAUSED_AT = "2026-09-02T17:30:00.000Z";
const pausedBeta: TrackerData = {
  ...fixture,
  tracks: fixture.tracks.map((t) => (t.key === "beta" ? { ...t, paused: PAUSED_AT } : t)),
};

function renderAt(path: string, data: TrackerData) {
  vi.spyOn(client, "getData").mockResolvedValue(data);
  window.history.pushState({}, "", path);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
  return screen.findByRole("heading", { name: "Fixture Search" });
}

const tab = (label: string) => screen.getByRole("tab", { name: new RegExp(label) });

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

describe("runState", () => {
  it("reads a paused search as paused, whatever its last run says, and never warns about it", () => {
    const beta = fixture.tracks[1];
    const paused = { ...beta, paused: PAUSED_AT };
    expect(runState(beta, fixture.settings)).toBe("error");
    expect(runState(paused, fixture.settings)).toBe("paused");
    expect(trackWarn(paused, fixture.settings)).toBeNull();
  });
});

describe("a paused search's tab", () => {
  it("stays, with its leads, and shows Paused with the date in place of the last run", async () => {
    await renderAt("/t/beta", pausedBeta);
    expect(tab("Beta roles")).toBeInTheDocument();
    expect(document.querySelectorAll(".md-row").length).toBeGreaterThan(0);

    const stamp = document.querySelector(".runstamp")!;
    expect(stamp).toHaveClass("paused");
    expect(stamp).toHaveTextContent(/^Paused 2026-09-0[23]$/);
    expect(stamp.querySelector(".rdot")).toBeNull();
    expect(stamp).not.toHaveTextContent(/Ran|error/);
  });

  it("reads the pause the server resolved, so a tab the paused search fills says Paused too", async () => {
    // A fed tab never carries the switch itself: only `paused`, its root's.
    const fed: TrackerData = {
      ...pausedBeta,
      tracks: [
        ...pausedBeta.tracks,
        { ...fixture.tracks[1], key: "gamma", label: "Gamma roles", sort_order: 3, fed_by: "beta", paused: PAUSED_AT },
      ],
    };
    await renderAt("/t/gamma", fed);
    expect(document.querySelector(".runstamp")).toHaveClass("paused");
    expect(tab("Gamma roles").querySelector(".tabwarn")).toBeNull();
  });

  it("has no warning dot on its tab, where the same search running would", async () => {
    await renderAt("/", pausedBeta);
    expect(tab("Beta roles").querySelector(".tabwarn")).toBeNull();
  });
});

describe("the Overview's searches", () => {
  it("keeps the paused search's row, marked Paused", async () => {
    await renderAt("/", pausedBeta);
    const row = screen.getByRole("link", { name: "Beta roles" }).closest("tr")!;
    expect(within(row).getByText(/^Paused/)).toBeInTheDocument();
  });

  it("counts only running searches as reporting on schedule, and says how many are paused", async () => {
    const onlyGood: TrackerData = {
      ...pausedBeta,
      tracks: pausedBeta.tracks.map((t) => (t.key === "beta" ? t : { ...t, last_run: fixture.tracks[0].last_run })),
    };
    await renderAt("/", onlyGood);
    // Running, beta's errored run would make this "1 of 2 haven't reported".
    expect(screen.getByText("All 1 reporting on schedule · 1 paused")).toBeInTheDocument();
  });

  it("says so when every search is paused", async () => {
    await renderAt("/", { ...fixture, tracks: fixture.tracks.map((t) => ({ ...t, paused: PAUSED_AT })) });
    expect(screen.getByText("All 2 paused")).toBeInTheDocument();
  });
});
