/**
 * The account panel's resume section, against the documents list and the
 * settings route as the server answers them.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import type { StoredResume, TrackerData } from "./api/schema";
import { NOW, data as fixture } from "./domain/fixture";
import { clearPrefs } from "./ui/prefs";

const ENG = "resumes/Brenna_Engineering.pdf";
const AI = "resumes/Brenna_AI_Roles.docx";

const data: TrackerData = {
  ...fixture,
  tracks: [
    { ...fixture.tracks[0], key: "gaming", label: "Eng - Gaming" },
    { ...fixture.tracks[1], key: "ai", label: "Eng - AI" },
  ],
};

const reads = (...searches: string[]) => searches.map((s) => ({ search: s, tabs: [s], state: "reads" as const }));
const doc = (path: string, patch: Partial<StoredResume> = {}): StoredResume => ({
  path,
  bytes: 1000,
  uploaded: "2026-08-28T17:00:00.000Z",
  readable: true,
  words: null,
  used_by: [],
  ...patch,
});

/** The server's list, which each test changes as the server would. */
let documents: StoredResume[];

async function openResumes() {
  vi.spyOn(client, "getData").mockResolvedValue(data);
  vi.spyOn(client, "listDocuments").mockImplementation(async () => documents);
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
  await within(panel).findByText("Brenna_Engineering.pdf", NAME);
  return panel;
}

/** A resume row found by its listed name, not the picker options that repeat it. */
const NAME = { selector: ".resume-name" };
const picker = (search: string) => screen.getByRole("combobox", { name: `Resume for ${search}` });
const rowOf = (name: string) => screen.getByText(name, NAME).closest(".resume-row") as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  clearPrefs();
  localStorage.setItem("tracker_token", "a-token");
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  documents = [
    doc(ENG, { used_by: reads("gaming", "ai") }),
    doc(AI, { uploaded: "2026-09-12T17:00:00.000Z", words: 612, text_path: "resumes/Brenna_AI_Roles.txt" }),
    doc("resumes/Brenna_AI_Roles.txt", { uploaded: "2026-09-12T17:00:00.000Z", words: 612, paired_with: AI }),
  ];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the resume list", () => {
  it("still lists everything when a Word file stored before Word support has no text, and offers it to no search", async () => {
    // As GET /api/documents sends it: text_path is null, not missing.
    const unread = client.storedResumeListSchema.parse({
      documents: [{ path: "resumes/Old_Word.docx", kind: "resumes", bytes: 900, uploaded: "2026-07-01T17:00:00.000Z", words: null, text_path: null, readable: false, used_by: [] }],
    }).documents;
    documents = [...documents, ...unread];
    await openResumes();
    expect(rowOf("Old_Word.docx")).toHaveTextContent("No text could be read from it");
    expect(within(picker("Eng - AI")).queryByText("Old_Word.docx")).toBeNull();
  });

  it("lists each resume once, with its date, words read and the tabs it drives", async () => {
    await openResumes();
    expect(screen.queryByText("Brenna_AI_Roles.txt", NAME)).toBeNull();
    expect(rowOf("Brenna_Engineering.pdf")).toHaveTextContent("Uploaded Aug 28");
    expect(within(rowOf("Brenna_Engineering.pdf")).getByText("Eng - Gaming")).toBeInTheDocument();
    expect(rowOf("Brenna_AI_Roles.docx")).toHaveTextContent("Uploaded Sep 12 · 612 words read");
    expect(rowOf("Brenna_AI_Roles.docx")).toHaveTextContent("Not used by any search");
  });
});

