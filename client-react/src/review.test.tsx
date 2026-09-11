/**
 * One describe per finding in docs/react-ux-comparison.md, numbered to match,
 * so none of them regresses unnoticed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import type { Application, Lead, TrackerData } from "./api/schema";
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

function withApp(id: number, patch: Partial<Application>): TrackerData {
  return { ...fixture, applications: fixture.applications.map((a) => (a.id === id ? { ...a, ...patch } : a)) };
}

const app = (id: number) => fixture.applications.find((a) => a.id === id)!;
const detail = () => document.querySelector(".md-detail") as HTMLElement;
const status = () => screen.getByRole("status");

/** The declarations of every rule selecting exactly `selector` in tracker.css, comments stripped. */
function rulesFor(selector: string): string {
  const css = readFileSync(join(process.cwd(), "src", "tracker.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(",").some((s) => s.trim() === selector))
    .map(([, , body]) => body)
    .join(";");
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

describe("the Applications foot note (1.1)", () => {
  it("says how edits save and what Days counts from, in Detail", async () => {
    await renderAt("/applications");
    const note = document.querySelector(".note");
    expect(note).toHaveTextContent("Edits save when you click away. Days counts from the applied date.");
    expect(note).not.toHaveTextContent(/shown/);
  });

  it("says what Grid leaves out and where to find it", async () => {
    setPrefs({ view: "grid" });
    await renderAt("/applications");
    expect(document.querySelector(".note")).toHaveTextContent(
      "Quick-scan columns only — referral, notes, team, setup, comp, and the rest are in Detail view (click a row to open them). Edits save when you click away. Days counts from the applied date.",
    );
  });
});

describe("an application list row (1.2)", () => {
  const rowFor = (company: string) =>
    [...document.querySelectorAll<HTMLElement>(".md-row")].find((r) => r.querySelector(".co")?.textContent === company)!;

  it("says a To Apply row is not applied yet, where the applied date goes", async () => {
    await renderAt("/applications");
    expect(rowFor("Ida").querySelector(".md-row-found")).toHaveTextContent("Not applied yet");
    expect(rowFor("Kit").querySelector(".md-row-found")).toHaveTextContent(/^Applied/);
  });

  it("puts a dash where there is no role yet", async () => {
    await renderAt("/applications", withApp(13, { title: "" }));
    expect(rowFor("Kit").querySelector(".md-row-ttl")).toHaveTextContent("—");
  });

  it("says so where a run couldn't read the posting for one", async () => {
    await renderAt("/applications", withApp(13, { title: "", autofill: "failed" }));
    expect(rowFor("Kit").querySelector(".md-row-ttl")).toHaveTextContent("Couldn’t read the posting");
  });
});

describe("a session revoked elsewhere (1.4)", () => {
  it("goes back to the gate on a failed write, saying why, with the name kept and the password focused", async () => {
    localStorage.setItem("tracker_name", "Demo");
    setPrefs({ selected: { applications: "13" } });
    await renderAt("/applications");
    vi.spyOn(client, "updateApplicationField").mockRejectedValue(new client.UnauthorizedError());

    await userEvent.type(within(detail()).getByLabelText("Company"), "x");
    await userEvent.tab();

    expect(await screen.findByRole("alert")).toHaveTextContent("Your session has expired - sign in again.");
    expect(document.querySelector("#app")).toBeNull();
    expect(screen.getByPlaceholderText("Name")).toHaveValue("Demo");
    expect(screen.getByPlaceholderText("Password")).toHaveFocus();
    expect(window.location.pathname).toBe("/");
  });
});

describe("the save indicator (1.5)", () => {
  it("greys its dot while a write is in flight", async () => {
    setPrefs({ selected: { applications: "13" } });
    await renderAt("/applications");
    let finish!: (a: Application) => void;
    vi.spyOn(client, "updateApplicationField").mockReturnValue(new Promise((r) => (finish = r)));

    await userEvent.type(within(detail()).getByLabelText("Company"), "s");
    await userEvent.tab();
    await waitFor(() => expect(status()).toHaveTextContent("Saving…"));
    expect(document.querySelector(".stamp .dot")).toHaveClass("off");

    finish({ ...app(13), company: "Kits" });
    await waitFor(() => expect(status()).toHaveTextContent("Saved"));
    expect(document.querySelector(".stamp .dot")).not.toHaveClass("off");
  });
});

describe("moving a lead (1.6)", () => {
  it("says Moving…, then names the tab it went to", async () => {
    setPrefs({ selected: { alpha: "1" } });
    await renderAt("/t/alpha");
    let finish!: (l: Lead) => void;
    vi.spyOn(client, "moveLead").mockReturnValue(new Promise((r) => (finish = r)));

    await userEvent.selectOptions(within(detail()).getByLabelText("Tab"), "beta");
    await waitFor(() => expect(status()).toHaveTextContent("Moving…"));

    finish({ ...fixture.leads[0], search: "beta" });
    await waitFor(() => expect(status()).toHaveTextContent("Moved to Beta roles"));
  });

  it("says it couldn't move it when no answer came back, rather than the browser's error text", async () => {
    setPrefs({ selected: { alpha: "1" } });
    await renderAt("/t/alpha");
    vi.spyOn(client, "moveLead").mockRejectedValue(new TypeError("Failed to fetch"));

    await userEvent.selectOptions(within(detail()).getByLabelText("Tab"), "beta");

    await waitFor(() => expect(status()).toHaveTextContent("Couldn't move it — try again"));
  });
});

describe("switching from Grid to Detail (1.7)", () => {
  it("scrolls the row picked in Grid into view, and leaves the list alone after that", async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      setPrefs({ view: "grid" });
      await renderAt("/all-leads");
      const toggles = screen.getAllByRole("button", { name: "Details" });
      await userEvent.click(toggles[toggles.length - 1]);
      const picked = document.querySelector("tr.gr-sel td.co")!.textContent!;

      await userEvent.click(screen.getByRole("button", { name: "Detail" }));

      expect(scrolled).toHaveLength(1);
      expect(scrolled[0]).toHaveClass("md-row", "sel");
      expect(scrolled[0].querySelector(".co")).toHaveTextContent(picked);

      // Picking another row re-renders the list; it must not jump.
      await userEvent.click(document.querySelector<HTMLElement>(".md-row:not(.sel)")!);
      expect(scrolled).toHaveLength(1);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe("the row Detail shows by default (1.8)", () => {
  it("is the row Grid highlights, before anything has been clicked", async () => {
    await renderAt("/applications");
    const company = (within(detail()).getByLabelText("Company") as HTMLInputElement).value;
    expect(company).not.toBe("");

    await userEvent.click(screen.getByRole("button", { name: "Grid" }));

    const highlighted = document.querySelectorAll<HTMLElement>("tr.gr-sel");
    expect(highlighted).toHaveLength(1);
    expect(within(highlighted[0]).getByLabelText("Company")).toHaveValue(company);
  });

  it("never replaces a selection whose row hasn't reached the page yet", async () => {
    // Adding an application selects the new row from the write's onSuccess, and
    // a render can see that selection before it sees the row.
    setPrefs({ selected: { applications: "9100" } });
    vi.spyOn(client, "getData").mockResolvedValue(fixture);
    window.history.pushState({}, "", "/applications");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: "Fixture Search" });

    const added: Application = { ...app(13), id: 9100, company: "Newco" };
    act(() => {
      qc.setQueryData<TrackerData>(["data"], (d) => (d ? { ...d, applications: [added, ...d.applications] } : d));
    });

    await waitFor(() => expect(within(detail()).getByLabelText("Company")).toHaveValue("Newco"));
  });
});

describe("adding from a link that fails to save (1.9)", () => {
  it("keeps the link in the box, so it can be tried again", async () => {
    vi.spyOn(client, "addApplication").mockRejectedValue(new Error("boom"));
    await renderAt("/applications");
    const box = screen.getByLabelText("Link to a job posting");

    await userEvent.type(box, "https://example.com/new{Enter}");

    await waitFor(() => expect(status()).toHaveTextContent("Couldn't save — try again"));
    expect(box).toHaveValue("https://example.com/new");
  });
});

describe("the password dialog (1.10)", () => {
  it("puts focus in Current password when it opens", async () => {
    await renderAt("/");
    await userEvent.click(screen.getByRole("button", { name: /Signed in as/ }));
    expect(screen.getByLabelText("Current password")).toHaveFocus();
  });

  it("holds its message line before there is a message, so the buttons don't jump when one arrives", async () => {
    await renderAt("/");
    await userEvent.click(screen.getByRole("button", { name: /Signed in as/ }));
    expect(document.querySelector(".pw-msg")).toBeEmptyDOMElement();
  });
});

describe("logging out (1.11, 1.17)", () => {
  it("lands on the Overview's URL, at a gate named by placeholders, with the password focused", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    await renderAt("/applications");

    await userEvent.click(screen.getByRole("button", { name: "Log out" }));

    const password = await screen.findByPlaceholderText("Password");
    expect(screen.getByPlaceholderText("Name")).toHaveAttribute("type", "text");
    expect(password).toHaveFocus();
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when the server couldn't be reached to revoke the session", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await renderAt("/applications");

    await userEvent.click(screen.getByRole("button", { name: "Log out" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Signed out here, but couldn't reach the server to revoke this session.",
    );
  });
});

describe("the theme toggle (1.13)", () => {
  it("carries the id the stylesheet sizes it by", async () => {
    // `#themeToggle { line-height: 1 }` - without the id the header row is 7.5px taller.
    await renderAt("/");
    expect(screen.getByRole("button", { name: /Switch to/ })).toHaveAttribute("id", "themeToggle");
  });
});

describe("the Applications grid's link cell (1.14)", () => {
  it("marks the link as opening elsewhere", async () => {
    setPrefs({ view: "grid" });
    await renderAt("/applications");
    expect(document.querySelector("td.lk a")!.textContent).toMatch(/ ↗$/);
  });
});

describe("the add-from-link box (1.15)", () => {
  it("explains in full which page to paste", async () => {
    await renderAt("/applications");
    expect(screen.getByLabelText("Link to a job posting")).toHaveAttribute(
      "title",
      "The posting’s own page, not a search or a careers index — that page is what tonight’s run opens and reads. Greenhouse, Lever, Workday and company careers pages all work.",
    );
  });

  it("says what tonight's run does once a link is in it", async () => {
    await renderAt("/applications");
    await userEvent.type(screen.getByLabelText("Link to a job posting"), "https://example.com/x");
    expect(document.querySelector("#addhint")).toHaveTextContent(
      "Tonight’s run opens the posting and fills in the company, role and location.",
    );
  });
});

describe("the stage-date dialog (1.16)", () => {
  it("shows the stage being dated in the status select while it asks, and the real status after Cancel", async () => {
    setPrefs({ selected: { applications: "17" } });
    await renderAt("/applications");
    const select = within(detail()).getByLabelText("Status");

    await userEvent.selectOptions(select, "Offer");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(select).toHaveValue("Offer");

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(select).toHaveValue("Tech Screen");
  });
});

describe("a load that fails (1.18)", () => {
  it("says it couldn't load, and why", async () => {
    vi.spyOn(client, "getData").mockRejectedValue(new Error("boom"));
    window.history.pushState({}, "", "/");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>,
    );
    // Two retries with backoff before the error is final.
    await vi.advanceTimersByTimeAsync(10_000);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load: boom");
    expect(alert).toHaveClass("load-err");
    expect(rulesFor(".load-err").replace(/\s+/g, "")).toContain("color:var(--crit)");
  });
});
