import { describe, expect, it } from "vitest";
import { emptyAnswers, inviteNotice, isReadableResume, safeDocumentName, setupOverdue, setupProblems } from "./onboarding";

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
  it("reads only plain text overnight", () => {
    expect(["resume.txt", "Resume.MD"].every(isReadableResume)).toBe(true);
    expect(["resume.pdf", "resume.docx", "resume.doc", "resume.rtf", "resume.pages", "scan.png", "txt"].some(isReadableResume)).toBe(false);
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
  const ready = { ...emptyAnswers("Sam"), resume_text: "Engineer", roles: [{ name: "Eng", titles: "Staff engineer", company_kinds: "", rule_outs: "", min_pay: "" }] };

  it("lets a complete form send", () => {
    expect(setupProblems(ready, [])).toEqual({});
  });

  it("refuses PDF or Word files alone, and lets them through once text is pasted", () => {
    const noText = { ...ready, resume_text: "" };
    expect(setupProblems(noText, ["resume.pdf", "resume.docx"]).attach).toBe("We can't read PDF or Word files overnight. Paste the text too.");
    expect(setupProblems(noText, ["resume.pdf", "resume.txt"]).attach).toBeUndefined();
    expect(setupProblems(ready, ["resume.pdf"]).attach).toBeUndefined();
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
