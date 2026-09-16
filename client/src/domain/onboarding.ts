/**
 * Rules for invite signup and the setup form that don't need React: what an
 * unusable invite says, which resumes an overnight run can read, how a file is
 * named for storage, and what stops the form from sending.
 */
import type { IntakeAnswers, InviteReason, RoleAnswer } from "../api/schema";
import { parseLocations, tooManyLocations } from "./locations";

export const MIN_PASSWORD = 12;
export const MAX_NAME = 60;
/** The documents route refuses anything larger. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** What the sign-in card says when an invite can't make an account. */
export function inviteNotice(reason: InviteReason | string): string {
  switch (reason) {
    case "used":
      return "This invite link has already been used — ask for a new link, or sign in if you already have an account.";
    case "expired":
      return "This invite link has expired — ask for a new one.";
    default:
      return "This invite link isn't valid — ask for a new one, or sign in if you already have an account.";
  }
}

/** A headless run reads text and PDFs; a Word file, RTF or image needs its text pasted too. */
export const READABLE_RESUME_EXTENSIONS = ["txt", "md", "pdf"] as const;

export function isReadableResume(filename: string): boolean {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return filename.includes(".") && (READABLE_RESUME_EXTENSIONS as readonly string[]).includes(ext);
}

const DOS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * A filename the documents route accepts: word characters, spaces, dots and
 * hyphens, starting and ending with a letter or digit, and not a Windows device
 * name. Anything else becomes "-", so a name is never a reason to refuse a file.
 */
export function safeDocumentName(original: string): string {
  // Accents dropped first, so "résumé" is stored as "resume" rather than "r-sum".
  const filename = original.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot + 1).replace(/[^\w]/g, "") : "";
  let stem = (dot > 0 ? filename.slice(0, dot) : filename)
    .replace(/[^\w .-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  if (!stem) stem = "resume";
  if (DOS_DEVICE.test(stem)) stem = `${stem}-file`;
  return ext ? `${stem}.${ext}` : stem;
}

export function emptyRole(): RoleAnswer {
  return { name: "", titles: "", company_kinds: "", rule_outs: "", min_pay: "" };
}

export function emptyAnswers(displayName: string): IntakeAnswers {
  return {
    page_title: displayName ? `${displayName}'s Job Search` : "",
    pronouns: "",
    resume_text: "",
    resume_files: [],
    work_scope: "",
    location_limits: "",
    locations_first: "",
    priority_locations: [],
    roles: [emptyRole()],
    never_work_for: "",
    preferences: "",
  };
}

/** Messages keyed by where they sit on the form; empty means it can send. */
export type SetupProblems = Partial<Record<"attach" | "work_scope" | "locations" | `role-${number}`, string>>;

/**
 * What stops a send. `files` is every attachment the resume section lists, stored
 * or about to be.
 */
export function setupProblems(answers: IntakeAnswers, files: readonly string[]): SetupProblems {
  const found: SetupProblems = {};
  if (!answers.resume_text.trim()) {
    if (!files.length) found.attach = "Attach your resume or paste its text.";
    else if (!files.some(isReadableResume)) found.attach = "We can't read Word files overnight. Paste the text too.";
  }
  // The run builds the search's scope from this answer alone. Left empty, the
  // scope would fall back to whatever else mentions a place - an exclusion
  // among them - and the search would look in the one place ruled out.
  if (!answers.work_scope.trim()) {
    found.work_scope = "Say where you can work — it's what the search searches.";
  }
  const entries = parseLocations(answers.locations_first);
  const tooMany = tooManyLocations(entries);
  if (tooMany) found.locations = tooMany;
  else if (entries.some((e) => "problem" in e)) found.locations = "Fix the highlighted place before sending.";
  const usable = answers.roles.some((r) => r.name.trim() && r.titles.trim());
  if (!usable) {
    const i = Math.max(0, answers.roles.findIndex((r) => !r.name.trim() || !r.titles.trim()));
    found[`role-${i}`] = "Fill in at least one role — both what to call it and what to look for.";
  }
  return found;
}

/**
 * The run hasn't reported within the account's stale window since this attempt
 * started, so it may be waiting on the machine that runs searches.
 */
export function setupOverdue(sentAt: string, staleRunHours: number, now = Date.now()): boolean {
  const t = Date.parse(sentAt);
  return Number.isFinite(t) && now - t > (staleRunHours || 36) * 3_600_000;
}
