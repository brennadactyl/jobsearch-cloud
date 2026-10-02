/**
 * The Applications tab's status chips: which rows each one shows, what the tab
 * opens on, and that the chip rides in the URL so a view can be linked to.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import type { TrackerData } from "./api/schema";
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

const chips = () => document.querySelector(".key .chips") as HTMLElement;
const chip = (name: string) => within(chips()).getByRole("button", { name });
const listed = () => [...document.querySelectorAll(".md-row .co")].map((e) => e.textContent);
const statusOf = (company: string) => fixture.applications.find((a) => a.company === company)!.status;

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

describe("the Applications tab's chips", () => {
  it("offer Live, the three stages and All, in the order a row travels", async () => {
    await renderAt("/applications");
    expect([...chips().querySelectorAll(".chip")].map((c) => c.textContent)).toEqual([
      "Live", "Applied", "In conversation", "Rejected", "All",
    ]);
  });

  it("open on Live, which leaves out what is over", async () => {
    await renderAt("/applications");

    expect(chip("Live")).toHaveAttribute("aria-pressed", "true");
    // Rho was rejected and Sig withdrawn; Ida is still to apply to.
    expect(listed()).not.toContain("Rho");
    expect(listed()).not.toContain("Sig");
    expect(listed()).toContain("Ida");
  });

  it("show one stage's rows when that chip is pressed", async () => {
    await renderAt("/applications");

    await userEvent.click(chip("Rejected"));

    await waitFor(() => expect(listed()).toEqual(["Rho"]));
    expect(statusOf("Rho")).toBe("Rejected");
  });

  it("gather the screen, loop and offer stages under one chip", async () => {
    await renderAt("/applications");

    await userEvent.click(chip("In conversation"));

    // Nix, Opt, Pyx and Qed are the recruiter screen, tech screen, onsite and
    // offer rows; an offer ends a conversation rather than being another kind.
    await waitFor(() => expect(listed().sort()).toEqual(["Nix", "Opt", "Pyx", "Qed"]));
  });

  it("carry the chip in the URL, so a view can be linked to", async () => {
    await renderAt("/applications");

    await userEvent.click(chip("All"));

    await waitFor(() => expect(window.location.search).toBe("?filter=All"));
    expect(listed()).toContain("Sig");

    // The default stays out of the URL: the tab's own link and Live are one address.
    await userEvent.click(chip("Live"));
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("open on what an Overview figure counted, not on Live, when one sent you", async () => {
    // The Applied tile counts every application sent, rejections included, so
    // the link it opens says All - otherwise the number and the list disagree.
    await renderAt("/applications?filter=All&drill=applied");

    expect(chip("All")).toHaveAttribute("aria-pressed", "true");
    expect(listed()).toContain("Rho");
  });

  it("keep the chip when the view is a grid", async () => {
    setPrefs({ view: "grid" });
    await renderAt("/applications");

    await userEvent.click(chip("Rejected"));

    // The grid draws company as an editable field rather than a label.
    await waitFor(() =>
      expect(
        [...document.querySelectorAll<HTMLInputElement>('tr[data-expand] input[aria-label="Company"]')].map((i) => i.value),
      ).toEqual(["Rho"]),
    );
  });
});
