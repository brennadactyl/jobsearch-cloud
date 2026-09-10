/**
 * The gate and the summary, queried the way a person reaches them.
 *
 * Everything here is found by role and accessible name rather than by class or
 * test id, which is what makes "every interactive element is a real control"
 * an assertion rather than a convention - a div with a click handler has no
 * role to find, so these tests fail if one appears.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

const payload = {
  user: { id: "u1", name: "Ada" },
  updated: "2026-09-10",
  leads: [],
  applications: [],
  screened: [],
  tracks: [],
  settings: {
    display_title: "Ada's Job Search",
    overview_label: "Overview",
    applications_label: "Applications",
    all_leads_label: "All leads",
    stale_run_hours: 36,
    priority_locations: [],
    excluded_companies: [],
  },
};

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

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
    // The server gives one answer for both; saying which half was wrong would
    // tell an attacker which half they have right.
    vi.spyOn(client, "login").mockRejectedValue(new client.UnauthorizedError());
    renderApp();
    await userEvent.type(screen.getByRole("textbox", { name: /name/i }), "Ada");
    await userEvent.type(screen.getByLabelText(/password/i), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/don't match/i);
  });

  it("submits on Enter, because it is a real form", async () => {
    const login = vi.spyOn(client, "login").mockResolvedValue({ token: "t" });
    vi.spyOn(client, "getData").mockResolvedValue(payload);
    renderApp();
    await userEvent.type(screen.getByRole("textbox", { name: /name/i }), "Ada");
    await userEvent.type(screen.getByLabelText(/password/i), "correct-horse{Enter}");
    await waitFor(() => expect(login).toHaveBeenCalledWith("Ada", "correct-horse"));
  });
});

describe("the signed-in summary", () => {
  beforeEach(() => {
    localStorage.setItem("tracker_token", "a-token");
    vi.spyOn(client, "getData").mockResolvedValue(payload);
  });

  it("takes its title from config rather than hardcoding one", async () => {
    // The same deployed client serves every account, so nothing here may name
    // a person or a track. See the plan's parity bar.
    renderApp();
    expect(await screen.findByRole("heading", { name: "Ada's Job Search" })).toBeInTheDocument();
  });

  it("says who the server resolved the token to", async () => {
    renderApp();
    expect(await screen.findByText(/signed in as ada/i)).toBeInTheDocument();
  });

  it("reports the counts it loaded", async () => {
    vi.spyOn(client, "getData").mockResolvedValue({
      ...payload,
      leads: [{ id: 1, search: "alpha", company: "Acme", title: "Eng", url: "https://example.com/1" }],
      applications: [{ id: 2, dateApplied: "2026-09-01" }],
    } as never);
    renderApp();
    // Found by role, then read as text. `listitem` is not a name-from-content
    // role, so a `name` option would match nothing however the list is built -
    // the role query is still what proves each count is in a real list item.
    await screen.findByRole("list");
    const counts = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(counts).toEqual(["Leads1", "Applications1", "Screened0", "Tracked searches0"]);
  });

  it("shows the gate again when the token has been revoked elsewhere", async () => {
    vi.spyOn(client, "getData").mockRejectedValue(new client.UnauthorizedError());
    renderApp();
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("offers a real button to log out", async () => {
    renderApp();
    expect(await screen.findByRole("button", { name: /log out/i })).toBeInTheDocument();
  });
});
