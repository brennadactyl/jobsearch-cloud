/**
 * The gate, the shell and the drill-downs, queried the way a person reaches
 * them.
 *
 * Everything is found by role and accessible name rather than by class or test
 * id, which is what makes "every interactive element is a real control" an
 * assertion rather than a convention: a div with a click handler has no role to
 * find, so these fail if one appears.
 *
 * The last group is the one that matters most. It walks the actual invariant
 * end to end - read the number off a tile, click it, count the rows that
 * arrive - which is the only version of that check a unit test on the domain
 * layer cannot make, because it crosses the component/route boundary the two
 * halves used to disagree across.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import { NOW, data as fixture } from "./domain/fixture";
import { clearPrefs } from "./ui/prefs";

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  clearPrefs();
  window.history.pushState({}, "", "/");
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function signedIn() {
  localStorage.setItem("tracker_token", "a-token");
  vi.spyOn(client, "getData").mockResolvedValue(fixture);
}

describe("the gate", () => {
  it("asks for a name and a password", () => {
    renderApp();
    expect(screen.getByRole("textbox", { name: /name/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("refuses an empty submit without calling the server", async () => {
    const login = vi.spyOn(client, "login");
    renderApp();
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/enter your name and password/i);
    expect(login).not.toHaveBeenCalled();
  });

  it("says the same thing for a wrong name as for a wrong password", async () => {
    vi.spyOn(client, "login").mockRejectedValue(new client.UnauthorizedError());
    renderApp();
    await userEvent.type(screen.getByRole("textbox", { name: /name/i }), "Ada");
    await userEvent.type(screen.getByLabelText(/password/i), "wrong");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/don't match/i);
  });
});

describe("the shell", () => {
  beforeEach(signedIn);

  it("takes the title and every tab label from config", async () => {
    // The same deployed client serves every account, so nothing may be
    // hardcoded here. Renaming a tab in config renames it on the page.
    renderApp();
    expect(await screen.findByRole("heading", { name: "Fixture Search" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs[0]).toMatch(/^Overview/);
    expect(tabs[1]).toMatch(/^Applications/);
    expect(tabs[2]).toMatch(/^All leads/);
    expect(tabs[3]).toMatch(/^Alpha roles/);
    expect(tabs[4]).toMatch(/^Beta roles/);
  });

  it("marks the track whose search reported an error, and leaves the healthy one alone", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "Fixture Search" });
    const beta = screen.getAllByRole("tab").find((t) => t.textContent?.startsWith("Beta roles"))!;
    const alpha = screen.getAllByRole("tab").find((t) => t.textContent?.startsWith("Alpha roles"))!;
    expect(beta.querySelector(".tabwarn.error")).toBeTruthy();
    expect(alpha.querySelector(".tabwarn")).toBeFalsy();
  });

  it("marks the Applications tab when a posting could not be read", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "Fixture Search" });
    const apps = screen.getAllByRole("tab").find((t) => t.textContent?.startsWith("Applications"))!;
    expect(apps.querySelector(".tabwarn.fill")).toBeTruthy();
  });

  it("offers a real button to log out", async () => {
    renderApp();
    expect(await screen.findByRole("button", { name: /log out/i })).toBeInTheDocument();
  });

  it("shows the gate again when the token has been revoked elsewhere", async () => {
    vi.spyOn(client, "getData").mockRejectedValue(new client.UnauthorizedError());
    renderApp();
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });
});

describe("routing", () => {
  beforeEach(signedIn);

  it("gives every tab its own URL", async () => {
    renderApp();
    await userEvent.click(await screen.findByRole("tab", { name: /^Applications/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/applications"));
    await userEvent.click(screen.getByRole("tab", { name: /^Alpha roles/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/t/alpha"));
  });

  it("falls back to the Overview for a track config no longer has", async () => {
    // A bookmark, or a track removed since. Rendering an empty panel for a key
    // that does not exist is the failure this avoids.
    window.history.pushState({}, "", "/t/deleted-track");
    renderApp();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(await screen.findByRole("heading", { name: "Fixture Search" })).toBeInTheDocument();
  });
});

describe("drill-downs: the number and the rows it opens", () => {
  beforeEach(signedIn);

  /** Reads a tile's figure straight off the rendered page. */
  function tileValue(name: RegExp): number {
    const tile = screen.getAllByRole("link").find((el) => name.test(el.textContent ?? ""));
    if (!tile) throw new Error(`no enabled tile matching ${name}`);
    return Number(tile.querySelector(".v")?.textContent);
  }

  it.each([
    [/Gone quiet/, "Applied 14+ days ago"],
    [/In conversation/, "In screen or loop stage"],
  ])("%s opens exactly the rows it counted", async (tileName, chipText) => {
    renderApp();
    await screen.findByRole("heading", { name: "Fixture Search" });

    const counted = tileValue(tileName);
    expect(counted).toBeGreaterThan(0);

    await userEvent.click(screen.getAllByRole("link").find((el) => tileName.test(el.textContent ?? ""))!);

    // The chip has to say what is being filtered - an applied filter you cannot
    // see is a page lying about what it is showing. Matched as text rather than
    // through new RegExp(chipText): these labels contain regex metacharacters
    // ("14+"), and interpolating them changes what is being asserted.
    const chip = await screen.findByRole("link", { name: /^Clear filter/i });
    expect(chip).toHaveTextContent(chipText);

    const list = document.querySelector(".md-list")!;
    expect(within(list as HTMLElement).getAllByRole("button")).toHaveLength(counted);
  });

  it("carries the drill in the URL, so a filtered view can be linked to", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "Fixture Search" });
    await userEvent.click(screen.getAllByRole("link").find((el) => /Gone quiet/.test(el.textContent ?? ""))!);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/applications");
      expect(window.location.search).toBe("?drill=gone-quiet");
    });
  });

  it("lands a filtered leads tile on a status chip rather than a drill", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "Fixture Search" });
    const counted = tileValue(/Untriaged/);
    await userEvent.click(screen.getAllByRole("link").find((el) => /Untriaged/.test(el.textContent ?? ""))!);
    await waitFor(() => expect(window.location.search).toBe("?filter=New"));
    const list = document.querySelector(".md-list")!;
    expect(within(list as HTMLElement).getAllByRole("button")).toHaveLength(counted);
  });

  it("disables a tile with nothing to open, rather than linking to an empty list", async () => {
    vi.spyOn(client, "getData").mockResolvedValue({ ...fixture, leads: [], applications: [] });
    renderApp();
    await screen.findByRole("heading", { name: "Fixture Search" });
    const dead = screen.getAllByRole("button", { name: /Untriaged/ });
    expect(dead[0]).toBeDisabled();
    expect(dead[0]).toHaveAttribute("title", "Nothing to open yet");
  });
});

