import { describe, expect, it } from "vitest";
import {
  emptyAnswers,
  inviteNotice,
  isOlderWordFile,
  isReadableResume,
  retriesEnded,
  safeDocumentName,
  setupOverdue,
  setupProblems,
} from "./onboarding";

/** The documents route's filename rule (server/src/validate.js). */
const ROUTE_NAME = /^\w(?:[\w .-]*\w)?$/;

describe("inviteNotice", () => {
  it("says what happened to a used or expired link, and one sentence for anything else", () => {
    expect(inviteNotice("used")).toContain("already been used");
    expect(inviteNotice("expired")).toContain("has expired");
    expect(inviteNotice("invalid")).toBe(inviteNotice("revoked"));
  });
});

describe("isReadableResume", () => {
  it("reads PDFs, Word files, and text", () => {
    expect(["resume.pdf", "Resume.PDF", "resume.docx", "Resume.DOCX", "resume.txt", "Resume.MD"].every(isReadableResume)).toBe(true);
  });

  it("holds out for pasted text on a format the run can't open", () => {
    expect(["resume.doc", "resume.rtf", "resume.pages", "scan.png", "txt"].some(isReadableResume)).toBe(false);
  });
});

describe("isOlderWordFile", () => {
  it("picks out the older .doc format, not .docx", () => {
    expect(["resume.doc", "Resume.DOC"].every(isOlderWordFile)).toBe(true);
    expect(["resume.docx", "resume.doc.pdf", "doc"].some(isOlderWordFile)).toBe(false);
  });
});

describe("safeDocumentName", () => {
  it.each([
    ["Sam's Resume (final).pdf", "Sam-s Resume -final.pdf"],
    [" resume .md", "resume.md"],
    ["CON.txt", "CON-file.txt"],
    ["résumé.docx", "resume.docx"],
    ["(1).pdf", "1.pdf"],
    ["!!!.txt", "resume.txt"],
  ])("stores %j as %j", (from, to) => {
    expect(safeDocumentName(from)).toBe(to);
  });

  it("always produces a name the documents route accepts", () => {
    for (const name of ["a b.c.txt", "--x--.md", "Résumé 2026 — final!.pdf", "aux", "x.", ".hidden", "naïve résumé (v2).docx"]) {
      expect(safeDocumentName(name), name).toMatch(ROUTE_NAME);
    }
  });
});

describe("setupProblems", () => {
  const ready = {
    ...emptyAnswers("Sam"),
    resume_text: "Engineer",
    work_scope: "Anywhere in the US",
    roles: [{ name: "Eng", titles: "Staff engineer", company_kinds: "", rule_outs: "", min_pay: "" }],
  };

  it("lets a complete form send", () => {
    expect(setupProblems(ready, [])).toEqual({});
  });

  it("holds out for where the person can work, which is the only answer that scopes the search", () => {
    expect(setupProblems({ ...ready, work_scope: "  " }, []).work_scope).toBe(
      "Say what locations should be searched — the search needs somewhere to look.",
    );
    // An exclusion is not a scope: on its own it still can't send.
    expect(setupProblems({ ...ready, work_scope: "", location_limits: "Nowhere in Texas" }, [])).toHaveProperty("work_scope");
  });

  it("sends a PDF on its own, since the run reads it", () => {
    const noText = { ...ready, resume_text: "" };
    expect(setupProblems(noText, ["resume.pdf"]).attach).toBeUndefined();
  });

  it("sends a Word file on its own, since the server reads its text", () => {
    expect(setupProblems({ ...ready, resume_text: "" }, ["resume.docx"]).attach).toBeUndefined();
  });

  it("refuses a file nothing can read alone, and lets it through once text is pasted", () => {
    const noText = { ...ready, resume_text: "" };
    expect(setupProblems(noText, ["resume.rtf"]).attach).toBe(
      "We can't read that file overnight. Attach a PDF, Word (.docx), .txt or .md file, or paste the text too.",
    );
    expect(setupProblems(noText, ["resume.rtf", "resume.txt"]).attach).toBeUndefined();
    expect(setupProblems(ready, ["resume.rtf"]).attach).toBeUndefined();
    expect(setupProblems(noText, []).attach).toBe("Attach your resume or paste its text.");
  });

  it("puts the missing-role message on the first incomplete role", () => {
    const roles = [{ name: "Eng", titles: "", company_kinds: "", rule_outs: "", min_pay: "" }];
    expect(setupProblems({ ...ready, roles }, [])).toEqual({
      "role-0": "Fill in at least one role — both what to call it and what to look for.",
    });
  });

  it("holds the send while a location can't be matched, or there are too many", () => {
    expect(setupProblems({ ...ready, locations_first: "Seattle, WA" }, []).locations).toBeTruthy();
    const many = Array.from({ length: 21 }, (_, i) => `Place${String.fromCharCode(97 + i)}ton`).join(", ");
    expect(setupProblems({ ...ready, locations_first: many }, []).locations).toContain("up to 20");
  });
});

describe("setupOverdue", () => {
  const sent = "2026-09-14T09:00:00Z";
  it("is overdue once the account's stale window has passed since this attempt started", () => {
    expect(setupOverdue(sent, 36, Date.parse("2026-09-15T20:00:00Z"))).toBe(false);
    expect(setupOverdue(sent, 36, Date.parse("2026-09-15T22:00:00Z"))).toBe(true);
    expect(setupOverdue("", 36, Date.parse("2026-09-15T22:00:00Z"))).toBe(false);
  });
});

describe("retriesEnded", () => {
  const end = "2026-09-19T05:38:24.351Z";
  it("has ended from the server's cutoff instant on, and not a millisecond before", () => {
    expect(retriesEnded(end, Date.parse(end) - 1)).toBe(false);
    expect(retriesEnded(end, Date.parse(end))).toBe(true);
  });

  it("reads a missing cutoff as still retrying, which is what the page said before there was one", () => {
    expect(retriesEnded("", Date.parse(end) + 1)).toBe(false);
    expect(retriesEnded("not a date", Date.parse(end) + 1)).toBe(false);
  });
});
