/**
 * The checks more than one route makes, defined once so no two routes enforce
 * slightly different versions of a rule. excluderFor takes the caller's
 * already-scoped `Db` (see ./db.js).
 */

import { json } from "./http.js";
import { excludedCompanyMatcher } from "./exclude.js";

export function today() {
  return new Date().toISOString().slice(0, 10);
}

// A caller-supplied local date, or "" if it isn't one. Strict on purpose - no
// coercion, no "2026-9-1": the callers are LLM runs, a value that isn't a date
// isn't a report of anything, and this value decides what date rows are
// stamped with and, on /api/delist, whether a lead is deleted.
export function isoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
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
// The first and last characters must be word characters because Windows
// silently strips a trailing space or dot when it creates a file: `x.md `
// would materialize as `x.md`, and the hash-compared write-back would PUT to
// `x.md`, orphaning the original and editing a second copy.
const DOCUMENT_PATH = new RegExp(`^(${DOCUMENT_FOLDERS.join("|")})/\\w(?:[\\w .-]*\\w)?$`);

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