describe("the applications grid", () => {
  beforeEach(signedIn);

  it("groups rows by fill state, and the group counts add up to the rows", async () => {
    renderApp();
    await userEvent.click(await screen.findByRole("tab", { name: /^Applications/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Grid" }));

    const headers = await screen.findAllByRole("button", { expanded: true });
    const labels = headers.map((h) => h.textContent);
    expect(labels.some((l) => l?.includes("Couldn’t be read"))).toBe(true);
    expect(labels.some((l) => l?.includes("Waiting on tonight’s fill"))).toBe(true);

    const counts = headers.map((h) => Number(h.querySelector(".cnt")?.textContent?.match(/^\d+/)?.[0]));
    const dataRows = document.querySelectorAll("tbody tr:not(.group):not(.more-row)").length;
    expect(counts.reduce((a, b) => a + b, 0)).toBe(dataRows);
  });

  it("folds a group away but keeps reporting its count", async () => {
    renderApp();
    await userEvent.click(await screen.findByRole("tab", { name: /^Applications/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Grid" }));

    const before = document.querySelectorAll("tbody tr:not(.group):not(.more-row)").length;
    const header = (await screen.findAllByRole("button", { expanded: true })).find((h) =>
      h.textContent?.includes("Couldn’t be read"),
    )!;
    const count = Number(header.querySelector(".cnt")?.textContent?.match(/^\d+/)?.[0]);

    await userEvent.click(header);

    // By name as well as state: the grid's Details buttons are disclosure
    // toggles too, and carry aria-expanded="false" while their rows are shut.
    expect(await screen.findByRole("button", { name: /Couldn’t be read/, expanded: false })).toBeInTheDocument();
    expect(document.querySelectorAll("tbody tr:not(.group):not(.more-row)")).toHaveLength(before - count);
  });
});

describe("the XSS boundary", () => {
  it("renders hostile lead data as text and refuses a javascript: href", async () => {
    // React covers the text half. safeUrl covers the half it does not: a
    // javascript: URL is something React will render into an href quite happily.
    localStorage.setItem("tracker_token", "a-token");
    vi.spyOn(client, "getData").mockResolvedValue({
      ...fixture,
      leads: [
        {
          ...fixture.leads[0],
          id: 999,
          company: '<img src=x onerror="window.__pwned=1">',
          url: "javascript:window.__pwned=1",
        },
      ],
    });
    window.history.pushState({}, "", "/all-leads");
    renderApp();

    // Rendered in the list row and again in the detail heading - both escaped.
    expect((await screen.findAllByText('<img src=x onerror="window.__pwned=1">')).length).toBeGreaterThan(0);
    expect(document.querySelector("img")).toBeNull();
    for (const a of document.querySelectorAll("a")) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
    }
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });
});

describe("the theme toggle", () => {
  beforeEach(signedIn);

  it("shows the theme it switches to, not the one you are in", async () => {
    // These disagreed: the icon showed the current theme while the label beside
    // it named the destination. Caught by putting the two clients side by side
    // on the same account, not by any test - so here is the test.
    renderApp();
    await screen.findByRole("heading", { name: "Fixture Search" });

    const toggle = screen.getByRole("button", { name: /switch to (light|dark) theme/i });
    const label = toggle.getAttribute("aria-label")!;
    const destination = /light/i.test(label) ? "☀️" : "🌙";
    expect(toggle.textContent, `label says "${label}" so the icon should be ${destination}`).toBe(destination);
  });

  it("keeps icon and label agreeing after it is pressed", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "Fixture Search" });

    const toggle = screen.getByRole("button", { name: /switch to (light|dark) theme/i });
    await userEvent.click(toggle);

    const after = screen.getByRole("button", { name: /switch to (light|dark) theme/i });
    const label = after.getAttribute("aria-label")!;
    expect(after.textContent).toBe(/light/i.test(label) ? "☀️" : "🌙");
  });
});

describe("every input is reachable by the stylesheet", () => {
  // tracker.css selects inputs by attribute - input[type=text] and friends.
  // An input rendered without a `type` attribute matches none of them however
  // it *behaves*, and falls back to a raw browser default: white box, black
  // text, inset border. That is invisible in jsdom (no styling at all) and
  // invisible in a unit test that only asks whether a control exists, which is
  // how the sign-in name field shipped looking wrong on a dark card.
  const STYLED = ["text", "search", "url", "date", "password"];

  function assertAllTyped() {
    const inputs = [...document.querySelectorAll("input")];
    expect(inputs.length).toBeGreaterThan(0);
    for (const el of inputs) {
      const type = el.getAttribute("type");
      expect(type, `an input rendered with no type attribute: #${el.id || el.getAttribute("aria-label")}`).not.toBeNull();
      // Checkboxes and radios are styled separately and deliberately.
      if (["checkbox", "radio"].includes(type!)) continue;
      expect(STYLED, `type="${type}" is not one the stylesheet targets`).toContain(type);
    }
  }

  it("on the gate", () => {
    renderApp();
    assertAllTyped();
  });

  it("on a leads tab, in both views", async () => {
    signedIn();
    window.history.pushState({}, "", "/all-leads");
    renderApp();
    await screen.findByRole("heading", { name: "Fixture Search" });
    assertAllTyped();
    await userEvent.click(screen.getByRole("button", { name: "Grid" }));
    assertAllTyped();
  });

  it("on the applications tab, in both views", async () => {
    signedIn();
    window.history.pushState({}, "", "/applications");
    renderApp();
    await screen.findByRole("heading", { name: "Fixture Search" });
    assertAllTyped();
    await userEvent.click(screen.getByRole("button", { name: "Grid" }));
    assertAllTyped();
  });

  it("in the password dialog", async () => {
    signedIn();
    renderApp();
    await screen.findByRole("heading", { name: "Fixture Search" });
    await userEvent.click(screen.getByRole("button", { name: /signed in as/i }));
    await screen.findByRole("dialog");
    assertAllTyped();
  });
});

describe("the browser tab", () => {
  beforeEach(signedIn);

  it("takes its title from config once signed in, as the heading does", async () => {
    // The old client set document.title from display_title on sign-in. The port
    // didn't, and the tab read "Job Search Tracker" over a page headed with the
    // account's own search - found by reading the title on the deployed site.
    document.title = "Job Search Tracker";
    renderApp();
    await screen.findByRole("heading", { name: "Fixture Search" });
    await waitFor(() => expect(document.title).toBe("Fixture Search"));
  });

  it("gives the title back when the tracker goes away, so a shared browser doesn't keep it", async () => {
    document.title = "Job Search Tracker";
    const { unmount } = renderApp();
    await screen.findByRole("heading", { name: "Fixture Search" });
    await waitFor(() => expect(document.title).toBe("Fixture Search"));
    unmount();
    expect(document.title).toBe("Job Search Tracker");
  });
});
