/**
 * The checks more than one route makes, defined once so no two routes enforce
 * slightly different versions of a rule. excluderFor takes the caller's
 * already-scoped `Db` (see ./db.js).
 */

import { json } from "./http.js";
import { excludedCompanyMatcher } from "./exclude.js";

export const DAY_MS = 86_400_000;

/** Today's UTC date as YYYY-MM-DD. */
export function today() {
  return new Date().toISOString().slice(0, 10);
}

/** The UTC date `days` days before now, as YYYY-MM-DD: the cutoff for "within the last N days". */
export function dateDaysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

// A caller-supplied local date, or "" if it isn't one. Strict on purpose - no
// coercion, no "2026-9-1": the callers are LLM runs, a value that isn't a date
// isn't a report of anything, and this value decides what date rows are
// stamped with and, on /api/delist, whether a lead is deleted.
export function isoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

// Where a person's search looks, as they typed it (docs/location-settings-plan.md):
// three comma-separated lists and a note, each one `meta` value. Nothing is
// split, matched or flagged here - the prompt reads each list as written, and
// the page builds its ranking from `priority_locations` itself - so the only
// checks are that each is text and fits. The caps keep a list to what a person
// types, since the prompt carries every one of them every night.
export const LOCATION_LIST_KEYS = ["search_locations", "excluded_locations", "priority_locations"];
export const LOCATION_LIST_MAX_CHARS = 4000;
export const LOCATION_NOTE_MAX_CHARS = 1000;

// A migrated account's ranking rules, kept as they were: `[{label, allOf?,
// anyOf?}]`, each array a list of strings a lead's location is matched against
// (docs/location-settings-plan.md, "The stand-in rules"). Only an operator
// writes them, restoring what an account had; a person's own list replaces them.
export const PRIORITY_RULES_MAX = 20;

/** The first thing wrong with a set of ranking rules, or "" for none. */
export function priorityRulesError(rules) {
  if (!Array.isArray(rules)) return "priority_rules must be a list";
  if (rules.length > PRIORITY_RULES_MAX) return `at most ${PRIORITY_RULES_MAX} ranking rules`;
  for (const [i, rule] of rules.entries()) {
    const at = `ranking rule ${i + 1}`;
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return `${at} must be an object`;
    const unknown = Object.keys(rule).find((k) => !["label", "allOf", "anyOf"].includes(k));
    if (unknown) return `${at} has an unknown field "${unknown}"`;
    if (typeof rule.label !== "string" || !rule.label.trim() || rule.label.length > 60) {
      return `${at} needs a label of 1 to 60 characters`;
    }
    let terms = 0;
    for (const key of ["allOf", "anyOf"]) {
      if (rule[key] === undefined) continue;
      const list = rule[key];
      if (!Array.isArray(list) || list.length > 20 || list.some((t) => typeof t !== "string" || !t || t.length > 80)) {
        return `${at}'s ${key} must be at most 20 strings of 1 to 80 characters`;
      }
      terms += list.length;
    }
    if (!terms) return `${at} needs at least one term in allOf or anyOf`;
  }
  return "";
}

/**
 * What is wrong with one location setting as sent, or "" for nothing. The
 * value is judged after trimming, which is how it is stored.
 * @param {string} key one of LOCATION_LIST_KEYS, or "location_note"
 * @param {unknown} value
 * @returns {string}
 */
export function locationSettingError(key, value) {
  if (typeof value !== "string") return `${key} must be text`;
  const max = key === "location_note" ? LOCATION_NOTE_MAX_CHARS : LOCATION_LIST_MAX_CHARS;
  if (value.trim().length > max) return `${key} is longer than ${max} characters`;
  return "";
}

// The refusal for a track key that isn't one of the caller's configured tracks.
// Worded identically on every route because it always means the same thing:
// the caller's idea of this search and the tracker's have drifted apart.
export function unknownTrack(key) {
  return json({ error: `unknown track "${key}" - not in the configured tracks` }, 404);
}

// unknownTrack for a batch whose rows each name a track. A row filed under a
// key that isn't a configured track is stored but invisible on the page (a
// row's tab comes from the track list), and nothing errors on either side.
//
// A fed track passes like any other: `fed_by` marks a tab, not a non-track, so
// it is a row in `tracks` and a branched run legitimately files into it.
//
// @param {{key: string}[]} tracks this user's configured tracks
// @param {{search: string}[]} rows the payload rows, as the caller sent them
// @returns {Response|null} the 404 naming every unknown key, or null if clean
export function unknownTrackResponse(tracks, rows) {
  const configured = new Set(tracks.map((t) => t.key));
  const unknown = [...new Set(rows.map((r) => r.search))].filter((k) => !configured.has(k));
  if (unknown.length === 0) return null;
  // Refuse the whole request; never drop just the drifted rows. The run reads
  // `added` as filed and treats those postings as ones it never has to find
  // again.
  const named = unknown.map((k) => `"${k}"`).join(", ");
  return json(
    { error: `unknown track${unknown.length > 1 ? "s" : ""} ${named} - not in the configured tracks` },
    404
  );
}

// The folders a document can live in, which are also the values of its `kind`.
// A fixed list because the runner materializes these paths onto a disk (see
// scripts/run-search.ps1), where an open-ended folder name is a directory
// created on someone's machine.
export const DOCUMENT_FOLDERS = ["docs", "resumes", "reference"];

