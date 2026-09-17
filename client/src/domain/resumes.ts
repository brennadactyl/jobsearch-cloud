/**
 * Rules for the account panel's resume section that don't need React: which
 * stored documents are resumes, which search reads which, and the sentences
 * the section says about them. The server decides all of it; this reads what
 * `GET /api/documents` reports.
 */
import type { StoredResume, Track } from "../api/schema";
import { MAX_FILE_BYTES, isOlderWordFile, isReadableResume } from "./onboarding";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The filename part of a stored document path: "resumes/cv.pdf" is "cv.pdf". */
export function fileNameOf(path: string): string {
  return path.slice(path.indexOf("/") + 1);
}

/**
 * The resumes to list, oldest first so a new one lands at the bottom. The text
 * the server read from a Word file is stored beside it, but it is the same
 * resume, so only the .docx is shown.
 */
export function resumeRows(documents: readonly StoredResume[]): StoredResume[] {
  return documents
    .filter((d) => d.path.startsWith("resumes/") && !d.paired_with)
    .sort((a, b) => a.uploaded.localeCompare(b.uploaded) || a.path.localeCompare(b.path));
}

/** The searches that run, and so get a resume each: tabs another search fills read that search's. */
export function rootSearches(tracks: readonly Track[]): Track[] {
  return tracks.filter((t) => !t.fed_by).sort((a, b) => a.sort_order - b.sort_order);
}

/**
 * The searches that go on reading a resume from their next run. A search only
 * holding it until tonight isn't one: its next run reads the new file, so the
 * old one can be removed or replaced, as the server allows.
 */
export function keptBy(row: StoredResume): string[] {
  return [...new Set(row.used_by.filter((u) => u.state !== "until_next_run").map((u) => u.search))];
}

/** Why a resume can't be removed, naming the searches that still read it, or "" when it can. */
export function removeRefusal(row: StoredResume, labelOf: (search: string) => string): string {
  const searches = keptBy(row).map(labelOf);
  if (!searches.length) return "";
  const one = searches.length === 1;
  return `${joinNames(searches)} ${one ? "reads" : "read"} this resume, so it can't be removed. Choose another resume for ${one ? "that search" : "them"} below first.`;
}

/** The resume a search reads now, or from its next run once a saved change is waiting. */
export function currentResume(rows: readonly StoredResume[], search: string): string {
  const row = rows.find((r) => r.used_by.some((u) => u.search === search && u.state !== "until_next_run"));
  return row?.path ?? "";
}

/** A saved change still waiting for the search's next run: the resume it reads until then, and the one it reads after. */
export function waitingChange(rows: readonly StoredResume[], search: string): { until: string; from: string } | null {
  const holding = (state: string) =>
    rows.find((r) => r.used_by.some((u) => u.search === search && u.state === state))?.path ?? "";
  const until = holding("until_next_run");
  const from = holding("from_next_run");
  return until && from ? { until, from } : null;
}

/** "Uploaded Aug 28 · 612 words read", in the viewer's own calendar. */
export function resumeDetail(row: StoredResume, addedThisVisit: "uploaded" | "pasted" | null): string {
  const when = addedThisVisit ? "just now" : dayOf(row.uploaded);
  const verb = addedThisVisit === "pasted" ? "Added" : "Uploaded";
  return [`${verb} ${when}`, wordsRead(row)].filter(Boolean).join(" · ");
}

/** "612 words read", or "" where the server doesn't count them (a PDF). */
export function wordsRead(row: StoredResume): string {
  return typeof row.words === "number" ? `${row.words} words read` : "";
}

function dayOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "Eng - Gaming", "Eng - Gaming and Eng - AI", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Why a file can't be attached, before anything uploads, or null when it can.
 *
 * A name some search reads is refused too: storing over it would change what
 * that search reads without a Save. The same name on a file no search reads
 * just replaces it. The server allows both, so that an operator's import can
 * restore a backup over existing paths; this rule is the panel's.
 */
export function attachRefusal(
  name: string,
  bytes: number,
  storedPath: string,
  stored: readonly StoredResume[],
  labelOf: (search: string) => string,
): string | null {
  if (bytes > MAX_FILE_BYTES) {
    return `${name} wasn't attached: it's ${(bytes / 1024 / 1024).toFixed(1)} MB, and files can be up to 8 MB.`;
  }
  if (isOlderWordFile(name)) {
    return `${name} wasn't attached: it's the older Word format, which can't be read. Save it as .docx or PDF and attach that.`;
  }
  if (!isReadableResume(name)) {
    return `${name} wasn't attached: a search can read PDF, Word (.docx), .txt or .md files.`;
  }
  const same = (path: string | null | undefined) => path?.toLowerCase() === storedPath.toLowerCase();
  // A Word file and the text read from it are one resume, so either name counts.
  const readers = stored.filter((d) => same(d.path) || same(d.text_path) || same(d.paired_with)).flatMap(keptBy);
  const searches = [...new Set(readers)].map(labelOf);
  if (searches.length) {
    return `${joinNames(searches)} ${searches.length === 1 ? "reads" : "read"} a resume called ${fileNameOf(storedPath)}. Attach this one under a new name, then choose it and save.`;
  }
  return null;
}
