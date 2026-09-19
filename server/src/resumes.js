/**
 * Which searches read which resume (docs/account-settings-plan.md#your-resume).
 *
 * A search reads the files its `documents` list names, and its tracking doc
 * (`doc_file`). Only a search that runs has a list that is read: a tab another
 * search fills (`fed_by`) is served that search's list, so it is counted
 * through its root, never on its own (./tracks.js).
 *
 * A Word resume is read through the text extracted beside it on upload
 * (routes/documents.js), so the list names the .txt, and the .docx counts as
 * read wherever its text is. The pair is matched on the base name ignoring
 * case, since a run downloads onto a Windows disk where `Resume.txt` and
 * `resume.txt` are one file.
 *
 * Everything here works on paths and track rows already read, so a route asks
 * R2 and D1 once and every answer comes from the same snapshot.
 */

import { parseDocumentList } from "./db.js";
import { READABLE_DOCUMENT_EXTENSIONS } from "./validate.js";

/**
 * @typedef {Object} SearchRow a track as db.getResumeState reads it
 * @property {string} key
 * @property {string} label
 * @property {string} fed_by
 * @property {string} doc_file
 * @property {string} documents - stored JSON
 * @property {string} profile_stale_since
 * @property {string} resume_was
 * @property {string} role_search_line - '' until the search is written up
 */

/**
 * A path under resumes/, split into its file name, base name and lowercased
 * extension; null for anything else. Word pairing lives only under resumes/.
 * @param {string} path
 * @returns {{name: string, base: string, ext: string}|null}
 */
export function resumeParts(path) {
  if (!path.startsWith("resumes/")) return null;
  const name = path.slice("resumes/".length);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { name, base: name, ext: "" };
  return { name, base: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() };
}

/** @param {string} path @returns {string} the file name without its folder */
export function fileName(path) {
  return path.slice(path.indexOf("/") + 1);
}

/**
 * The stored resume files of one extension sharing this path's base name,
 * ignoring case.
 * @param {string[]} stored every path this person has
 * @param {string} path a resumes/ path
 * @param {string} ext lowercase, e.g. "txt"
 * @returns {string[]}
 */
export function samePairName(stored, path, ext) {
  const want = resumeParts(path)?.base.toLowerCase();
  if (want === undefined) return [];
  return stored.filter((p) => {
    const parts = resumeParts(p);
    return parts?.ext === ext && parts.base.toLowerCase() === want;
  });
}

/**
 * The file a search's list names for this resume: a Word file's extracted text,
 * or the path itself. Null for a Word file with no text stored.
 * @param {string[]} stored
 * @param {string} path
 * @returns {string|null}
 */
export function listedPathFor(stored, path) {
  if (resumeParts(path)?.ext !== "docx") return path;
  return samePairName(stored, path, "txt")[0] || null;
}

/**
 * Whether a search can be pointed at this stored resume: a .txt, .md or .pdf
 * of its own, or a Word file whose text is stored. The text read from a Word
 * file is offered as that Word file instead, so it isn't one on its own.
 * @param {string[]} stored
 * @param {string} path
 */
export function isChoosableResume(stored, path) {
  const parts = resumeParts(path);
  if (!parts) return false;
  if (parts.ext === "docx") return listedPathFor(stored, path) !== null;
  if (parts.ext === "txt" && samePairName(stored, path, "docx").length) return false;
  return READABLE_DOCUMENT_EXTENSIONS.includes(parts.ext);
}

/**
 * The searches that run, each with the tabs it fills, root first.
 * @param {SearchRow[]} rows
 * @returns {Array<SearchRow & {tabs: string[], list: string[]}>}
 */
export function runningSearches(rows) {
  return rows
    .filter((r) => !r.fed_by)
    .map((r) => ({
      ...r,
      tabs: [r.key, ...rows.filter((t) => t.fed_by === r.key).map((t) => t.key)],
      list: parseDocumentList(r.documents),
    }));
}

/**
 * The paths a search reads on behalf of this stored file: the file, and for a
 * Word file every text read from it.
 * @param {string[]} stored
 * @param {string} path
 * @returns {string[]}
 */
export function pathsReadFor(stored, path) {
  return resumeParts(path)?.ext === "docx" ? [path, ...samePairName(stored, path, "txt")] : [path];
}

/**
 * The searches that read this file today: its list names it, or it is the
 * search's tracking doc.
 * @param {SearchRow[]} rows
 * @param {string[]} stored
 * @param {string} path
 */
export function searchesReading(rows, stored, path) {
  const read = pathsReadFor(stored, path);
  return runningSearches(rows).filter((s) => read.includes(s.doc_file) || s.list.some((p) => read.includes(p)));
}

/**
 * What each search does with this resume, for the page's "Used by":
 *
 * - `reads`: its list names the file and its profile was written from it.
 * - `from_next_run`: its list names the file, and its profile is waiting to be
 *   rewritten from it on the next run - chosen since, or replaced in place.
 * - `until_next_run`: the file it was switched away from, which its profile
 *   still reflects until that run.
 *
 * @param {SearchRow[]} rows
 * @param {string[]} stored
 * @param {string} path
 * @returns {Array<{search: string, tabs: string[], state: string}>}
 */
export function resumeUsage(rows, stored, path) {
  const read = pathsReadFor(stored, path);
  const usage = [];
  for (const s of runningSearches(rows)) {
    const stale = !!s.profile_stale_since;
    if (s.list.some((p) => read.includes(p))) {
      usage.push({ search: s.key, tabs: s.tabs, state: stale ? "from_next_run" : "reads" });
    } else if (stale && read.includes(s.resume_was)) {
      usage.push({ search: s.key, tabs: s.tabs, state: "until_next_run" });
    }
  }
  return usage;
}

/**
 * Names as a sentence lists them: "A", "A and B", "A, B and C".
 * @param {string[]} names
 */
export function joinNames(names) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * A search's list with its resume replaced: every resumes/ entry gives way to
 * the chosen one, at the first one's place, and anything else it reads - a
 * reference file - stays where it was.
 * @param {string[]} list
 * @param {string} chosen the path the list should name
 * @returns {string[]}
 */
export function withResume(list, chosen) {
  const at = list.findIndex((p) => p.startsWith("resumes/"));
  const others = list.filter((p) => !p.startsWith("resumes/"));
  const place = at < 0 ? 0 : list.slice(0, at).filter((p) => !p.startsWith("resumes/")).length;
  return [...new Set([...others.slice(0, place), chosen, ...others.slice(place)])];
}