// One known folder and one plain filename, no nesting, so `kind` is derivable
// from the path itself.
//
// This is a security boundary. The nightly runner writes each path to a file
// under its working directory, so this regexp alone is what refuses "..",
// absolute paths, backslashes, empty segments and a leading dot - a path that
// got past it would be a write-anywhere primitive for any session token. Don't
// loosen it, and don't split it into separate classification and traversal
// checks that could disagree. Filenames are narrow on purpose: a name needing
// more than word characters, spaces, dots and hyphens is likelier a mistake or
// an attack than a document.
//
// A filename of word characters, spaces, dots and hyphens that starts and ends
// with a word character. The ends matter because Windows silently strips a
// trailing space or dot when it creates a file: `x.md ` would materialize as
// `x.md`, and the hash-compared write-back would PUT to `x.md`, orphaning the
// original and editing a second copy.
const PLAIN_FILENAME = String.raw`\w(?:[\w .-]*\w)?`;
const DOCUMENT_PATH = new RegExp(`^(${DOCUMENT_FOLDERS.join("|")})/${PLAIN_FILENAME}$`);

// DOS device names are not filenames on Windows whatever extension follows:
// `CON`, `PRN.md` and `aux.txt` all resolve to a device, so the runner's write
// appears to succeed while `Test-Path` reports no file. Matched against the
// stem before the first dot, case-insensitively, the way Windows resolves it.
const DOS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** @param {unknown} path @returns {boolean} */
export function isDocumentPath(path) {
  if (typeof path !== "string" || !DOCUMENT_PATH.test(path)) return false;
  const name = path.slice(path.indexOf("/") + 1);
  return !DOS_DEVICE.test(name.split(".")[0]);
}

// A search reads its tracking doc, a resume or two and perhaps a reference file.
// The cap is there to refuse a list that is really "everything", not to fit
// normal searches.
export const TRACK_DOCUMENTS_MAX = 20;

/**
 * What is wrong with a track's `documents` list (migrations/0017), or null.
 * Checked on every write path to it, so the runner never asks R2 for a path
 * that could not name a document.
 *
 * Paths only, not whether each exists: a list can be written before its files
 * are uploaded, and GET /api/documents?search= reports what is missing at the
 * point a run needs it.
 * @param {unknown} list
 * @returns {string|null}
 */
export function trackDocumentsError(list) {
  if (!Array.isArray(list)) return "documents must be a list of document paths";
  if (list.length > TRACK_DOCUMENTS_MAX) return `at most ${TRACK_DOCUMENTS_MAX} documents for one search`;
  const bad = list.filter((p) => !isDocumentPath(p));
  if (bad.length) {
    return `not a document path: ${bad.map((p) => JSON.stringify(p)).join(", ")} - a path is ${DOCUMENT_FOLDERS.map((f) => `${f}/`).join(", ")} and a plain file name`;
  }
  return null;
}

// What an overnight run can read as it is. A Word resume is read through the
// text the server extracts beside it on upload, so a list names that text, never
// the .docx (routes/documents.js). The client's READABLE_RESUME_EXTENSIONS adds
// docx for the same reason: the person attaches the Word file.
export const READABLE_DOCUMENT_EXTENSIONS = ["txt", "md", "pdf"];

/** @param {string} path @returns {string} the lowercased extension, '' for none */
export function documentExtension(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Why a search reading this `documents` list would have no resume to read, or
 * null. Separate from trackDocumentsError because the callers exempt a list
 * that is unchanged from what is stored: posting config back as it was read
 * isn't a choice of documents, and refusing it would block every other edit
 * to a search set up before this rule.
 * @param {string[]} list already passed trackDocumentsError
 * @returns {string|null}
 */
export function unreadableDocumentsError(list) {
  if (list.length === 0) return "a search needs at least one document to read - its resume";
  const word = list.filter((p) => ["docx", "doc"].includes(documentExtension(p)));
  if (word.length) {
    return `a run can't read a Word file: ${word.map((p) => JSON.stringify(p)).join(", ")} - list the .txt read from it instead`;
  }
  if (!list.some((p) => READABLE_DOCUMENT_EXTENSIONS.includes(documentExtension(p)))) {
    return `none of these documents can be read by a run - a search needs at least one .${READABLE_DOCUMENT_EXTENSIONS.join(", .")} file`;
  }
  return null;
}

// Names the whole rule rather than the offending part: the callers are a
// PowerShell script and an LLM run, and what they may send is the useful answer.
export function badDocumentPath(path) {
  return json(
    {
      error:
        `invalid document path "${path}" - must be ` +
        `<${DOCUMENT_FOLDERS.join("|")}>/<filename>, one folder deep, ` +
        "with a filename of word characters, spaces, dots or hyphens, " +
        "starting and ending with a letter or digit, and not a reserved " +
        "Windows device name (CON, PRN, AUX, NUL, COM0-9, LPT0-9)",
    },
    400
  );
}

// Every write path that can introduce a company filters through this.
export async function excluderFor(db) {
  const { settings } = await db.getTracksAndSettings();
  return excludedCompanyMatcher(settings.excluded_companies);
}
