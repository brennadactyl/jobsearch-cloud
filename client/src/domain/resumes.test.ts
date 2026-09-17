import { describe, expect, it } from "vitest";
import type { StoredResume, Track } from "../api/schema";
import {
  attachRefusal,
  currentResume,
  joinNames,
  removeRefusal,
  resumeDetail,
  resumeRows,
  rootSearches,
  waitingChange,
} from "./resumes";

const resume = (path: string, patch: Partial<StoredResume> = {}): StoredResume => ({
  path,
  bytes: 1000,
  uploaded: "2026-08-28T17:00:00.000Z",
  readable: true,
  words: null,
  used_by: [],
  ...patch,
});

describe("resumeRows", () => {
  it("lists resumes oldest first, and shows a Word file once, not beside the text read from it", () => {
    const rows = resumeRows([
      resume("resumes/AI.docx", { uploaded: "2026-09-12T17:00:00.000Z", text_path: "resumes/AI.txt" }),
      resume("resumes/AI.txt", { uploaded: "2026-09-12T17:00:00.000Z", paired_with: "resumes/AI.docx" }),
      resume("reference/notes.md"),
      resume("resumes/Eng.pdf"),
    ]);
    expect(rows.map((r) => r.path)).toEqual(["resumes/Eng.pdf", "resumes/AI.docx"]);
  });
});

describe("rootSearches", () => {
  it("gives a resume only to searches that run, not to tabs another search fills", () => {
    const t = (key: string, sort_order: number, fed_by = "") => ({ key, sort_order, fed_by }) as Track;
    expect(rootSearches([t("b", 2), t("a-remote", 3, "a"), t("a", 1)]).map((x) => x.key)).toEqual(["a", "b"]);
  });
});

describe("which resume a search reads", () => {
  const rows = [
    resume("resumes/Eng.pdf", { used_by: [{ search: "gaming", tabs: ["gaming"], state: "reads" }, { search: "ai", tabs: ["ai"], state: "until_next_run" }] }),
    resume("resumes/AI.docx", { used_by: [{ search: "ai", tabs: ["ai"], state: "from_next_run" }] }),
  ];

  it("is the saved choice, even while the next run hasn't picked it up", () => {
    expect(currentResume(rows, "gaming")).toBe("resumes/Eng.pdf");
    expect(currentResume(rows, "ai")).toBe("resumes/AI.docx");
    expect(currentResume(rows, "nobody")).toBe("");
  });

  it("names both files while a saved change waits for the next run", () => {
    expect(waitingChange(rows, "ai")).toEqual({ until: "resumes/Eng.pdf", from: "resumes/AI.docx" });
    expect(waitingChange(rows, "gaming")).toBeNull();
  });
});

describe("resumeDetail", () => {
  it("says when a file arrived and how many words were read from it", () => {
    expect(resumeDetail(resume("resumes/Eng.pdf"), null)).toBe("Uploaded Aug 28");
    expect(resumeDetail(resume("resumes/AI.docx", { words: 612 }), "uploaded")).toBe("Uploaded just now · 612 words read");
    expect(resumeDetail(resume("resumes/Short.txt", { words: 284 }), "pasted")).toBe("Added just now · 284 words read");
  });
});

describe("joinNames", () => {
  it("reads as a sentence", () => {
    expect(joinNames(["A"])).toBe("A");
    expect(joinNames(["A", "B"])).toBe("A and B");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
  });
});

describe("attachRefusal", () => {
  const stored = [
    resume("resumes/Eng.pdf", { used_by: [{ search: "ai", tabs: ["ai"], state: "reads" }] }),
    resume("resumes/AI.docx", { text_path: "resumes/AI.txt", used_by: [{ search: "gaming", tabs: ["gaming"], state: "reads" }] }),
    resume("resumes/AI.txt", { paired_with: "resumes/AI.docx", used_by: [{ search: "gaming", tabs: ["gaming"], state: "reads" }] }),
    resume("resumes/Spare.pdf"),
  ];
  const labelOf = (key: string) => ({ ai: "Eng - AI", gaming: "Eng - Gaming" })[key] ?? key;

  it("lets a readable file under a new name through", () => {
    expect(attachRefusal("New.docx", 5000, "resumes/New.docx", stored, labelOf)).toBeNull();
  });

  it("refuses before uploading: too big, the older Word format, or a format no search reads", () => {
    expect(attachRefusal("Portfolio.pdf", 11.4 * 1024 * 1024, "resumes/Portfolio.pdf", stored, labelOf)).toBe(
      "Portfolio.pdf wasn't attached: it's 11.4 MB, and files can be up to 8 MB.",
    );
    expect(attachRefusal("Old.doc", 100, "resumes/Old.doc", stored, labelOf)).toContain("older Word format");
    expect(attachRefusal("scan.png", 100, "resumes/scan.png", stored, labelOf)).toContain("can read PDF, Word (.docx), .txt or .md");
  });

  it("refuses a name a search reads, in any case, since storing over it would change that search without a Save", () => {
    expect(attachRefusal("eng.PDF", 100, "resumes/eng.PDF", stored, labelOf)).toBe(
      "Eng - AI reads a resume called eng.PDF. Attach this one under a new name, then choose it and save.",
    );
    // A Word file and its text are one resume: pasting over the text is the same change.
    expect(attachRefusal("AI.txt", 100, "resumes/AI.txt", stored, labelOf)).toContain("Eng - Gaming reads");
  });

  it("lets a same-name file replace one no search reads, since nothing changes for any search", () => {
    expect(attachRefusal("Spare.pdf", 100, "resumes/Spare.pdf", stored, labelOf)).toBeNull();
  });
});

describe("removeRefusal", () => {
  const labelOf = (key: string) => ({ ai: "Eng - AI", gaming: "Eng - Gaming" })[key] ?? key;

  it("names the searches that go on reading a resume", () => {
    const both = resume("resumes/Eng.pdf", { used_by: [{ search: "gaming", tabs: ["gaming"], state: "reads" }, { search: "ai", tabs: ["ai"], state: "reads" }] });
    expect(removeRefusal(both, labelOf)).toBe(
      "Eng - Gaming and Eng - AI read this resume, so it can't be removed. Choose another resume for them below first.",
    );
    const next = resume("resumes/AI.docx", { used_by: [{ search: "ai", tabs: ["ai"], state: "from_next_run" }] });
    expect(removeRefusal(next, labelOf)).toBe(
      "Eng - AI reads this resume, so it can't be removed. Choose another resume for that search below first.",
    );
  });

  it("lets a resume go once its search only holds it until tonight, since the next run reads the new one", () => {
    const old = resume("resumes/Eng.pdf", { used_by: [{ search: "ai", tabs: ["ai"], state: "until_next_run" }] });
    expect(removeRefusal(old, labelOf)).toBe("");
    expect(removeRefusal(resume("resumes/Spare.pdf"), labelOf)).toBe("");
  });
});
