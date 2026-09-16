/**
 * Invite signup and the setup form, from the invite link to the tracker taking
 * over. The API is mocked in the shapes docs/onboarding-plan.md fixes.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import type { Intake, IntakeAnswers, TrackerData } from "./api/schema";
import { NOW, data as fixture } from "./domain/fixture";
import { emptyAnswers } from "./domain/onboarding";
import { clearPrefs } from "./ui/prefs";

const newAccount: TrackerData = { ...fixture, tracks: [], leads: [], applications: [], user: { id: "u9", name: "Sam" } };

function renderAt(path: string) {
  window.history.pushState({}, "", path);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

function refusal(status: number, message: string, extra: { field?: string; reason?: string } = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function intake(patch: Partial<Intake> = {}, answers: Partial<IntakeAnswers> = {}): Intake {
  return {
    answers: { ...emptyAnswers("Sam"), resume_text: "Engineer", ...answers },
    status: "pending",
    status_note: "",
    sent_at: new Date(NOW - 3_600_000).toISOString(),
    updated_at: new Date(NOW - 3_600_000).toISOString(),
    ...patch,
  };
}

beforeEach(() => {
  localStorage.clear();
  clearPrefs();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("an invite link", () => {
  beforeEach(() => {
    vi.spyOn(client, "checkInvite").mockResolvedValue({ valid: true, expires_at: "2026-09-24T00:00:00Z" });
  });

  it("opens the card in signup mode, and checks the fields before asking the server", async () => {
    const signup = vi.spyOn(client, "signup");
    renderAt("/?invite=abc123");
    expect(await screen.findByRole("heading", { name: "Create your account" })).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText("Name"), "Sam");
    await userEvent.type(screen.getByLabelText("Password (12 characters or more)"), "short");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByText("Use at least 12 characters.")).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText("Password (12 characters or more)"));
    await userEvent.type(screen.getByLabelText("Password (12 characters or more)"), "long enough password");
    await userEvent.type(screen.getByLabelText("Confirm password"), "long enough passwerd");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByText("Those two passwords don't match.")).toBeInTheDocument();
    expect(signup).not.toHaveBeenCalled();
  });

  it("shows a password on request", async () => {
    renderAt("/?invite=abc123");
    const field = await screen.findByLabelText("Password (12 characters or more)");
    expect(field).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Show password (12 characters or more)" }));
    expect(field).toHaveAttribute("type", "text");
  });

  it("puts the server's taken-name message under the name, and keeps the invite", async () => {
    vi.spyOn(client, "signup").mockRejectedValue(
      refusal(409, "The name “Sam” is already taken here — pick another.", { field: "name" }),
    );
    renderAt("/?invite=abc123");
    await userEvent.type(await screen.findByPlaceholderText("Name"), "Sam");
    await userEvent.type(screen.getByLabelText("Password (12 characters or more)"), "long enough password");
    await userEvent.type(screen.getByLabelText("Confirm password"), "long enough password");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("The name “Sam” is already taken here — pick another.")).toBeInTheDocument();
    expect(window.location.search).toBe("?invite=abc123");
  });

  it("falls back to sign-in with the reason, and leaves the address bar, when the link is used", async () => {
    vi.mocked(client.checkInvite).mockResolvedValue({ valid: false, reason: "used" });
    renderAt("/?invite=abc123");
    expect(await screen.findByRole("heading", { name: "Job search access" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("This invite link has already been used");
    expect(window.location.search).toBe("");
  });

  it("says an expired link has expired", async () => {
    vi.mocked(client.checkInvite).mockResolvedValue({ valid: false, reason: "expired" });
    renderAt("/?invite=abc123");
    expect(await screen.findByRole("alert")).toHaveTextContent("This invite link has expired — ask for a new one.");
  });

  it("signs the new account in, clears the code, and lands on setup", async () => {
    vi.spyOn(client, "signup").mockImplementation(async () => {
      localStorage.setItem("tracker_token", "new-token");
      return { token: "new-token", user: { id: "u9", name: "Sam" } };
    });
    vi.spyOn(client, "getData").mockResolvedValue(newAccount);
    vi.spyOn(client, "getIntake").mockResolvedValue(null);
    renderAt("/?invite=abc123");

    await userEvent.type(await screen.findByPlaceholderText("Name"), "Sam");
    await userEvent.type(screen.getByLabelText("Password (12 characters or more)"), "long enough password");
    await userEvent.type(screen.getByLabelText("Confirm password"), "long enough password");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("heading", { name: "Set up your job search" })).toBeInTheDocument();
    expect(client.signup).toHaveBeenCalledWith("abc123", "Sam", "long enough password");
    expect(window.location.search).toBe("");
  });
});

describe("the setup form", () => {
  beforeEach(() => {
    localStorage.setItem("tracker_token", "a-token");
    vi.spyOn(client, "getData").mockResolvedValue(newAccount);
  });

  async function openSetup(existing: Intake | null = null) {
    vi.spyOn(client, "getIntake").mockResolvedValue(existing);
    renderAt("/");
    await screen.findByRole("heading", { name: "Set up your job search" });
  }

  async function fillRole() {
    await userEvent.type(screen.getByLabelText("Call it"), "Engineering");
    await userEvent.type(screen.getByLabelText("What roles?"), "Staff backend engineer");
  }

  it("shows instead of an empty tracker, prefilled with the account's name", async () => {
    await openSetup();
    expect(screen.getByLabelText("What should this page be called?")).toHaveValue("Sam's Job Search");
    expect(screen.getByRole("button", { name: "Start my search" })).toBeInTheDocument();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("sends a PDF on its own, since the run reads it", async () => {
    await openSetup();
    vi.spyOn(client, "putDocument").mockImplementation(async (path) => ({ path }));
    const submit = vi.spyOn(client, "submitIntake").mockResolvedValue(intake());
    vi.mocked(client.getIntake).mockResolvedValue(intake());

    await fillRole();
    await userEvent.upload(screen.getByLabelText("Attach resume files"), new File(["%PDF"], "resume.pdf", { type: "application/pdf" }));
    await userEvent.click(screen.getByRole("button", { name: "Start my search" }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit.mock.calls[0][0].resume_files).toEqual(["resumes/resume.pdf"]);
  });

  it("refuses to send a Word file alone, beside Attach", async () => {
    const submit = vi.spyOn(client, "submitIntake");
    await openSetup();
    await fillRole();
    await userEvent.upload(screen.getByLabelText("Attach resume files"), new File(["PK"], "resume.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    await userEvent.click(screen.getByRole("button", { name: "Start my search" }));

    expect(screen.getByText("We can't read Word files overnight. Paste the text too.")).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses a file over 8 MB when it's picked", async () => {
    await openSetup();
    const big = new File(["x"], "scan.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: 11.4 * 1024 * 1024 });
    await userEvent.upload(screen.getByLabelText("Attach resume files"), big);
    expect(screen.getByText("Not attached: it's 11.4 MB, and files can be up to 8 MB.")).toBeInTheDocument();
  });

  it("asks for a role beside the role block", async () => {
    await openSetup();
    await userEvent.type(screen.getByLabelText("Or paste it here"), "Engineer");
    await userEvent.click(screen.getByRole("button", { name: "Start my search" }));
    expect(screen.getByText("Fill in at least one role — both what to call it and what to look for.")).toBeInTheDocument();
  });

  it("reads locations back as what each matches, and flags one it can't match", async () => {
    await openSetup();
    await userEvent.type(screen.getByLabelText("Which locations should come first?"), "Seattle, WA, Remote US");
    const readback = document.querySelector(".setup-readback") as HTMLElement;
    expect(readback).toHaveTextContent("1. Seattle");
    expect(readback).toHaveTextContent("2. Remote US — remote postings in the United States");
    expect(readback).not.toHaveTextContent("WA");
    expect(screen.getByText(/“WA” is too short to match reliably/)).toHaveClass("field-err");
  });

  it("adds and removes role blocks, and the first has no Remove", async () => {
    await openSetup();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add another kind of role" }));
    expect(screen.getByText("Role 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByText("Role 2")).toBeNull();
  });

  it("uploads files under a safe name, then sends the answers with the computed location rules", async () => {
    await openSetup();
    const put = vi.spyOn(client, "putDocument").mockImplementation(async (path) => ({ path }));
    const submit = vi.spyOn(client, "submitIntake").mockResolvedValue(intake());
    vi.mocked(client.getIntake).mockResolvedValue(intake());

    await fillRole();
    await userEvent.click(screen.getByRole("button", { name: "she/her" }));
    await userEvent.upload(screen.getByLabelText("Attach resume files"), new File(["hi"], "Sam's Resume (final).txt", { type: "text/plain" }));
    await userEvent.type(screen.getByLabelText("Which locations should come first?"), "Seattle, Remote US");
    await userEvent.click(screen.getByRole("button", { name: "Start my search" }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(put).toHaveBeenCalledWith("resumes/Sam-s Resume -final.txt", expect.any(File));
    const sent = submit.mock.calls[0][0];
    expect(sent.pronouns).toBe("she/her");
    expect(sent.resume_files).toEqual(["resumes/Sam-s Resume -final.txt"]);
    expect(sent.priority_locations.map((r) => r.label)).toEqual(["Seattle", "Remote US"]);
    expect(sent.roles[0]).toMatchObject({ name: "Engineering", titles: "Staff backend engineer" });

    expect(await screen.findByText("You're all set — it's building tonight")).toBeInTheDocument();
    // A first run can finish healthily with nothing in it, so the banner says so
    // rather than leaving an empty tracker to read as a broken one.
    expect(screen.getByText(/may well open empty.*real result/s)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send changes" })).toBeInTheDocument();
    expect(screen.getAllByRole("status").some((s) => s.textContent === "Sent")).toBe(true);
    expect(screen.queryByRole("link", { name: /tracker/i })).toBeNull();
  });

  it("puts a server refusal beside the field it names, and says it couldn't send", async () => {
    await openSetup();
    vi.spyOn(client, "submitIntake").mockRejectedValue(refusal(400, "describe at least one role", { field: "roles" }));
    await fillRole();
    await userEvent.type(screen.getByLabelText("Or paste it here"), "Engineer");
    await userEvent.click(screen.getByRole("button", { name: "Start my search" }));

    expect(await screen.findByText("describe at least one role")).toBeInTheDocument();
    expect(screen.getAllByRole("status").some((s) => s.textContent === "Couldn't send — try again")).toBe(true);
  });

  it("says the run's own note when setup couldn't finish", async () => {
    await openSetup(intake({ status: "failed", status_note: "The run stopped partway through." }));
    expect(screen.getByText("Setup couldn't finish")).toBeInTheDocument();
    expect(screen.getByText(/The run stopped partway through\./)).toBeInTheDocument();
  });

  it("says it may be waiting on the search machine once the stale window has passed", async () => {
    await openSetup(intake({ sent_at: new Date(NOW - 40 * 3_600_000).toISOString() }));
    expect(screen.getByText(/This hasn't run yet/)).toBeInTheDocument();
  });

  it("gives way to the tracker once the run is done", async () => {
    vi.spyOn(client, "getIntake").mockResolvedValue(intake({ status: "done" }));
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Fixture Search" })).toBeInTheDocument();
    expect(within(document.body).queryByText("Set up your job search")).toBeNull();
  });

  it("shows the tracker when the setup read fails, rather than a form on a guess", async () => {
    vi.spyOn(client, "getIntake").mockRejectedValue(refusal(404, "not found"));
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Fixture Search" })).toBeInTheDocument();
  });
});
