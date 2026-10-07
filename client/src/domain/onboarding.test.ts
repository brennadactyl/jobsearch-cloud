import { describe, expect, it } from "vitest";
import {
  answersToSend,
  emptyAnswers,
  inviteNotice,
  isOlderWordFile,
  isReadableResume,
  retriesEnded,
  safeDocumentName,
  setupOverdue,
  setupProblems,
} from "./onboarding";
import { changedSearches } from "./panel";
import { tracks as trackList } from "./fixture";

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
    roles: [{ name: "Eng", titles: "Staff engineer", company_kinds: "", rule_outs: "", min_pay: "", min_pay_unit: "" }],
  };

  it("lets a complete form send", () => {
    expect(setupProblems(ready, [])).toEqual({});
  });

  it("holds out for somewhere to search: the searched list, or the ranked places alone", () => {
    const nowhere = { ...ready, work_scope: "  ", locations_first: " , " };
    expect(setupProblems(nowhere, []).work_scope).toBe(
      "Say what locations should be searched, or rank some places first — the search needs somewhere to look.",
    );
    // An exclusion is not somewhere to look: on its own it still can't send.
    expect(setupProblems({ ...nowhere, location_limits: "Nowhere in Texas" }, [])).toHaveProperty("work_scope");
    // Ranked places are always searched, so they're enough on their own.
    expect(setupProblems({ ...ready, work_scope: "", locations_first: "Seattle" }, [])).toEqual({});
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
    const roles = [{ name: "Eng", titles: "", company_kinds: "", rule_outs: "", min_pay: "", min_pay_unit: "" }];
    expect(setupProblems({ ...ready, roles }, [])).toEqual({
      "role-0": "Fill in at least one role — both what to call it and what to look for.",
    });
  });

  it("never holds the send over how a ranked place is written", () => {
    expect(setupProblems({ ...ready, locations_first: "Seattle, WA, Portland, Greater Seattle area" }, [])).toEqual({});
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

describe("answersToSend", () => {
  const role = { name: "Eng", titles: "Staff engineer", company_kinds: "", rule_outs: "", min_pay: "", min_pay_unit: "" };
  const answers = { ...emptyAnswers("Sam"), roles: [role] };

  it("keeps the unit where there is an amount for it to be the unit of", () => {
    const sent = answersToSend({ ...answers, roles: [{ ...role, min_pay: "$52", min_pay_unit: "hour" }] });
    expect(sent.roles[0]).toMatchObject({ min_pay: "$52", min_pay_unit: "hour" });
  });

  it("drops a unit left behind when the amount was cleared", () => {
    // A unit alone says nothing, and storing one leaves a search claiming an
    // hourly floor of nothing. The account panel keeps the same rule.
    const sent = answersToSend({ ...answers, roles: [{ ...role, min_pay: "  ", min_pay_unit: "hour" }] });
    expect(sent.roles[0].min_pay_unit).toBe("");
  });

  it("leaves every other answer as it was", () => {
    const full = { ...answers, work_scope: "Anywhere in the US", resume_text: "Engineer" };
    expect(answersToSend(full)).toEqual(full);
  });
});

describe("the pay pair's rule, at both doors", () => {
  // Setup and the account panel implement this separately, and have to: one
  // normalises a whole document with no prior state, the other diffs a change
  // set against a stored track. What must not drift is the answer, so this
  // asserts it rather than making them share code - the same trade as tying a
  // stored value to what the prompt prints rather than teaching each half the
  // other's format.
  const unitAlone = { min_pay: "   ", min_pay_unit: "hour" };

  it("stores no unit where no amount was given, whichever door it came through", () => {
    const role = { name: "Eng", titles: "Staff engineer", company_kinds: "", rule_outs: "", ...unitAlone };
    const fromSetup = answersToSend({ ...emptyAnswers("Sam"), roles: [role] });
    expect(fromSetup.roles[0].min_pay_unit).toBe("");

    const track = { ...trackList[0], pay_floor: "", pay_floor_unit: "" };
    const fromPanel = changedSearches([track], { [track.key]: { pay_floor: "   ", pay_floor_unit: "hour" } });
    expect(fromPanel[track.key]?.pay_floor_unit ?? "").toBe("");
  });
});
