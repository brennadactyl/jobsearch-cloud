import { describe, expect, it } from "vitest";
import type { StoredResume, Track } from "../api/schema";
import {
  attachRefusal,
  currentResume,
  joinNames,
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
  const stored = [resume("resumes/Eng.pdf")];

  it("lets a readable file under a new name through", () => {
    expect(attachRefusal("AI.docx", 5000, "resumes/AI.docx", stored)).toBeNull();
  });

  it("refuses before uploading: too big, the older Word format, or a format no search reads", () => {
    expect(attachRefusal("Portfolio.pdf", 11.4 * 1024 * 1024, "resumes/Portfolio.pdf", stored)).toBe(
      "Portfolio.pdf wasn't attached: it's 11.4 MB, and files can be up to 8 MB.",
    );
    expect(attachRefusal("Old.doc", 100, "resumes/Old.doc", stored)).toContain("older Word format");
    expect(attachRefusal("scan.png", 100, "resumes/scan.png", stored)).toContain("can read PDF, Word (.docx), .txt or .md");
  });

  it("refuses a name already stored, in any case, since storing over it would change a search without a Save", () => {
    expect(attachRefusal("eng.PDF", 100, "resumes/eng.PDF", stored)).toBe(
      "eng.PDF wasn't attached: you already have a resume called eng.PDF. Rename it and attach it again.",
    );
  });
});