describe("attaching a resume", () => {
  it("uploads on select and lists it unused, without changing any search", async () => {
    const put = vi.spyOn(client, "putDocument").mockImplementation(async (path) => {
      documents = [...documents, doc(path, { uploaded: new Date(NOW).toISOString(), words: 450 })];
      return { path, words: 450, text_path: path.replace(/\.docx$/, ".txt") };
    });
    const saveSpy = vi.spyOn(client, "saveSettings");
    await openResumes();

    await userEvent.upload(screen.getByLabelText("Attach a resume"), new File(["PK"], "Sam New.docx"));

    expect(put).toHaveBeenCalledWith("resumes/Sam New.docx", expect.any(File));
    expect(await screen.findByText("Attached Sam New.docx · 450 words read. Choose it for a search below, then save.")).toBeInTheDocument();
    expect(rowOf("Sam New.docx")).toHaveTextContent("Uploaded just now · 450 words read");
    expect(rowOf("Sam New.docx")).toHaveTextContent("Not used by any search");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it("refuses an older .doc, and a name a search reads, without uploading", async () => {
    const put = vi.spyOn(client, "putDocument");
    await openResumes();
    // The picker hints at the readable types, but "All files" still lets anything through.
    const user = userEvent.setup({ applyAccept: false });

    await user.upload(screen.getByLabelText("Attach a resume"), new File(["x"], "Old.doc"));
    expect(screen.getByRole("alert")).toHaveTextContent("Old.doc wasn't attached: it's the older Word format");

    await user.upload(screen.getByLabelText("Attach a resume"), new File(["x"], "Brenna_Engineering.pdf"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Eng - Gaming and Eng - AI read a resume called Brenna_Engineering.pdf. Attach this one under a new name, then choose it and save.",
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("shows the server's refusal as written", async () => {
    const reason = "Scan.docx has only 12 words of text - if it is a scanned image or a template, attach a PDF or paste the text instead";
    vi.spyOn(client, "putDocument").mockRejectedValue(Object.assign(new Error(reason), { status: 422 }));
    await openResumes();
    await userEvent.upload(screen.getByLabelText("Attach a resume"), new File(["PK"], "Scan.docx"));
    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.queryByText("Scan.docx", NAME)).toBeNull();
  });

  it("stores pasted text as a .txt resume", async () => {
    const put = vi.spyOn(client, "putDocument").mockImplementation(async (path) => {
      documents = [...documents, doc(path, { words: 284 })];
      return { path };
    });
    await openResumes();
    await userEvent.click(screen.getByRole("button", { name: "Paste text" }));
    await userEvent.type(screen.getByLabelText("Name"), "Brenna_Short");
    await userEvent.type(screen.getByLabelText("Resume text"), "Staff engineer");
    await userEvent.click(screen.getByRole("button", { name: "Add resume" }));

    expect(put).toHaveBeenCalledWith("resumes/Brenna_Short.txt", expect.any(Blob));
    expect(await screen.findByText("Added Brenna_Short.txt · 284 words read. Choose it for a search below, then save.")).toBeInTheDocument();
    expect(rowOf("Brenna_Short.txt")).toHaveTextContent("Added just now · 284 words read");
    expect(screen.queryByLabelText("Resume text")).toBeNull();
  });
});

describe("choosing a resume for a search", () => {
  it("marks the section unsaved, and Discard puts the picker back", async () => {
    await openResumes();
    expect(picker("Eng - AI")).toHaveValue(ENG);

    await userEvent.selectOptions(picker("Eng - AI"), AI);
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
    expect(screen.getByText("Not saved yet. Once you save, Eng - AI reads it from its next run.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(picker("Eng - AI")).toHaveValue(ENG);
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it("offers only resumes a search can read", async () => {
    documents = [...documents, doc("resumes/Broken.docx", { readable: false })];
    await openResumes();
    const options = within(picker("Eng - Gaming")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Brenna_Engineering.pdf", "Brenna_AI_Roles.docx"]);
    expect(rowOf("Broken.docx")).toHaveTextContent("No text could be read from it");
  });

  it("saves only the changed searches, then says what happens until tonight", async () => {
    const saveSpy = vi.spyOn(client, "saveSettings").mockImplementation(async () => {
      documents = [
        doc(ENG, { used_by: [...reads("gaming"), { search: "ai", tabs: ["ai"], state: "until_next_run" }] }),
        doc(AI, { uploaded: "2026-09-12T17:00:00.000Z", words: 612, used_by: [{ search: "ai", tabs: ["ai"], state: "from_next_run" }] }),
      ];
      return { resumes: {}, locations: {} };
    });
    await openResumes();
    await userEvent.selectOptions(picker("Eng - AI"), AI);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(saveSpy).toHaveBeenCalledWith({ resumes: { ai: AI } });
    expect(
      await screen.findByText(
        "Saved. Waiting for tonight's run: until then Eng - AI still searches with Brenna_Engineering.pdf. Tonight it reads Brenna_AI_Roles.docx and rewrites its profile from it before searching.",
      ),
    ).toBeInTheDocument();
    // Still read by Eng - Gaming, so still used; Eng - AI has moved off it.
    expect(rowOf("Brenna_Engineering.pdf")).toHaveTextContent("Used byEng - Gaming(replaced for Eng - AI)");
    expect(rowOf("Brenna_AI_Roles.docx")).toHaveTextContent("(from tonight)");
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it("drops a refusal to remove a file once a save points its searches elsewhere, and lets it go", async () => {
    documents = [doc(ENG, { used_by: reads("gaming", "ai") }), doc(AI, { uploaded: "2026-09-12T17:00:00.000Z", words: 612 })];
    vi.spyOn(client, "saveSettings").mockImplementation(async () => {
      const until = (s: string) => ({ search: s, tabs: [s], state: "until_next_run" as const });
      const from = (s: string) => ({ search: s, tabs: [s], state: "from_next_run" as const });
      documents = [
        doc(ENG, { used_by: [until("gaming"), until("ai")] }),
        doc(AI, { uploaded: "2026-09-12T17:00:00.000Z", words: 612, used_by: [from("gaming"), from("ai")] }),
      ];
      return { resumes: {}, locations: {} };
    });
    await openResumes();
    await userEvent.selectOptions(picker("Eng - Gaming"), AI);
    await userEvent.selectOptions(picker("Eng - AI"), AI);
    await userEvent.click(within(rowOf("Brenna_Engineering.pdf")).getByRole("button", { name: "Remove Brenna_Engineering.pdf" }));
    expect(rowOf("Brenna_Engineering.pdf")).toHaveTextContent("can't be removed");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(rowOf("Brenna_Engineering.pdf")).toHaveTextContent(
        "Replaced for Eng - Gaming and Eng - AI. No search needs it, so you can remove it.",
      ),
    );
    expect(rowOf("Brenna_Engineering.pdf")).not.toHaveTextContent("Used by");
    expect(rowOf("Brenna_Engineering.pdf")).not.toHaveTextContent("can't be removed");

    await userEvent.click(within(rowOf("Brenna_Engineering.pdf")).getByRole("button", { name: "Remove Brenna_Engineering.pdf" }));
    expect(rowOf("Brenna_Engineering.pdf")).toHaveTextContent("Remove Brenna_Engineering.pdf? It's deleted for good.");
  });

  it("keeps the choices and shows the refusal when a save is refused", async () => {
    vi.spyOn(client, "saveSettings").mockRejectedValue(Object.assign(new Error("Eng - AI can't read that file"), { status: 422 }));
    await openResumes();
    await userEvent.selectOptions(picker("Eng - AI"), AI);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Eng - AI can't read that file")).toBeInTheDocument();
    expect(picker("Eng - AI")).toHaveValue(AI);
  });
});

describe("leaving with an unsaved choice", () => {
  it("asks first, and Keep editing keeps the choice", async () => {
    await openResumes();
    await userEvent.selectOptions(picker("Eng - AI"), AI);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    const ask = screen.getByRole("alertdialog", { name: "Leave without saving?" });
    expect(ask).toHaveTextContent(
      "You chose Brenna_AI_Roles.docx for Eng - AI but didn't save, so Eng - AI keeps Brenna_Engineering.pdf.",
    );
    await userEvent.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(picker("Eng - AI")).toHaveValue(AI);
  });

  it("closes on Discard change, and closes without asking when nothing is unsaved", async () => {
    await openResumes();
    await userEvent.selectOptions(picker("Eng - AI"), AI);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Discard change" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "My account" }));
    await screen.findByText("Brenna_Engineering.pdf", NAME);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("removing a resume", () => {
  it("confirms first, then deletes a file no search reads", async () => {
    const del = vi.spyOn(client, "deleteDocument").mockImplementation(async (path) => {
      documents = documents.filter((d) => d.path !== path && d.paired_with !== path);
      return { path };
    });
    await openResumes();
    await userEvent.click(screen.getByRole("button", { name: "Remove Brenna_AI_Roles.docx" }));
    expect(rowOf("Brenna_AI_Roles.docx")).toHaveTextContent("Remove Brenna_AI_Roles.docx? It's deleted for good. No search reads it.");
    expect(del).not.toHaveBeenCalled();

    await userEvent.click(within(rowOf("Brenna_AI_Roles.docx")).getByRole("button", { name: "Remove" }));
    expect(del).toHaveBeenCalledWith(AI);
    await waitFor(() => expect(screen.queryByText("Brenna_AI_Roles.docx", NAME)).toBeNull());
  });

  it("refuses a file searches read, naming them, without asking the server", async () => {
    const del = vi.spyOn(client, "deleteDocument");
    await openResumes();
    await userEvent.click(screen.getByRole("button", { name: "Remove Brenna_Engineering.pdf" }));
    expect(within(rowOf("Brenna_Engineering.pdf")).getByRole("alert")).toHaveTextContent(
      "Eng - Gaming and Eng - AI read this resume, so it can't be removed. Choose another resume for them below first.",
    );
    expect(del).not.toHaveBeenCalled();
  });
});
